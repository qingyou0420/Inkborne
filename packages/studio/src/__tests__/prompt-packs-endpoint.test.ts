import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptOverridePath } from "@actalk/inkos-core";
import { createStudioServer } from "../api/server.js";

describe("Studio prompt pack endpoints", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-studio-prompts-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists built-in prompt packs with project override status", async () => {
    const overridePath = promptOverridePath(root, "play.renderer");
    await mkdir(overridePath.slice(0, overridePath.lastIndexOf("/")), { recursive: true });
    await writeFile(overridePath, "PROJECT RENDERER", "utf-8");

    const app = createStudioServer({} as never, root);
    const res = await app.request("/api/v1/prompt-packs");
    const json = await res.json() as {
      packs: Array<{ id: string; prompts: string[] }>;
      prompts: Array<{ id: string; packId: string; content: string; defaultContent: string; source: string; overridden: boolean; path?: string }>;
    };

    expect(res.status).toBe(200);
    expect(json.packs.map((pack) => pack.id)).toContain("play");
    expect(json.prompts).toContainEqual(expect.objectContaining({
      id: "play.renderer",
      packId: "play",
      content: "PROJECT RENDERER",
      source: "project",
      overridden: true,
      path: "prompt/play/renderer.md",
    }));
    expect(json.prompts.find((prompt) => prompt.id === "play.mutator")?.source).toBe("builtin");
    expect(json.prompts.find((prompt) => prompt.id === "play.renderer")?.defaultContent)
      .toContain("scene renderer");
  });

  it("retires save/reset while preserving existing override bytes and GET visibility", async () => {
    const overridePath = promptOverridePath(root, "play.renderer");
    const original = "Original project renderer.\r\nKeep historical instructions.\r\n";
    await mkdir(dirname(overridePath), { recursive: true });
    await writeFile(overridePath, original, "utf-8");
    const app = createStudioServer({} as never, root);

    const saveRes = await app.request("/api/v1/prompt-packs/play.renderer", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Render slowly and preserve discovered evidence." }),
    });
    expect(saveRes.status).toBe(410);
    await expect(saveRes.json()).resolves.toMatchObject({ error: { code: "FEATURE_RETIRED" } });
    expect(await readFile(overridePath, "utf-8")).toBe(original);

    const resetRes = await app.request("/api/v1/prompt-packs/play.renderer", { method: "DELETE" });
    expect(resetRes.status).toBe(410);
    await expect(resetRes.json()).resolves.toMatchObject({ error: { code: "FEATURE_RETIRED" } });
    expect(await readFile(overridePath, "utf-8")).toBe(original);
    const history = await app.request("/api/v1/prompt-packs");
    expect(history.status).toBe(200);
    const data = await history.json() as { prompts: Array<{ id: string; content: string; source: string; overridden: boolean }> };
    expect(data.prompts).toContainEqual(expect.objectContaining({ id: "play.renderer", source: "project", overridden: true, content: original }));
  });

  it("rejects unknown prompt ids instead of writing arbitrary files", async () => {
    const app = createStudioServer({} as never, root);

    const res = await app.request("/api/v1/prompt-packs/../../bad", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "bad" }),
    });

    expect(res.status).toBe(404);
  });
});
