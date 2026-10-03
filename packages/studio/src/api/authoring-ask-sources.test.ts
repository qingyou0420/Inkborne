/** SPDX-License-Identifier: AGPL-3.0-only */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { ProjectConfigSchema } from "@actalk/inkos-core";
import { registerAuthoringRoutes } from "./authoring-routes.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ask-source-api-")); roots.push(root);
  const app = new Hono();
  const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
  registerAuthoringRoutes(app, { root, loadProject: async () => project, saveRoles: async () => {} });
  return { app, root };
}
it("uploads into the Ask draft, lists complete coverage, and removes only the reference", async () => {
  const { app, root } = await setup();
  const body = new FormData(); body.append("draftId", "draft"); body.append("file", new File(["开头\n结尾依据"], "旧作.txt", { type: "text/plain" }));
  const response = await app.request("/api/v1/authoring/ask/sources", { method: "POST", body });
  expect(response.status).toBe(200);
  const { source } = await response.json() as { source: { id: string; originalPath: string; coverage: string } };
  expect(source.coverage).toBe("complete");
  expect(await readFile(join(root, source.originalPath), "utf-8")).toContain("结尾依据");
  const listed = await app.request("/api/v1/authoring/ask/sources?draftId=draft");
  expect((await listed.json() as { sources: unknown[] }).sources).toHaveLength(1);
  expect((await app.request(`/api/v1/authoring/ask/sources/${source.id}?draftId=draft`, { method: "DELETE" })).status).toBe(200);
  expect(await readFile(join(root, source.originalPath), "utf-8")).toContain("结尾依据");
  await expect(readdir(join(root, "books"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("returns the actual coverage limit and preserved original path in an oversized import error", async () => {
  const { app } = await setup();
  const body = new FormData(); body.append("draftId", "draft"); body.append("file", new File(["x".repeat(120001)], "long.txt"));
  const response = await app.request("/api/v1/authoring/ask/sources", { method: "POST", body });
  expect(response.status).toBe(400);
  expect((await response.json() as { error: string }).error).toMatch(/120,001.*120,000.*未截取开头.*原始文件已保留/s);
});

it("lists a damaged extracted copy as invalid while preserving its removal action and original", async () => {
  const { app, root } = await setup();
  const body = new FormData(); body.append("draftId", "draft"); body.append("file", new File(["开篇\n结尾事实"], "资料.txt"));
  const uploaded = await app.request("/api/v1/authoring/ask/sources", { method: "POST", body });
  const { source } = await uploaded.json() as { source: { id: string; textPath: string; originalPath: string } };
  await writeFile(join(root, source.textPath), "");
  const response = await app.request("/api/v1/authoring/ask/sources?draftId=draft");
  expect(response.status).toBe(200);
  expect((await response.json() as { sources: unknown[] }).sources[0]).toMatchObject({ id: source.id, coverage: "invalid", error: expect.stringContaining("重新导入") });
  expect((await app.request(`/api/v1/authoring/ask/sources/${source.id}?draftId=draft`, { method: "DELETE" })).status).toBe(200);
  expect(await readFile(join(root, source.originalPath), "utf-8")).toBe("开篇\n结尾事实");
});
