/** SPDX-License-Identifier: AGPL-3.0-only */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectConfigSchema, loadRun } from "@actalk/inkos-core";
import { registerAuthoringRoutes } from "./authoring-routes.js";

const mocks = vi.hoisted(() => ({
  generateAsk: vi.fn(),
  saveRun: vi.fn(),
}));

vi.mock("@actalk/inkos-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actalk/inkos-core")>();
  return {
    ...actual,
    generateAskCanon: (...args: unknown[]) => mocks.generateAsk(...args),
    saveRun: (...args: unknown[]) => mocks.saveRun(...args),
  };
});

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
  mocks.saveRun.mockReset();
  mocks.generateAsk.mockReset();
});

async function boot(options?: { failFailedWrites?: boolean; hangAsk?: boolean }) {
  root = await mkdtemp(join(tmpdir(), "authoring-fail-"));
  const actual = await vi.importActual<typeof import("@actalk/inkos-core")>("@actalk/inkos-core");
  mocks.saveRun.mockImplementation(async (...args: unknown[]) => {
    const run = args[1] as { status?: string };
    if (options?.failFailedWrites && run?.status === "failed") {
      throw Object.assign(new Error("injected run persistence I/O failure"), { code: "EIO" });
    }
    return actual.saveRun(...(args as Parameters<typeof actual.saveRun>));
  });
  let rejectAsk: ((error: Error) => void) | undefined;
  if (options?.hangAsk) {
    mocks.generateAsk.mockImplementation(() => new Promise((_, reject) => { rejectAsk = reject; }));
  } else {
    mocks.generateAsk.mockImplementation(async () => {
      throw new Error("synthetic upstream model failure");
    });
  }
  const project = ProjectConfigSchema.parse({
    name: "test",
    version: "0.1.0",
    llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" },
  });
  const app = new Hono();
  registerAuthoringRoutes(app, { root, loadProject: async () => project, saveRoles: async () => {} });
  const response = await app.request("/api/v1/authoring/ask/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "test-book", conversation: "synthetic" }),
  });
  return {
    app,
    json: await response.json() as { runId?: string; status?: string },
    status: response.status,
    rejectAsk: (error: Error) => rejectAsk?.(error),
  };
}

async function getRun(app: Hono, runId: string) {
  return app.request(`/api/v1/authoring/runs/${runId}?bookId=test-book`);
}

it("marks a fake model failure failed without leaving the run completed", async () => {
  const { json, status } = await boot();
  expect(status).toBe(200);
  expect(json.status).toBe("running");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const run = await loadRun({ projectRoot: root, bookId: "test-book" }, json.runId!);
  expect(run?.status).toBe("failed");
  expect(run?.error).toContain("synthetic upstream model failure");
});

it("does not crash the process when the run JSON is truncated during failure", async () => {
  const { app, json, rejectAsk } = await boot({ hangAsk: true });
  await mkdir(join(root, "books", "test-book", "story", "workflow", "runs"), { recursive: true });
  await writeFile(join(root, "books", "test-book", "story", "workflow", "runs", `${json.runId}.json`), '{"runId":', "utf8");
  rejectAsk(new Error("synthetic upstream model failure"));
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(process.exitCode ?? 0).toBe(0);
  const response = await getRun(app, json.runId!);
  expect(response.status).toBe(200);
  const body = await response.json() as { status?: string; error?: string };
  expect(body.status).toBe("failed");
  expect(body.error).toBeTruthy();
});

it("does not pretend success when failed-run writes throw EIO", async () => {
  const { app, json } = await boot({ failFailedWrites: true });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const run = await loadRun({ projectRoot: root, bookId: "test-book" }, json.runId!);
  expect(run?.status).not.toBe("completed");
  const response = await getRun(app, json.runId!);
  expect(response.status).toBe(200);
  const body = await response.json() as { status?: string; error?: string; persistError?: string };
  expect(body.status).toBe("failed");
  expect(body.error).toContain("synthetic upstream model failure");
  const workspace = await app.request("/api/v1/authoring/workspace?bookId=test-book");
  expect(workspace.status).toBe(200);
  const listed = await workspace.json() as { runs?: Array<{ runId: string; status: string }> };
  expect(listed.runs?.find((item) => item.runId === json.runId)?.status).toBe("failed");
});
