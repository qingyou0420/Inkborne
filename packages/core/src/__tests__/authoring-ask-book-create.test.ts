// SPDX-License-Identifier: AGPL-3.0-only
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAskBookCandidate, type AskBookCreateInput } from "../authoring/ask-book-create.js";
import { parseCanon } from "../authoring/canon.js";
import { isLightweightAuthoringBook } from "../authoring/context.js";
import { listArtifacts, listRuns, loadArtifact, loadManifest, loadRun } from "../authoring/store.js";
import { ProjectConfigSchema } from "../models/project.js";
import type { AuthoringLlmCall } from "../authoring/types.js";

const generated = {
  title: "模型擅改的书名", genre: "悬疑", targetChapters: 36, chapterWordCount: 2000,
  oneLine: "三名少年寻找旧城失火的真相。", proposition: "背负责任仍守本心。",
  protagonist: "叶川想归还书院旧物。", conflict: "故友立场与家国利益冲突。",
  voice: "第三人称限知，节制的白描。", boundaries: "不增加超自然能力。",
  direction: "从书院收到失火消息开始。", openQuestions: ["尚未确定最后一封信由谁写出。"],
};

describe("Ask confirmation creates only an unadopted canon candidate", () => {
  let projectRoot: string;
  beforeEach(async () => { projectRoot = await mkdtemp(join(tmpdir(), "ask-book-create-")); });
  afterEach(async () => { await rm(projectRoot, { recursive: true, force: true }); });

  function input(): AskBookCreateInput {
    return {
      projectRoot,
      project: ProjectConfigSchema.parse({
        name: "ask-create-test", version: "0.1.0",
        llm: { provider: "custom", model: "fallback", apiKey: "synthetic", baseUrl: "https://unused.invalid/v1" },
        authoringRoles: {
          "ask.main": { modelId: "ask-only-model" },
          "ground.main": { modelId: "must-not-run-ground" },
        },
      }),
      conversation: `首轮原文：人物不得复活。\n${"原始问心对话。".repeat(1800)}\n末轮原文：必须保留七卷与全员代价。`,
      requirements: "作者确认：七卷不得压缩合并，原始约定全部保留。",
      book: { title: "夜港旧账", genre: "古风群像", platform: "tomato", language: "zh", targetChapters: 260, chapterWordCount: 5000 },
      llm: async () => JSON.stringify(generated),
    };
  }

  async function expectNoPublishedBooks() {
    expect(await readdir(join(projectRoot, "books")).catch(() => [])).toEqual([]);
    expect(await readdir(join(projectRoot, ".inkos", "authoring-drafts")).catch(() => [])).toEqual([]);
  }

  it("uses ask.main with complete source text, preserves the model snapshot, and leaves only a visible candidate", async () => {
    const request = input();
    const calls: AuthoringLlmCall[] = [];
    const result = await createAskBookCandidate({ ...request, llm: async (call) => { calls.push(call); return JSON.stringify(generated); } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.roleId).toBe("ask.main");
    expect(calls[0]!.snapshot.modelId).toBe("ask-only-model");
    const prompt = calls[0]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain(request.conversation);
    expect(prompt).toContain(request.requirements);
    expect(prompt).toContain("260");
    expect(prompt).toContain("5000");
    const root = { projectRoot, bookId: result.bookId };
    const manifest = await loadManifest(root);
    expect(manifest.bookId).toBe(result.bookId);
    expect(manifest.draftId).toBeUndefined();
    expect(manifest.candidates.ask).toBe(result.artifactId);
    expect(manifest.adopted).toEqual({ ground: [], write: {} });
    expect(manifest.candidates.ground).toEqual([]);
    expect(manifest.candidates.weave).toBeUndefined();
    expect(manifest.candidates.write).toEqual({});
    expect(await isLightweightAuthoringBook(result.bookDir)).toBe(true);
    const artifacts = await listArtifacts(root);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ stage: "ask", status: "candidate" });
    const artifact = await loadArtifact(root, result.artifactId);
    expect(parseCanon(artifact!.body)).toMatchObject({ title: "夜港旧账", genre: "古风群像", targetChapters: 260, chapterWordCount: 5000 });
    const run = await loadRun(root, result.runId);
    expect(run).toMatchObject({ bookId: result.bookId, roleId: "ask.main", status: "completed", modelSnapshot: { modelId: "ask-only-model" } });
    expect(run?.draftId).toBeUndefined();
    expect(await listRuns(root)).toHaveLength(1);
    const book = JSON.parse(await readFile(join(result.bookDir, "book.json"), "utf-8"));
    expect(book).toMatchObject({ title: "夜港旧账", targetChapters: 260, chapterWordCount: 5000, status: "incubating", writing: { reviewMode: "manual" } });
    for (const name of ["author_intent.md", "brief.md"]) {
      const text = await readFile(join(result.bookDir, "story", name), "utf-8");
      expect(text).toContain(request.conversation);
      expect(text).toContain(request.requirements);
    }
    expect((await readdir(join(result.bookDir, "story"))).sort()).toEqual(["author_intent.md", "brief.md", "workflow", "workflow.json"]);
    expect(JSON.parse(await readFile(join(result.bookDir, "story", "workflow.json"), "utf-8"))).toEqual({ lastStage: "ask" });
    await expect(access(join(result.bookDir, "story", "canon.md"))).rejects.toThrow();
    expect(await readFile(join(result.bookDir, "chapters", "index.json"), "utf-8")).toBe("[]\n");
    expect(await readdir(join(projectRoot, ".inkos", "authoring-drafts"))).toEqual([]);
  });

  it("rejects an existing same-title book under another id before spending a model call", async () => {
    const bookDir = join(projectRoot, "books", "earlier-id");
    await mkdir(bookDir, { recursive: true });
    const old = '{"title":"夜港旧账","keep":"original"}\n';
    await writeFile(join(bookDir, "book.json"), old);
    const llm = vi.fn(async () => JSON.stringify(generated));
    await expect(createAskBookCandidate({ ...input(), llm })).rejects.toThrow("已存在同名作品");
    expect(llm).not.toHaveBeenCalled();
    expect(await readFile(join(bookDir, "book.json"), "utf-8")).toBe(old);
  });

  it("does not overwrite an existing directory even if it has no book.json", async () => {
    const bookDir = join(projectRoot, "books", "夜港旧账");
    await mkdir(bookDir, { recursive: true });
    await writeFile(join(bookDir, "keep.txt"), "original");
    await expect(createAskBookCandidate(input())).rejects.toThrow("未覆盖");
    expect(await readFile(join(bookDir, "keep.txt"), "utf-8")).toBe("original");
  });

  it("removes only its own staging directory when model generation fails", async () => {
    const otherDraft = join(projectRoot, ".inkos", "authoring-drafts", "other-draft");
    await mkdir(otherDraft, { recursive: true });
    await writeFile(join(otherDraft, "keep.txt"), "untouched");
    await expect(createAskBookCandidate({ ...input(), llm: async () => { throw new Error("synthetic upstream failure"); } })).rejects.toThrow("synthetic upstream failure");
    expect(await readdir(join(projectRoot, "books")).catch(() => [])).toEqual([]);
    expect(await readdir(join(projectRoot, ".inkos", "authoring-drafts"))).toEqual(["other-draft"]);
    expect(await readFile(join(otherDraft, "keep.txt"), "utf-8")).toBe("untouched");
  });

  it("does not publish if cancelled while the model is generating", async () => {
    const controller = new AbortController();
    await expect(createAskBookCandidate({
      ...input(), signal: controller.signal,
      llm: async () => { controller.abort(); return JSON.stringify(generated); },
    })).rejects.toMatchObject({ name: "AbortError" });
    await expectNoPublishedBooks();
  });

  it("rechecks the destination after generation and preserves an intervening book", async () => {
    const bookDir = join(projectRoot, "books", "夜港旧账");
    await expect(createAskBookCandidate({
      ...input(), llm: async () => {
        await mkdir(bookDir, { recursive: true });
        await writeFile(join(bookDir, "book.json"), '{"title":"夜港旧账","keep":"concurrent"}');
        return JSON.stringify(generated);
      },
    })).rejects.toThrow("未覆盖");
    expect(await readFile(join(bookDir, "book.json"), "utf-8")).toContain("concurrent");
    expect(await readdir(join(bookDir))).toEqual(["book.json"]);
    expect(await readdir(join(projectRoot, ".inkos", "authoring-drafts"))).toEqual([]);
  });

  it("preserves author-confirmed length from the original conversation when the card omits it", async () => {
    const request = input();
    const conversation = `${request.conversation}\n作者最新确认：计划 260 章，每章 5000 字。`;
    const calls: AuthoringLlmCall[] = [];
    const result = await createAskBookCandidate({
      ...request,
      conversation,
      book: { title: request.book.title },
      llm: async (call) => {
        calls.push(call);
        return JSON.stringify({ ...generated, targetChapters: 260, chapterWordCount: 5000 });
      },
    });
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain(conversation);
    expect(prompt).toContain("从完整原始讨论提取作者最新明确确认");
    const artifact = await loadArtifact({ projectRoot, bookId: result.bookId }, result.artifactId);
    expect(parseCanon(artifact!.body)).toMatchObject({ targetChapters: 260, chapterWordCount: 5000 });
    const book = JSON.parse(await readFile(join(result.bookDir, "book.json"), "utf-8"));
    expect(book).toMatchObject({ targetChapters: 260, chapterWordCount: 5000 });
  });

  it("keeps genuinely unconfirmed length absent from the candidate and uses only internal book defaults", async () => {
    const request = input();
    const result = await createAskBookCandidate({
      ...request,
      conversation: "主角叶川寻找书院旧物。章数和每章字数尚未决定，保留为待定。",
      book: { title: request.book.title },
      llm: async () => JSON.stringify({ ...generated, targetChapters: null, chapterWordCount: null }),
    });
    const artifact = await loadArtifact({ projectRoot, bookId: result.bookId }, result.artifactId);
    const canon = parseCanon(artifact!.body);
    expect(canon.targetChapters).toBeUndefined();
    expect(canon.chapterWordCount).toBeUndefined();
    const book = JSON.parse(await readFile(join(result.bookDir, "book.json"), "utf-8"));
    expect(book.targetChapters).toBe(200);
    expect(book.chapterWordCount).toBe(3000);
  });
});
