import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { ProjectConfigSchema } from "@actalk/inkos-core";
import { registerAuthoringRoutes } from "./authoring-routes.js";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

it("keeps workspace GET read-only and makes the existing canon actionable with an explicit prepare request", async () => {
  root = await mkdtemp(join(tmpdir(), "authoring-prepare-api-"));
  const bookDir = join(root, "books", "existing");
  await mkdir(join(bookDir, "story"), { recursive: true });
  const originalBook = JSON.stringify({ id: "existing", title: "旧作", genre: "古风", targetChapters: 260, chapterWordCount: 5000 });
  await writeFile(join(bookDir, "book.json"), originalBook);
  await writeFile(join(bookDir, "story", "author_intent.md"), "作者已确认的故事方向");
  const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
  const app = new Hono();
  registerAuthoringRoutes(app, { root, loadProject: async () => project, saveRoles: async () => {} });

  const before = await (await app.request("/api/v1/authoring/workspace?bookId=existing")).json();
  expect(before.canonSource).toBe("compat");
  expect(before.candidateAsk).toBeUndefined();
  await expect(access(join(bookDir, "story", "workflow"))).rejects.toThrow();
  const response = await app.request("/api/v1/authoring/ask/prepare", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookId: "existing" }),
  });
  expect(response.status).toBe(200);
  const prepared = await response.json();
  expect(prepared.meta).toMatchObject({ stage: "ask", scope: "canon", status: "candidate" });
  expect(prepared.body).toContain("targetChapters: 260");
  const after = await (await app.request("/api/v1/authoring/workspace?bookId=existing")).json();
  expect(after.candidateAsk.artifactId).toBe(prepared.meta.artifactId);
  expect(after.adoptedAskId).toBeUndefined();
  expect(await readFile(join(bookDir, "book.json"), "utf-8")).toBe(originalBook);
  await expect(access(join(bookDir, "story", "canon.md"))).rejects.toThrow();
});
