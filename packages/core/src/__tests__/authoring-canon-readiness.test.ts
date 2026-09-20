// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAskBookCandidate } from "../authoring/ask-book-create.js";
import { serializeCanon } from "../authoring/canon.js";
import { assembleAuthoringContext, assertAdoptedCanonReady } from "../authoring/context.js";
import { adoptAskCanon } from "../authoring/stages/ask.js";
import { generateGroundEntries, proposeSettingsCatalog } from "../authoring/stages/ground.js";
import { listRuns, loadSettingsCatalog } from "../authoring/store.js";
import { ProjectConfigSchema } from "../models/project.js";

const canon = {
  title: "旧城来信", genre: "古风", oneLine: "故友寻回失散书信。", proposition: "承担自己的选择。",
  protagonist: "叶川想将遗失的家书归还主人。", conflict: "家书归属与故友立场冲突。",
  voice: "第三人称限知，白描。", boundaries: "不增加超自然能力。", direction: "从第一封来信开始。", openQuestions: [],
  targetChapters: 80, chapterWordCount: 2800,
};
const project = ProjectConfigSchema.parse({
  name: "readiness-test", version: "0.1.0",
  llm: { provider: "custom", model: "synthetic", apiKey: "synthetic", baseUrl: "https://unused.invalid/v1" },
});
const catalogText = JSON.stringify({ categories: ["人物"], entries: [{ id: "ye", category: "人物", name: "叶川" }] });

describe("unadopted Ask candidate readiness", () => {
  let projectRoot = "";
  beforeEach(async () => { projectRoot = await mkdtemp(join(tmpdir(), "authoring-readiness-")); });
  afterEach(async () => { await rm(projectRoot, { recursive: true, force: true }); });

  async function pendingBook() {
    return createAskBookCandidate({
      projectRoot, project, book: { title: canon.title }, conversation: "叶川寻找失散家书。",
      llm: async () => JSON.stringify(canon),
    });
  }

  it("rejects downstream work before model calls or writes while Ask remains available", async () => {
    const created = await pendingBook();
    const root = { projectRoot, bookId: created.bookId };
    const llm = vi.fn(async () => catalogText);
    const runtime = { root, project, llm };
    const runsBefore = await listRuns(root);
    await expect(proposeSettingsCatalog(runtime)).rejects.toThrow("请先在问心中采用正典");
    await expect(generateGroundEntries(runtime)).rejects.toThrow("请先在问心中采用正典");
    for (const stage of ["ground", "weave", "write"] as const) {
      await expect(assembleAuthoringContext(root, { stage })).rejects.toThrow("请先在问心中采用正典");
    }
    await expect(assembleAuthoringContext(root)).rejects.toThrow("请先在问心中采用正典");
    await expect(assembleAuthoringContext(root, { stage: "ask" })).resolves.toHaveProperty("text");
    expect(llm).not.toHaveBeenCalled();
    expect(await listRuns(root)).toEqual(runsBefore);
    expect((await loadSettingsCatalog(root)).entries).toEqual([]);
    await expect(readFile(join(created.bookDir, "story", "settings", "index.json"), "utf-8")).rejects.toThrow();
  });

  it("allows downstream work immediately after explicit adoption without requiring review", async () => {
    const created = await pendingBook();
    const root = { projectRoot, bookId: created.bookId };
    await adoptAskCanon({ root, project, artifactId: created.artifactId });
    const context = await assembleAuthoringContext(root, { stage: "weave" });
    expect(context.text).toContain(canon.protagonist);
    expect(context.text).toContain("每章字数：2800");
    expect(context.refs).toContainEqual({ kind: "canon", id: created.artifactId });
    await expect(proposeSettingsCatalog({ root, project, llm: async () => catalogText })).resolves.toMatchObject({
      entries: [{ name: "叶川" }],
    });
  });

  it("keeps books without a manifest compatible with file-based authoring", async () => {
    const bookId = "legacy";
    const storyDir = join(projectRoot, "books", bookId, "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "..", "book.json"), JSON.stringify({ title: "旧书" }), "utf-8");
    await writeFile(join(storyDir, "author_intent.md"), "保留旧书的写作约定。", "utf-8");
    const root = { projectRoot, bookId };
    await expect(assembleAuthoringContext(root, { stage: "write" })).resolves.toHaveProperty("text");
    await expect(proposeSettingsCatalog({ root, project, llm: async () => catalogText })).resolves.toHaveProperty("entries");
  });

  it("does not block an existing canon when older manifests lack adoption metadata", async () => {
    const created = await pendingBook();
    await writeFile(join(created.bookDir, "story", "canon.md"), serializeCanon(canon), "utf-8");
    const root = { projectRoot, bookId: created.bookId };
    await expect(assertAdoptedCanonReady(root)).resolves.toBeUndefined();
    expect((await assembleAuthoringContext(root, { stage: "write" })).text).toContain(canon.protagonist);
  });
});
