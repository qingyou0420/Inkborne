/** SPDX-License-Identifier: AGPL-3.0-only */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { loadRun, ProjectConfigSchema, SessionAlreadyMigratedError } from "@actalk/inkos-core";
import { AUTHORING_ORPHAN_RUN_ERROR, registerAuthoringRoutes } from "./authoring-routes.js";

const mocks = vi.hoisted(() => ({
  askGenerate: vi.fn(async () => ({ artifactId: "ask-1", version: 1, runId: "ask-run", canon: { title: "书" } })),
  adoptAsk: vi.fn(async () => ({ bookId: "新书", created: true, artifactId: "canon-1" })),
  loadDraft: vi.fn(async () => ({ draftId: "d1", sessionId: "sess-1" })),
  migrateBookSession: vi.fn(async () => ({ sessionId: "sess-1", bookId: "新书" })),
}));

vi.mock("@actalk/inkos-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@actalk/inkos-core")>(),
  generateAskCanon: mocks.askGenerate,
  adoptAskCanon: mocks.adoptAsk,
  loadDraft: mocks.loadDraft,
  migrateBookSession: mocks.migrateBookSession,
}));

afterEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.adoptAsk.mockResolvedValue({ bookId: "新书", created: true, artifactId: "canon-1" });
  mocks.loadDraft.mockResolvedValue({ draftId: "d1", sessionId: "sess-1" });
  mocks.migrateBookSession.mockResolvedValue({ sessionId: "sess-1", bookId: "新书" });
});

async function appWithRoot() {
  const root = await mkdtemp(join(tmpdir(), "authoring-prf-"));
  const project = ProjectConfigSchema.parse({
    name: "test",
    version: "0.1.0",
    llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" },
  });
  const app = new Hono();
  const events: Array<{ event: string; data: unknown }> = [];
  registerAuthoringRoutes(app, {
    root,
    loadProject: async () => project,
    saveRoles: async () => {},
    broadcast: (event, data) => events.push({ event, data }),
  });
  return { app, root, events };
}

async function writeRunFile(root: string, bookId: string, run: Record<string, unknown>) {
  const dir = join(root, "books", bookId, "story", "workflow", "runs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${run.runId}.json`), `${JSON.stringify(run, null, 2)}\n`, "utf-8");
}

const staleRunning = {
  runId: "orphan-1",
  stage: "write",
  operation: "generate",
  roleId: "write.main",
  status: "running",
  bookId: "b",
  scope: "chapter:1",
  progressDone: 0,
  modelSnapshot: {},
  producedArtifactIds: [],
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
};

it("rewrites a pre-start running run to failed with a Studio restart reason", async () => {
  const { app, root, events } = await appWithRoot();
  await writeRunFile(root, "b", staleRunning);
  const response = await app.request("/api/v1/authoring/runs/orphan-1?bookId=b");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    runId: "orphan-1",
    status: "failed",
    error: AUTHORING_ORPHAN_RUN_ERROR,
  });
  expect(events.some((entry) => entry.event === "authoring:run" && (entry.data as { status?: string }).status === "failed")).toBe(true);
  await expect(loadRun({ projectRoot: root, bookId: "b" }, "orphan-1")).resolves.toMatchObject({
    status: "failed",
    error: AUTHORING_ORPHAN_RUN_ERROR,
  });
  await rm(root, { recursive: true, force: true });
});

it("rewrites orphan running runs when the workspace is read", async () => {
  const { app, root } = await appWithRoot();
  await writeRunFile(root, "b", { ...staleRunning, runId: "orphan-ws", status: "pausing" });
  const response = await app.request("/api/v1/authoring/workspace?bookId=b");
  expect(response.status).toBe(200);
  const body = await response.json() as { runs: Array<{ runId: string; status: string; error?: string }> };
  expect(body.runs.find((run) => run.runId === "orphan-ws")).toMatchObject({
    status: "failed",
    error: AUTHORING_ORPHAN_RUN_ERROR,
  });
  await rm(root, { recursive: true, force: true });
});

it("marks a dead running run cancelled without writing only a control file", async () => {
  const { app, root, events } = await appWithRoot();
  await writeRunFile(root, "b", { ...staleRunning, runId: "dead-1", updatedAt: new Date().toISOString() });
  const response = await app.request("/api/v1/authoring/runs/dead-1/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "b" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, action: "cancel", status: "cancelled" });
  await expect(loadRun({ projectRoot: root, bookId: "b" }, "dead-1")).resolves.toMatchObject({ status: "cancelled" });
  expect(events.some((entry) => entry.event === "authoring:run" && (entry.data as { status?: string }).status === "cancelled")).toBe(true);
  await rm(root, { recursive: true, force: true });
});

it("migrates the draft session and broadcasts book:created after adopt-and-create", async () => {
  const { app, root, events } = await appWithRoot();
  const response = await app.request("/api/v1/authoring/ask/adopt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draftId: "d1", artifactId: "canon-1" }),
  });
  expect(response.status).toBe(200);
  expect(mocks.migrateBookSession).toHaveBeenCalledWith(root, "sess-1", "新书");
  expect(events).toContainEqual({
    event: "book:created",
    data: { sessionId: "sess-1", bookId: "新书", canonCandidate: false, stage: "ask" },
  });
  await rm(root, { recursive: true, force: true });
});

it("ignores an already-migrated session when adopting a new book", async () => {
  mocks.migrateBookSession.mockRejectedValueOnce(new SessionAlreadyMigratedError("sess-1", "已有书"));
  const { app, root, events } = await appWithRoot();
  const response = await app.request("/api/v1/authoring/ask/adopt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draftId: "d1", artifactId: "canon-1" }),
  });
  expect(response.status).toBe(200);
  expect(events.some((entry) => entry.event === "book:created")).toBe(true);
  await rm(root, { recursive: true, force: true });
});

it("saves a running record before a wait=false core throw and then records failure", async () => {
  mocks.askGenerate.mockImplementation(() => {
    throw new Error("模型在首个 await 前就失败了");
  });
  const { app, root, events } = await appWithRoot();
  const response = await app.request("/api/v1/authoring/ask/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "b", conversation: "聊" }),
  });
  expect(response.status).toBe(200);
  const started = await response.json() as { runId: string; status: string };
  expect(started).toMatchObject({ runId: expect.any(String), status: "running" });
  await vi.waitFor(async () => {
    const run = await loadRun({ projectRoot: root, bookId: "b" }, started.runId);
    expect(run).toMatchObject({ status: "failed", error: "模型在首个 await 前就失败了" });
  });
  expect(events.some((entry) => entry.event === "authoring:run" && (entry.data as { status?: string }).status === "failed")).toBe(true);
  await rm(root, { recursive: true, force: true });
});
