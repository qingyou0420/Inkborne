/** SPDX-License-Identifier: AGPL-3.0-only */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { ProjectConfigSchema } from "@actalk/inkos-core";
import { registerAuthoringRoutes } from "./authoring-routes.js";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(async () => ({ beats: [], runId: "run-1", artifactId: "a1", status: "completed" })),
  structure: vi.fn(async () => ({ artifactId: "s1", runId: "run-s", volumes: [], bookOutline: "" })),
}));
vi.mock("@actalk/inkos-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@actalk/inkos-core")>(),
  generateWeaveRange: mocks.generate,
  generateWeaveStructure: mocks.structure,
}));

it("does not treat the requested chapter range as the book target", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-weave-"));
  const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
  const app = new Hono();
  registerAuthoringRoutes(app, { root, loadProject: async () => project, saveRoles: async () => {} });
  const response = await app.request("/api/v1/authoring/weave/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "book-test", startChapter: 1, endChapter: 10, targetChapters: 10, wait: true }),
  });
  expect(response.status).toBe(200);
  expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({
    startChapter: 1,
    endChapter: 10,
    targetChapters: undefined,
  }));
  await rm(root, { recursive: true, force: true });
});

it("rejects chapter generation before the volume structure is adopted", async () => {
  mocks.generate.mockClear();
  const root = await mkdtemp(join(tmpdir(), "studio-weave-gate-"));
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "books", "book-new", "story"), { recursive: true });
  await writeFile(join(root, "books", "book-new", "book.json"), JSON.stringify({ id: "book-new", title: "新书", targetChapters: 8 }), "utf8");
  await writeFile(join(root, "books", "book-new", "story", "canon.md"), "# 正典\n", "utf8");
  const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
  const app = new Hono();
  registerAuthoringRoutes(app, { root, loadProject: async () => project, saveRoles: async () => {} });
  const response = await app.request("/api/v1/authoring/weave/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "book-new", startChapter: 1, endChapter: 4, wait: true }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.stringMatching(/分卷结构/) });
  expect(mocks.generate).not.toHaveBeenCalled();
  await rm(root, { recursive: true, force: true });
});

it("exposes a dedicated volume-structure endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-weave-struct-"));
  const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
  const app = new Hono();
  registerAuthoringRoutes(app, { root, loadProject: async () => project, saveRoles: async () => {} });
  const response = await app.request("/api/v1/authoring/weave/structure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "book-test" }),
  });
  expect(response.status).toBe(200);
  expect(mocks.structure).toHaveBeenCalled();
  await rm(root, { recursive: true, force: true });
});
