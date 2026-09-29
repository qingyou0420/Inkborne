/** SPDX-License-Identifier: AGPL-3.0-only */
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { ProjectConfigSchema } from "@actalk/inkos-core";
import { registerAuthoringRoutes } from "./authoring-routes.js";

const mocks = vi.hoisted(() => ({
  revise: vi.fn(async () => ({ artifactId: "new-candidate", version: 2 })),
  generate: vi.fn(async () => ({ artifactId: "generated-candidate", version: 3 })),
}));
vi.mock("@actalk/inkos-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@actalk/inkos-core")>(),
  reviseAskCanon: mocks.revise,
  generateAskCanon: mocks.generate,
}));

it("passes the complete author conversation to revision together with selected issues and requirements", async () => {
  const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
  const app = new Hono();
  registerAuthoringRoutes(app, { root: "D:/isolated-canon-test", loadProject: async () => project, saveRoles: async () => {} });
  const conversation = "user: 早期讨论。".repeat(1500) + "\nuser: 最终确认采用双主角有限视角。";
  const response = await app.request("/api/v1/authoring/ask/revise", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draftId: "draft-test", artifactId: "candidate", reportId: "report", selectedIssueIds: ["missing-voice"], conversation, requirements: "保留尚未决定的结局。" }),
  });
  expect(response.status).toBe(200);
  expect(mocks.revise).toHaveBeenCalledWith(expect.objectContaining({
    conversation, extraRequirement: "保留尚未决定的结局。", selectedIssueIds: ["missing-voice"],
  }));
});

it("marks regeneration form requirements as explicit author input for persistence", async () => {
  const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
  const app = new Hono();
  registerAuthoringRoutes(app, { root: "D:/isolated-canon-test", loadProject: async () => project, saveRoles: async () => {} });
  const response = await app.request("/api/v1/authoring/ask/generate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "book-test", conversation: "", requirements: "将阿衡改名为阿岑，其余不变。\n当前稿审查意见：需要删除配角。", authorRequirement: "将阿衡改名为阿岑，其余不变。" }),
  });
  expect(response.status).toBe(200);
  expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({
    conversation: "", requirements: "将阿衡改名为阿岑，其余不变。\n当前稿审查意见：需要删除配角。", authorRequirement: "将阿衡改名为阿岑，其余不变。",
  }));
});

it("does not label mixed review requirements as persistent author input for older generation callers", async () => {
  const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
  const app = new Hono();
  registerAuthoringRoutes(app, { root: "D:/isolated-canon-test", loadProject: async () => project, saveRoles: async () => {} });
  const response = await app.request("/api/v1/authoring/ask/generate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "book-test", conversation: "", requirements: "当前稿审查意见：删除配角。" }),
  });
  expect(response.status).toBe(200);
  expect(mocks.generate).toHaveBeenLastCalledWith(expect.objectContaining({ requirements: "当前稿审查意见：删除配角。", authorRequirement: undefined }));
});

it("prefers explicit author text over a mixed legacy requirement on revision", async () => {
  const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
  const app = new Hono();
  registerAuthoringRoutes(app, { root: "D:/isolated-canon-test", loadProject: async () => project, saveRoles: async () => {} });
  const response = await app.request("/api/v1/authoring/ask/revise", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId: "book-test", artifactId: "candidate", reportId: "report", selectedIssueIds: ["name"],
      requirements: "当前稿审查意见：删除配角。", extraRequirement: "旧内容", authorRequirement: "只改名，其余不变。" }),
  });
  expect(response.status).toBe(200);
  expect(mocks.revise).toHaveBeenLastCalledWith(expect.objectContaining({ extraRequirement: "只改名，其余不变。" }));
});
