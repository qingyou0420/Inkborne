import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLightweightBook } from "../authoring/book-create.js";
import { isBookFoundationComplete } from "../utils/outline-paths.js";
import { isBookPresent, isLightweightAuthoringBook } from "../authoring/context.js";
import { BookConfigSchema } from "../models/book.js";
import { parseCanon } from "../authoring/canon.js";

describe("lightweight book create", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("keeps a valid short-chapter canon readable after book creation", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-short-chapter-"));
    const canon = parseCanon("---\ntitle: 短章验收\nchapterWordCount: 300\ntargetChapters: 2\n---\n\n## 一句话故事\n一次归还旧信的旅程。\n");
    const book = await createLightweightBook({ projectRoot: root, canon });
    const saved = BookConfigSchema.parse(JSON.parse(await readFile(join(book.bookDir, "book.json"), "utf8")));
    expect(saved.chapterWordCount).toBe(300);
    expect(parseCanon(await readFile(join(book.bookDir, "story", "canon.md"), "utf8")).chapterWordCount).toBe(300);
    expect(saved.targetChapters).toBe(2);
  });

  it("refuses to create a book when target chapters are still unset", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-book-length-"));
    await expect(createLightweightBook({
      projectRoot: root,
      canon: {
        title: "未定篇幅",
        oneLine: "还没决定写多少章",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
      },
    })).rejects.toMatchObject({
      message: expect.stringContaining("请先确认全书篇幅"),
    });
  });

  it("creates a readable book without calling ground or weave artifacts", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-book-"));
    const first = await createLightweightBook({
      projectRoot: root,
      draftId: "draft-1",
      canon: {
        title: "夜港账本",
        genre: "现实",
        oneLine: "一个会计要找回失踪的账本。",
        proposition: "记忆有代价",
        protagonist: "沈砚想赎回自己",
        conflict: "救人还是自保",
        voice: "限制视角",
        boundaries: "开放结局",
        direction: "从港口开始",
        openQuestions: ["结局是否公开真相"],
        targetChapters: 12,
        chapterWordCount: 2000,
      },
    });
    expect(first.created).toBe(true);
    expect(await isBookPresent(first.bookDir)).toBe(true);
    expect(await isLightweightAuthoringBook(first.bookDir)).toBe(true);
    expect(await isBookFoundationComplete(first.bookDir)).toBe(false);
    const canon = await readFile(join(first.bookDir, "story", "canon.md"), "utf-8");
    expect(canon).toContain("沈砚想赎回自己");
    await access(join(first.bookDir, "chapters", "index.json"));
    const second = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "夜港账本",
        oneLine: "重复点击",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
      },
    });
    expect(second.created).toBe(false);
    expect(second.bookId).toBe(first.bookId);
  });
});
