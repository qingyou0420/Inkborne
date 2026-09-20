/** SPDX-License-Identifier: AGPL-3.0-only */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadRun, ProjectConfigSchema, saveRun } from "@actalk/inkos-core";
import { registerAuthoringRoutes } from "./authoring-routes.js";

const mocks = vi.hoisted(() => ({
  revise: vi.fn<(...args: unknown[]) => Promise<string>>(),
  generate: vi.fn(async () => ({ artifactId: "generated", runId: "generation", status: "completed" })),
  artifact: vi.fn(async () => ({ meta: { artifactId: "reviewed", scope: "chapters:1-50" }, body: "已有章概要" })),
  report: vi.fn(async () => ({ reportId: "report-1" })),
}));

vi.mock("@actalk/inkos-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@actalk/inkos-core")>(),
  reviseWeave: mocks.revise,
  generateWeaveRange: mocks.generate,
  loadArtifact: mocks.artifact,
  loadReport: mocks.report,
}));

let root = "";
let app: Hono;
const bookId = "revision-book";
const request = {
  bookId, artifactId: "reviewed", reportId: "report-1", selectedIssueIds: ["issue-1"],
  startChapter: 1, endChapter: 50, requirements: "保留角色动机", reviseStructure: false,
};
function post(path: string, body: object) {
  return app.request(`/api/v1/authoring/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function seedRun(recoverable = true) {
  const now = new Date().toISOString();
  await saveRun({ projectRoot: root, bookId }, {
    runId: "revision-run", stage: "weave", operation: "revise", roleId: "weave.main", status: "partial", bookId,
    reportId: "report-1", error: "模型达到输出上限", modelSnapshot: {}, createdAt: now, updatedAt: now,
    checkpoint: {
      requestedStart: 1, requestedEnd: 50, completedChapters: [1, 2, 3, 4], missingChapters: [5, 6, 7, 8],
      requirements: "保留角色动机", producedScope: "chapters:1-50",
      ...(recoverable ? { revisionArtifactId: "reviewed", revisionIssueIds: ["issue-1"], revisionReuseStale: true } : {}),
    },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-weave-revision-"));
  vi.clearAllMocks();
  mocks.revise.mockResolvedValue("revised");
  const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
  app = new Hono();
  registerAuthoringRoutes(app, { root, loadProject: async () => project, saveRoles: async () => {} });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("starts a revision without waiting for the model and persists its polling checkpoint", async () => {
  const work = deferred<string>();
  mocks.revise.mockReturnValueOnce(work.promise);
  const response = await post("weave/revise", request);
  expect(response.status).toBe(200);
  const started = await response.json() as { runId: string; status: string };
  expect(started.status).toBe("running");
  expect(mocks.revise).toHaveBeenCalledWith(expect.objectContaining({ runId: started.runId, startChapter: 1, endChapter: 50 }));
  const run = await loadRun({ projectRoot: root, bookId }, started.runId);
  expect(run).toMatchObject({ operation: "revise", status: "running", reportId: "report-1", checkpoint: {
    revisionArtifactId: "reviewed", revisionIssueIds: ["issue-1"], requestedStart: 1, requestedEnd: 50, requirements: "保留角色动机",
  } });
  work.resolve("revised");
  await work.promise;
});

it("makes the actual background failure available to the existing run poller", async () => {
  const work = deferred<string>();
  mocks.revise.mockReturnValueOnce(work.promise);
  const started = await (await post("weave/revise", request)).json() as { runId: string };
  work.reject(new Error("模型达到输出上限：length"));
  await vi.waitFor(async () => {
    const result = await app.request(`/api/v1/authoring/runs/${started.runId}?bookId=${bookId}`);
    expect(await result.json()).toMatchObject({ status: "failed", error: "模型达到输出上限：length" });
  });
});

it("retains the synchronous result for callers that explicitly wait", async () => {
  const response = await post("weave/revise", { ...request, wait: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ artifactId: "revised" });
});

it("returns the real reason in Chinese instead of Unexpected server error when waiting fails", async () => {
  mocks.revise.mockRejectedValueOnce(new Error("model reached the output limit (length)"));
  const response = await post("weave/revise", { ...request, wait: true });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "织卷修订失败：model reached the output limit (length)" });
});

it("rejects an invalid revision range before starting work", async () => {
  const response = await post("weave/revise", { ...request, startChapter: 50, endChapter: 1 });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("修订章范围") });
  expect(mocks.revise).not.toHaveBeenCalled();
});

it("resumes revision from its saved review context rather than the generation path", async () => {
  await seedRun();
  const work = deferred<string>();
  mocks.revise.mockReturnValueOnce(work.promise);
  const response = await post("runs/revision-run/resume", { bookId });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ runId: "revision-run", status: "running", operation: "revise" });
  expect(mocks.revise).toHaveBeenCalledWith(expect.objectContaining({
    resumeRunId: "revision-run", artifactId: "reviewed", reportId: "report-1", selectedIssueIds: ["issue-1"],
    startChapter: 1, endChapter: 50, requirements: "保留角色动机", reuseStale: true, reviseStructure: false,
  }));
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(await loadRun({ projectRoot: root, bookId }, "revision-run")).toMatchObject({ status: "running", checkpoint: { completedChapters: [1, 2, 3, 4] } });
  work.resolve("revised");
  await work.promise;
});

it("leaves an old revision untouched and directs the author back to review", async () => {
  await seedRun(false);
  const before = await loadRun({ projectRoot: root, bookId }, "revision-run");
  const response = await post("runs/revision-run/resume", { bookId });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringMatching(/审查意见.*重新.*修订/) });
  expect(mocks.revise).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(await loadRun({ projectRoot: root, bookId }, "revision-run")).toEqual(before);
});

it("preserves a core partial checkpoint and its error if a later promise rejects", async () => {
  let runId = "";
  mocks.revise.mockImplementationOnce(async (input) => {
    runId = (input as { runId: string }).runId;
    const saved = await loadRun({ projectRoot: root, bookId }, runId);
    await saveRun({ projectRoot: root, bookId }, { ...saved!, status: "partial", error: "已保留前4章，后续输出截断", progressDone: 4 });
    throw new Error("secondary failure");
  });
  await post("weave/revise", { ...request, wait: true });
  expect(await loadRun({ projectRoot: root, bookId }, runId)).toMatchObject({ status: "partial", progressDone: 4, error: "已保留前4章，后续输出截断" });
});
