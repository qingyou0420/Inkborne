/** SPDX-License-Identifier: AGPL-3.0-only */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import {
  ProjectConfigSchema,
  createLightweightBook,
  loadManifest,
  saveImpactReport,
  saveManifest,
  serializeCanon,
} from "@actalk/inkos-core";
import { registerAuthoringRoutes } from "./authoring-routes.js";

const mocks = vi.hoisted(() => ({
  triage: vi.fn(async () => ({ impactId: "imp-recompute", unchanged: false })),
  adoptAsk: vi.fn(async () => ({ bookId: "b", created: false, artifactId: "ask-v2", impactPending: true })),
}));

vi.mock("@actalk/inkos-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@actalk/inkos-core")>(),
  triageCanonImpact: mocks.triage,
  adoptAskCanon: mocks.adoptAsk,
}));

afterEach(() => {
  mocks.triage.mockClear();
  mocks.adoptAsk.mockReset();
  mocks.adoptAsk.mockResolvedValue({ bookId: "b", created: false, artifactId: "ask-v2", impactPending: true });
});

async function appWithRoot() {
  const root = await mkdtemp(join(tmpdir(), "authoring-impact-api-"));
  const project = ProjectConfigSchema.parse({
    name: "test",
    version: "0.1.0",
    llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" },
  });
  const app = new Hono();
  registerAuthoringRoutes(app, {
    root,
    loadProject: async () => project,
    saveRoles: async () => {},
  });
  return { app, root };
}

const sampleImpact = {
  impactId: "imp-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  from: { artifactId: "ask-v1", version: 1 },
  to: { artifactId: "ask-v2", version: 2 },
  changes: [{ field: "protagonist", label: "主角与核心欲望", before: "复仇", after: "赎罪" }],
  globals: [],
  items: [{
    key: "ground:shen-yan",
    stage: "ground" as const,
    targetId: "shen-yan",
    label: "沈砚",
    verdict: "affected" as const,
    fields: ["protagonist"],
    reason: "欲望改了",
    method: "llm" as const,
    status: "open" as const,
  }],
  unmapped: [],
  method: "llm" as const,
};

it("exposes the current impact summary on workspace for authoring books", async () => {
  const { app, root } = await appWithRoot();
  const created = await createLightweightBook({
    projectRoot: root,
    canon: {
      title: "醉词",
      oneLine: "酒楼",
      proposition: "",
      protagonist: "沈砚",
      conflict: "",
      voice: "",
      boundaries: "",
      direction: "",
      openQuestions: [],
      targetChapters: 12,
      chapterWordCount: 2000,
    },
  });
  const store = { projectRoot: root, bookId: created.bookId };
  await saveImpactReport(store, sampleImpact);
  const manifest = await loadManifest(store);
  await saveManifest(store, {
    ...manifest,
    watches: [{
      id: "w1",
      stage: "ground",
      sourceKind: "canon",
      sourceId: "ask-v2",
      label: "需核对",
      impactReportId: "imp-1",
      acknowledged: false,
    }],
  });
  const response = await app.request(`/api/v1/authoring/workspace?bookId=${created.bookId}`);
  expect(response.status).toBe(200);
  const body = await response.json() as { authoringBook: boolean; impact?: { impactId: string; openCount: { ground: number } } };
  expect(body.authoringBook).toBe(true);
  expect(body.impact).toMatchObject({ impactId: "imp-1", openCount: { ground: 1, weave: 0 } });
  await rm(root, { recursive: true, force: true });
});

it("reads an impact report by id", async () => {
  const { app, root } = await appWithRoot();
  const created = await createLightweightBook({
    projectRoot: root,
    canon: {
      title: "醉词",
      oneLine: "酒楼",
      proposition: "",
      protagonist: "沈砚",
      conflict: "",
      voice: "",
      boundaries: "",
      direction: "",
      openQuestions: [],
      targetChapters: 12,
    },
  });
  await saveImpactReport({ projectRoot: root, bookId: created.bookId }, sampleImpact);
  const response = await app.request(`/api/v1/authoring/impact/imp-1?bookId=${created.bookId}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ impactId: "imp-1", method: "llm" });
  await rm(root, { recursive: true, force: true });
});

it("resolves open impact items and returns the updated summary", async () => {
  const { app, root } = await appWithRoot();
  const created = await createLightweightBook({
    projectRoot: root,
    canon: {
      title: "醉词",
      oneLine: "酒楼",
      proposition: "",
      protagonist: "沈砚",
      conflict: "",
      voice: "",
      boundaries: "",
      direction: "",
      openQuestions: [],
      targetChapters: 12,
    },
  });
  const store = { projectRoot: root, bookId: created.bookId };
  await saveImpactReport(store, sampleImpact);
  const response = await app.request("/api/v1/authoring/impact/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: created.bookId, keys: ["ground:shen-yan"], as: "reviewed" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    impact: { impactId: "imp-1", openCount: { ground: 0, weave: 0 } },
  });
  await rm(root, { recursive: true, force: true });
});

it("starts a background recompute run", async () => {
  const { app, root } = await appWithRoot();
  const created = await createLightweightBook({
    projectRoot: root,
    canon: {
      title: "醉词",
      oneLine: "酒楼",
      proposition: "",
      protagonist: "沈砚",
      conflict: "",
      voice: "",
      boundaries: "",
      direction: "",
      openQuestions: [],
      targetChapters: 12,
    },
  });
  const response = await app.request("/api/v1/authoring/impact/recompute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: created.bookId }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "running", runId: expect.any(String) });
  await vi.waitFor(() => expect(mocks.triage).toHaveBeenCalled());
  await rm(root, { recursive: true, force: true });
});

it("starts impact triage after adopt when content actually changed", async () => {
  const { app, root } = await appWithRoot();
  await mkdir(join(root, "books", "b", "story"), { recursive: true });
  await writeFile(join(root, "books", "b", "book.json"), `${JSON.stringify({ id: "b", title: "书" }, null, 2)}\n`);
  await writeFile(join(root, "books", "b", "story", "canon.md"), serializeCanon({
    title: "书",
    oneLine: "一句话",
    proposition: "",
    protagonist: "",
    conflict: "",
    voice: "",
    boundaries: "",
    direction: "",
    openQuestions: [],
    targetChapters: 12,
    chapterWordCount: 2000,
  }));
  const response = await app.request("/api/v1/authoring/ask/adopt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "b", artifactId: "ask-v2" }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { impactRunId?: string };
  expect(body.impactRunId).toEqual(expect.any(String));
  await vi.waitFor(() => expect(mocks.triage).toHaveBeenCalled());
  await rm(root, { recursive: true, force: true });
});

it("does not start triage when adopt reports no impact", async () => {
  mocks.adoptAsk.mockResolvedValueOnce({ bookId: "b", created: false, artifactId: "ask-v2", impactPending: false });
  const { app, root } = await appWithRoot();
  const response = await app.request("/api/v1/authoring/ask/adopt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "b", artifactId: "ask-v2" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).not.toHaveProperty("impactRunId", expect.any(String));
  expect(mocks.triage).not.toHaveBeenCalled();
  await rm(root, { recursive: true, force: true });
});
