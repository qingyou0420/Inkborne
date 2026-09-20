/** SPDX-License-Identifier: AGPL-3.0-only */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectConfigSchema } from "@actalk/inkos-core";
import { registerAuthoringRoutes } from "./authoring-routes.js";

const mocks = vi.hoisted(() => ({
  askGenerate: vi.fn(async () => ({ artifactId: "ask-1", version: 1, runId: "ask-run", canon: { title: "书" } })),
  askReview: vi.fn(async () => ({ reportId: "r1", issues: [] })),
  askRevise: vi.fn(async () => ({ artifactId: "ask-2", version: 2, runId: "ask-revise", canon: { title: "书" } })),
  groundCatalog: vi.fn(async () => ({ categories: [], entries: [] })),
  groundGenerate: vi.fn(async () => ({ generated: ["shen"], failed: [], runId: "g-run" })),
  groundReview: vi.fn(async () => ({ reportId: "gr", issues: [] })),
  groundRevise: vi.fn(async () => ({ artifactIds: ["g2"], entryIds: ["shen"] })),
  writeGenerate: vi.fn(async () => ({ artifactId: "w1", runId: "w-run", body: "正文" })),
  writeReview: vi.fn(async () => ({ reportId: "wr", issues: [] })),
  writeRevise: vi.fn(async () => ({ artifactId: "w2", version: 2, runId: "w-rev" })),
  writeAdopt: vi.fn(async () => ({ adopted: true, settled: false })),
  writeSettle: vi.fn(async () => ({ settled: true, runId: "settle" })),
  weaveStructure: vi.fn(async () => ({ artifactId: "s1", runId: "ws", volumes: [], bookOutline: "" })),
  weaveReview: vi.fn(async () => ({ reportId: "wvr", issues: [] })),
}));

vi.mock("@actalk/inkos-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@actalk/inkos-core")>(),
  generateAskCanon: mocks.askGenerate,
  reviewAskCanon: mocks.askReview,
  reviseAskCanon: mocks.askRevise,
  proposeSettingsCatalog: mocks.groundCatalog,
  generateGroundEntries: mocks.groundGenerate,
  reviewGroundEntries: mocks.groundReview,
  reviseGroundEntry: mocks.groundRevise,
  generateChapterDraft: mocks.writeGenerate,
  reviewChapterDraft: mocks.writeReview,
  reviseChapterDraft: mocks.writeRevise,
  adoptChapterDraft: mocks.writeAdopt,
  settleAdoptedChapter: mocks.writeSettle,
  generateWeaveStructure: mocks.weaveStructure,
  reviewWeave: mocks.weaveReview,
}));

const hanging = () => new Promise(() => {});

afterEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

async function appWithRoot() {
  const root = await mkdtemp(join(tmpdir(), "authoring-bg-"));
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

it.each([
  ["/api/v1/authoring/ask/generate", { bookId: "b", conversation: "聊" }, mocks.askGenerate],
  ["/api/v1/authoring/ask/review", { bookId: "b", artifactId: "a" }, mocks.askReview],
  ["/api/v1/authoring/ask/revise", { bookId: "b", artifactId: "a", reportId: "r", selectedIssueIds: ["i"] }, mocks.askRevise],
  ["/api/v1/authoring/ground/catalog", { bookId: "b" }, mocks.groundCatalog],
  ["/api/v1/authoring/ground/generate", { bookId: "b" }, mocks.groundGenerate],
  ["/api/v1/authoring/ground/review", { bookId: "b", entryIds: ["shen"] }, mocks.groundReview],
  ["/api/v1/authoring/ground/revise", { bookId: "b", entryIds: ["shen"], reportId: "gr", selectedIssueIds: ["i"] }, mocks.groundRevise],
  ["/api/v1/authoring/write/generate", { bookId: "b", chapterNumber: 1 }, mocks.writeGenerate],
  ["/api/v1/authoring/write/review", { bookId: "b", artifactId: "w" }, mocks.writeReview],
  ["/api/v1/authoring/write/revise", { bookId: "b", artifactId: "w", reportId: "r", selectedIssueIds: ["i"] }, mocks.writeRevise],
  ["/api/v1/authoring/weave/structure", { bookId: "b" }, mocks.weaveStructure],
  ["/api/v1/authoring/weave/review", { bookId: "b", artifactId: "w", coverage: "全书" }, mocks.weaveReview],
])("wait=false returns runId for %s", async (path, body, mock) => {
  mock.mockImplementation(hanging);
  const { app, root, events } = await appWithRoot();
  const response = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ runId: expect.any(String), status: "running" });
  expect(events.some((entry) => entry.event === "authoring:run")).toBe(true);
  await rm(root, { recursive: true, force: true });
});

it("write adopt starts a background settle run", async () => {
  mocks.writeSettle.mockImplementation(hanging);
  const { app, root } = await appWithRoot();
  const response = await app.request("/api/v1/authoring/write/adopt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "b", artifactId: "w1" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ adopted: true, settled: false, status: "running", runId: expect.any(String) });
  expect(mocks.writeAdopt).toHaveBeenCalledWith(expect.objectContaining({ deferSettle: true }));
  await rm(root, { recursive: true, force: true });
});

it("write settle retry returns a running runId", async () => {
  mocks.writeSettle.mockImplementation(hanging);
  const { app, root } = await appWithRoot();
  const response = await app.request("/api/v1/authoring/write/settle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "b", artifactId: "w1" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ runId: expect.any(String), status: "running", operation: "settle" });
  await rm(root, { recursive: true, force: true });
});
