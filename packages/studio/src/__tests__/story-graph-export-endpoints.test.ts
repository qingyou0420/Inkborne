import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioServer } from "../api/server.js";
import { saveStoryGraph, StoryGraphSchema } from "@actalk/inkos-core";

const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);

describe("export endpoints", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "if-exp-"));
    const dir = join(root, "interactive-films", "p", "assets", "nodes");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "s.png"), PNG);
    await saveStoryGraph(root, "p", StoryGraphSchema.parse({
      schemaVersion: 1, projectId: "p", title: "T", variables: [],
      nodes: [
        { id: "s", type: "start", title: "开场", imageSlot: { prompt: "x", assetRef: "interactive-films/p/assets/nodes/s.png" }, choices: [{ id: "c", text: "go", targetNodeId: "e" }] },
        { id: "e", type: "ending", title: "结局", choices: [] },
      ],
      endings: [{ id: "g1", nodeId: "e", title: "好", type: "good" }],
    }));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("json export", async () => {
    const app = createStudioServer({} as never, root);
    const res = await app.request("/api/v1/projects/p/export/json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const body = await res.json() as { projectId: string };
    expect(body.projectId).toBe("p");
  });
  it("ink export", async () => {
    const app = createStudioServer({} as never, root);
    const res = await app.request("/api/v1/projects/p/export/ink");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("=== node_s ===");
  });
  it("html export inlines the image as base64 + is self-contained", async () => {
    const app = createStudioServer({} as never, root);
    const res = await app.request("/api/v1/projects/p/export/html");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toMatch(/data:image\/png;base64,/); // image inlined
  });
  it("exports projects with non-ascii ids without invalid response headers", async () => {
    const id = "测试项目";
    const dir = join(root, "interactive-films", id, "assets", "nodes");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "s.png"), PNG);
    await saveStoryGraph(root, id, StoryGraphSchema.parse({
      schemaVersion: 1, projectId: id, title: "中文项目", variables: [],
      nodes: [
        { id: "s", type: "start", title: "开场", imageSlot: { prompt: "x", assetRef: `interactive-films/${id}/assets/nodes/s.png` }, choices: [{ id: "c", text: "go", targetNodeId: "e" }] },
        { id: "e", type: "ending", title: "结局", choices: [] },
      ],
      endings: [{ id: "g1", nodeId: "e", title: "好", type: "good" }],
    }));

    const app = createStudioServer({} as never, root);
    for (const path of [
      `/api/v1/projects/${encodeURIComponent(id)}/export`,
      `/api/v1/projects/${encodeURIComponent(id)}/export/json`,
      `/api/v1/projects/${encodeURIComponent(id)}/export/ink`,
      `/api/v1/projects/${encodeURIComponent(id)}/export/html`,
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const disposition = res.headers.get("content-disposition");
      expect(disposition).toContain("attachment");
      expect(disposition).toContain("filename*=UTF-8''");
      expect(disposition).not.toMatch(/[\u0080-\uFFFF]/);
    }
  });
  it("404 no graph, 400 unsafe id", async () => {
    const app = createStudioServer({} as never, root);
    expect((await app.request("/api/v1/projects/nope/export/json")).status).toBe(404);
    expect((await app.request("/api/v1/projects/..%2Fx/export/html")).status).toBe(400);
  });
});
