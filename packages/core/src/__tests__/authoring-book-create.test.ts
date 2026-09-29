import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLightweightBook } from "../authoring/book-create.js";
import { isBookFoundationComplete } from "../utils/outline-paths.js";
import { isBookPresent, isLightweightAuthoringBook } from "../authoring/context.js";
import { BookConfigSchema } from "../models/book.js";
import { parseCanon, serializeCanon } from "../authoring/canon.js";
import { loadArtifact, loadManifest, saveManifest } from "../authoring/store.js";
import { BookWriteLockError, StateManager, resetProcessBookLocksForTest } from "../state/manager.js";

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

  const canon = {
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
  };

  function reboundArtifact(body: string) {
    return {
      meta: {
        artifactId: "ask-rebind-1",
        stage: "ask" as const,
        scope: "canon",
        version: 2,
        source: "generate" as const,
        status: "candidate" as const,
        bodyPath: "story/canon.md",
        inputRefs: [],
        createdAt: "2026-09-29T00:00:00.000Z",
        label: "正典 v2",
      },
      body,
    };
  }

  it("patches only ask fields inside the book lock when another writer changed the manifest", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-book-rebind-"));
    const first = await createLightweightBook({ projectRoot: root, canon });
    const store = { projectRoot: root, bookId: first.bookId };
    const seeded = await loadManifest(store);
    await saveManifest(store, {
      ...seeded,
      adopted: { ...seeded.adopted, weave: "weave-old", ground: ["ground-old"] },
      candidates: { ...seeded.candidates, weave: "weave-old", ground: ["ground-old"] },
      coverage: { ...seeded.coverage, chaptersGenerated: 1 },
    });
    const original = StateManager.prototype.acquireBookLock;
    const acquire = vi.spyOn(StateManager.prototype, "acquireBookLock");
    const bookBefore = await readFile(join(first.bookDir, "book.json"), "utf-8");
    acquire.mockImplementation(async function (this: StateManager, bookId, holder, options) {
      const latest = await loadManifest(store);
      await saveManifest(store, {
        ...latest,
        adopted: { ...latest.adopted, weave: "weave-kept", ground: ["ground-kept"] },
        candidates: { ...latest.candidates, weave: "weave-kept", ground: ["ground-kept"] },
        coverage: { ...latest.coverage, chaptersGenerated: 7 },
      });
      return original.call(this, bookId, holder, options);
    });
    try {
      const bound = await createLightweightBook({
        projectRoot: root,
        existingBookId: first.bookId,
        canon: { ...canon, oneLine: "账本自己回来了", chapterWordCount: 2100 },
        fromArtifact: reboundArtifact(serializeCanon({ ...canon, oneLine: "账本自己回来了" })),
      });
      expect(bound.created).toBe(false);
      expect(acquire).toHaveBeenCalled();
      const manifest = await loadManifest(store);
      expect(manifest.adopted.ask).toBe("ask-rebind-1");
      expect(manifest.candidates.ask).toBe("ask-rebind-1");
      expect(manifest.adopted.weave).toBe("weave-kept");
      expect(manifest.candidates.weave).toBe("weave-kept");
      expect(manifest.adopted.ground).toEqual(["ground-kept"]);
      expect(manifest.candidates.ground).toEqual(["ground-kept"]);
      expect(manifest.coverage.chaptersGenerated).toBe(7);
      const canonText = await readFile(join(first.bookDir, "story", "canon.md"), "utf-8");
      expect(canonText).toContain("账本自己回来了");
      const bookRaw = await readFile(join(first.bookDir, "book.json"), "utf-8");
      const book = JSON.parse(bookRaw) as { title: string; targetChapters: number; chapterWordCount: number };
      expect(book.title).toBe(canon.title);
      expect(book.targetChapters).toBe(canon.targetChapters);
      expect(book.chapterWordCount).toBe(2100);
      expect(bookRaw).not.toBe(bookBefore);
    } finally {
      acquire.mockRestore();
      resetProcessBookLocksForTest();
    }
  });

  it("does not write the bound manifest when another task already holds the book lock", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-book-rebind-busy-"));
    const first = await createLightweightBook({ projectRoot: root, canon });
    const store = { projectRoot: root, bookId: first.bookId };
    const seeded = await loadManifest(store);
    await saveManifest(store, {
      ...seeded,
      candidates: { ...seeded.candidates, weave: "weave-old" },
    });
    const before = await loadManifest(store);
    const canonPath = join(first.bookDir, "story", "canon.md");
    const bookPath = join(first.bookDir, "book.json");
    const canonBefore = await readFile(canonPath);
    const bookBefore = await readFile(bookPath);
    const release = await new StateManager(root).acquireBookLock(first.bookId, {
      stage: "落笔",
      taskId: "write-holds",
    }, { waitMs: 0 });
    try {
      await expect(createLightweightBook({
        projectRoot: root,
        existingBookId: first.bookId,
        canon,
        fromArtifact: reboundArtifact(serializeCanon(canon)),
      })).rejects.toBeInstanceOf(BookWriteLockError);
      const after = await loadManifest(store);
      expect(after.adopted.ask).toBe(before.adopted.ask);
      expect(after.candidates.ask).toBe(before.candidates.ask);
      expect(after.candidates.weave).toBe("weave-old");
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(await loadArtifact(store, "ask-rebind-1")).toBeUndefined();
      expect(await readFile(canonPath)).toEqual(canonBefore);
      expect(await readFile(bookPath)).toEqual(bookBefore);
    } finally {
      await release();
      resetProcessBookLocksForTest();
    }
  });

  it("does not touch canon.md or book.json when rebinding without a source draft while the book is locked", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-book-rebind-nosource-busy-"));
    const first = await createLightweightBook({ projectRoot: root, canon });
    const store = { projectRoot: root, bookId: first.bookId };
    const before = await loadManifest(store);
    const canonPath = join(first.bookDir, "story", "canon.md");
    const bookPath = join(first.bookDir, "book.json");
    const canonBefore = await readFile(canonPath);
    const bookBefore = await readFile(bookPath);
    const release = await new StateManager(root).acquireBookLock(first.bookId, {
      stage: "落笔",
      taskId: "write-holds",
    }, { waitMs: 0 });
    try {
      await expect(createLightweightBook({
        projectRoot: root,
        existingBookId: first.bookId,
        canon: { ...canon, title: "不该写上", oneLine: "锁外不该落下的正文", targetChapters: 40, chapterWordCount: 3000 },
      })).rejects.toBeInstanceOf(BookWriteLockError);
      const after = await loadManifest(store);
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(after.adopted.ask).toBe(before.adopted.ask);
      expect(await readFile(canonPath)).toEqual(canonBefore);
      expect(await readFile(bookPath)).toEqual(bookBefore);
    } finally {
      await release();
      resetProcessBookLocksForTest();
    }
  });

  it("writes canon.md and book.json when rebinding without a source draft and the lock is free", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-book-rebind-nosource-"));
    const first = await createLightweightBook({ projectRoot: root, canon });
    const next = { ...canon, title: "夜港新账", oneLine: "只改文件的正典", targetChapters: 18, chapterWordCount: 1800 };
    const bound = await createLightweightBook({
      projectRoot: root,
      existingBookId: first.bookId,
      canon: next,
    });
    expect(bound.created).toBe(false);
    expect(bound.bookId).toBe(first.bookId);
    const canonText = await readFile(join(first.bookDir, "story", "canon.md"), "utf-8");
    expect(canonText).toContain("夜港新账");
    expect(canonText).toContain("只改文件的正典");
    const book = JSON.parse(await readFile(join(first.bookDir, "book.json"), "utf-8")) as {
      title: string;
      targetChapters: number;
      chapterWordCount: number;
    };
    expect(book.title).toBe("夜港新账");
    expect(book.targetChapters).toBe(18);
    expect(book.chapterWordCount).toBe(1800);
  });
});
