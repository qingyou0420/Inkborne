import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { access, mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioServer } from "../api/server.js";
import { saveStoryGraph, loadStoryGraph, StoryGraphSchema } from "@actalk/inkos-core";

const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);

describe("POST /api/v1/projects/:id/nodes/:nodeId/image", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "if-imgep-"));
    await mkdir(join(root, "interactive-films", "p"), { recursive: true });
    await saveStoryGraph(root, "p", StoryGraphSchema.parse({ schemaVersion: 1, projectId: "p", title: "T", variables: [], nodes: [{ id: "s", type: "start", sceneDesc: "宫门前", choices: [] }], endings: [] }));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("returns 410 without generating an image or altering the historical graph", async () => {
    const graphPath = join(root, "interactive-films", "p", "story-graph.json");
    const original = await readFile(graphPath, "utf-8");
    const generateImage = vi.fn(async () => ({ buffer: PNG, extension: "png" }));
    const app = createStudioServer({} as never, root, { nodeImageGenerator: { generateImage } });
    const res = await app.request("/api/v1/projects/p/nodes/s/image", { method: "POST" });
    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "FEATURE_RETIRED" } });
    expect(generateImage).not.toHaveBeenCalled();
    expect(await readFile(graphPath, "utf-8")).toBe(original);
    await expect(access(join(root, "interactive-films", "p", "assets"))).rejects.toMatchObject({ code: "ENOENT" });
    const history = await app.request("/api/v1/projects/p/story-graph");
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toEqual(JSON.parse(original));
  });

  it("rejects missing-node and stale-path writes before resolving or modifying projects", async () => {
    const original = await loadStoryGraph(root, "p");
    const generateImage = vi.fn(async () => ({ buffer: PNG, extension: "png" }));
    const app = createStudioServer({} as never, root, { nodeImageGenerator: { generateImage } });
    expect((await app.request("/api/v1/projects/p/nodes/ghost/image", { method: "POST" })).status).toBe(410);
    expect((await app.request("/api/v1/projects/..%2Fx/nodes/s/image", { method: "POST" })).status).toBe(410);
    expect(generateImage).not.toHaveBeenCalled();
    expect(await loadStoryGraph(root, "p")).toEqual(original);
  });
});
