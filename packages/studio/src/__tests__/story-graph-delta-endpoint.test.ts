import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioServer } from "../api/server.js";
import { applyGraphDelta, loadAuthoringState, loadStoryGraph } from "@actalk/inkos-core";

describe("POST /api/v1/projects/:id/story-graph/delta", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "if-delta-"));
    await mkdir(join(root, "interactive-films", "p"), { recursive: true });
    await applyGraphDelta({ projectRoot: root, projectId: "p", delta: { worldAnchor: { storyCore: "历史故事" } } });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("returns 410 and preserves the graph, revision and snapshots", async () => {
    const graphPath = join(root, "interactive-films", "p", "story-graph.json");
    const statePath = join(root, "interactive-films", "p", "authoring-state.json");
    const snapshotsPath = join(root, "interactive-films", "p", "snapshots");
    const original = await readFile(graphPath, "utf-8");
    const state = await readFile(statePath, "utf-8");
    const snapshots = await readdir(snapshotsPath);
    const app = createStudioServer({} as never, root);
    const res = await app.request("/api/v1/projects/p/story-graph/delta", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta: { worldAnchor: { storyCore: "X" } } }),
    });
    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "FEATURE_RETIRED" } });
    expect(await readFile(graphPath, "utf-8")).toBe(original);
    expect(await readFile(statePath, "utf-8")).toBe(state);
    expect(await readdir(snapshotsPath)).toEqual(snapshots);
    expect((await loadAuthoringState(root, "p")).rev).toBe(1);
    const history = await app.request("/api/v1/projects/p/story-graph");
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toEqual(JSON.parse(original));
  });

  it("rejects a stale unsafe-id write without advancing the existing revision", async () => {
    const app = createStudioServer({} as never, root);
    const res = await app.request("/api/v1/projects/..%2Fx/story-graph/delta", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(410);
    expect((await loadAuthoringState(root, "p")).rev).toBe(1);
    expect((await loadStoryGraph(root, "p"))?.worldAnchor?.storyCore).toBe("历史故事");
  });
});
