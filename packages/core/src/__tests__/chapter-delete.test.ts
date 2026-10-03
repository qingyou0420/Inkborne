import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChapterMeta } from "../models/chapter.js";
import { StateManager } from "../state/manager.js";
import { deleteLatestChapter } from "../state/chapter-delete.js";

function chapterEntry(number: number, title: string): ChapterMeta {
  const now = new Date().toISOString();
  return {
    number,
    title,
    status: "ready-for-review",
    wordCount: 10,
    createdAt: now,
    updatedAt: now,
    auditIssues: [],
    lengthWarnings: [],
  };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

async function setupBook(params: {
  readonly bookId: string;
  readonly chapters: ReadonlyArray<{ readonly number: number; readonly title: string; readonly content: string }>;
  readonly snapshotChapters: ReadonlyArray<number>;
}): Promise<{ readonly root: string; readonly bookDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "inkos-chapter-delete-"));
  const bookDir = join(root, "books", params.bookId);
  const storyDir = join(bookDir, "story");
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(storyDir, { recursive: true });
  await writeFile(join(bookDir, "book.json"), JSON.stringify({ id: params.bookId, title: params.bookId }), "utf-8");

  for (const chapter of params.chapters) {
    const padded = String(chapter.number).padStart(4, "0");
    await writeFile(join(bookDir, "chapters", `${padded}_${chapter.title}.md`), chapter.content, "utf-8");
  }
  await writeFile(
    join(bookDir, "chapters", "index.json"),
    JSON.stringify(params.chapters.map((c) => chapterEntry(c.number, c.title)), null, 2),
    "utf-8",
  );

  await writeFile(join(storyDir, "current_state.md"), "state after latest chapter", "utf-8");
  await writeFile(join(storyDir, "pending_hooks.md"), "hooks after latest chapter", "utf-8");
  for (const snapshotChapter of params.snapshotChapters) {
    const snapshotDir = join(storyDir, "snapshots", String(snapshotChapter));
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(snapshotDir, "current_state.md"), `state at chapter ${snapshotChapter}`, "utf-8");
    await writeFile(join(snapshotDir, "pending_hooks.md"), `hooks at chapter ${snapshotChapter}`, "utf-8");
  }
  return { root, bookDir };
}

describe("deleteLatestChapter", () => {
  it("moves the latest chapter file to chapters/.trash and rolls state back", async () => {
    const { root, bookDir } = await setupBook({
      bookId: "delbook",
      chapters: [
        { number: 1, title: "起风", content: "# 第1章 起风\n\n第一章正文。" },
        { number: 2, title: "落雨", content: "# 第2章 落雨\n\n第二章正文。" },
        { number: 3, title: "收网", content: "# 第3章 收网\n\n第三章正文。" },
      ],
      snapshotChapters: [1, 2, 3],
    });

    const state = new StateManager(root);
    const result = await deleteLatestChapter(state, "delbook");

    expect(result.deletedChapter).toBe(3);
    expect(result.title).toBe("收网");
    expect(result.rolledBackTo).toBe(2);
    expect(result.discarded).toEqual([3]);
    expect(result.trashedFiles).toEqual(["chapters/.trash/0003_收网.md"]);

    // Chapter file is preserved in the trash, not hard-deleted.
    await expect(exists(join(bookDir, "chapters", "0003_收网.md"))).resolves.toBe(false);
    await expect(readFile(join(bookDir, "chapters", ".trash", "0003_收网.md"), "utf-8"))
      .resolves.toContain("第三章正文");

    // Index drops the deleted chapter.
    const savedIndex = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8")) as ChapterMeta[];
    expect(savedIndex.map((c) => c.number)).toEqual([1, 2]);

    // Story state is rolled back to the chapter-2 snapshot.
    await expect(readFile(join(bookDir, "story", "current_state.md"), "utf-8"))
      .resolves.toBe("state at chapter 2");
    await expect(readFile(join(bookDir, "story", "pending_hooks.md"), "utf-8"))
      .resolves.toBe("hooks at chapter 2");
  });

  it("rejects deleting a chapter that is not the latest", async () => {
    const { root, bookDir } = await setupBook({
      bookId: "midbook",
      chapters: [
        { number: 1, title: "起风", content: "第一章。" },
        { number: 2, title: "落雨", content: "第二章。" },
      ],
      snapshotChapters: [1, 2],
    });

    const state = new StateManager(root);
    await expect(deleteLatestChapter(state, "midbook", { chapterNumber: 1 }))
      .rejects.toThrow(/latest chapter/i);

    // Nothing was touched.
    await expect(exists(join(bookDir, "chapters", "0001_起风.md"))).resolves.toBe(true);
    await expect(exists(join(bookDir, "chapters", ".trash"))).resolves.toBe(false);
  });

  it("rejects deleting from a book with no chapters", async () => {
    const { root } = await setupBook({
      bookId: "emptybook",
      chapters: [],
      snapshotChapters: [],
    });

    const state = new StateManager(root);
    await expect(deleteLatestChapter(state, "emptybook"))
      .rejects.toThrow(/no chapters/i);
  });

  it("fails before moving any file when the rollback snapshot is missing", async () => {
    const { root, bookDir } = await setupBook({
      bookId: "nosnapbook",
      chapters: [
        { number: 1, title: "起风", content: "第一章。" },
        { number: 2, title: "落雨", content: "第二章。" },
      ],
      snapshotChapters: [2], // snapshot for chapter 1 (rollback target) is missing
    });

    const state = new StateManager(root);
    await expect(deleteLatestChapter(state, "nosnapbook"))
      .rejects.toThrow(/snapshot/i);

    // The chapter file stays in place — no half-deleted state.
    await expect(exists(join(bookDir, "chapters", "0002_落雨.md"))).resolves.toBe(true);
    await expect(exists(join(bookDir, "chapters", ".trash"))).resolves.toBe(false);
  });

  it("deletes the only chapter of a book when the chapter-0 snapshot exists", async () => {
    const { root, bookDir } = await setupBook({
      bookId: "onebook",
      chapters: [{ number: 1, title: "起风", content: "第一章正文。" }],
      snapshotChapters: [0, 1],
    });

    const state = new StateManager(root);
    const result = await deleteLatestChapter(state, "onebook");

    expect(result.deletedChapter).toBe(1);
    expect(result.rolledBackTo).toBe(0);
    const savedIndex = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8")) as ChapterMeta[];
    expect(savedIndex).toEqual([]);
    await expect(readFile(join(bookDir, "chapters", ".trash", "0001_起风.md"), "utf-8"))
      .resolves.toBe("第一章正文。");
  });

  it("keeps existing trash entries by picking a distinct name on collision", async () => {
    const { root, bookDir } = await setupBook({
      bookId: "twicebook",
      chapters: [
        { number: 1, title: "起风", content: "第一章。" },
        { number: 2, title: "落雨", content: "新的第二章。" },
      ],
      snapshotChapters: [1, 2],
    });
    await mkdir(join(bookDir, "chapters", ".trash"), { recursive: true });
    await writeFile(join(bookDir, "chapters", ".trash", "0002_落雨.md"), "旧的第二章。", "utf-8");

    const state = new StateManager(root);
    const result = await deleteLatestChapter(state, "twicebook");

    expect(result.trashedFiles).toEqual(["chapters/.trash/0002_落雨-2.md"]);
    await expect(readFile(join(bookDir, "chapters", ".trash", "0002_落雨.md"), "utf-8"))
      .resolves.toBe("旧的第二章。");
    await expect(readFile(join(bookDir, "chapters", ".trash", "0002_落雨-2.md"), "utf-8"))
      .resolves.toBe("新的第二章。");
  });

  it("rolls back the index even when the chapter file was already deleted by hand", async () => {
    const { root, bookDir } = await setupBook({
      bookId: "handbook",
      chapters: [
        { number: 1, title: "起风", content: "第一章。" },
        { number: 2, title: "落雨", content: "第二章。" },
      ],
      snapshotChapters: [1, 2],
    });
    const { rm } = await import("node:fs/promises");
    await rm(join(bookDir, "chapters", "0002_落雨.md"));

    const state = new StateManager(root);
    const result = await deleteLatestChapter(state, "handbook");

    expect(result.deletedChapter).toBe(2);
    expect(result.trashedFiles).toEqual([]);
    const savedIndex = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8")) as ChapterMeta[];
    expect(savedIndex.map((c) => c.number)).toEqual([1]);
  });

  it("ignores files inside chapters/.trash when resolving the latest chapter's files", async () => {
    const { root, bookDir } = await setupBook({
      bookId: "trashscanbook",
      chapters: [
        { number: 1, title: "起风", content: "第一章。" },
        { number: 2, title: "落雨", content: "第二章。" },
      ],
      snapshotChapters: [1, 2],
    });
    await mkdir(join(bookDir, "chapters", ".trash"), { recursive: true });
    await writeFile(join(bookDir, "chapters", ".trash", "0009_幽灵.md"), "trash ghost", "utf-8");

    const state = new StateManager(root);
    const result = await deleteLatestChapter(state, "trashscanbook");

    expect(result.deletedChapter).toBe(2);
    const trashEntries = await readdir(join(bookDir, "chapters", ".trash"));
    expect(trashEntries.sort()).toEqual(["0002_落雨.md", "0009_幽灵.md"]);
  });

  it("deletes the only chapter of a lightweight book without a chapter-0 snapshot", async () => {
    const { root, bookDir } = await setupBook({
      bookId: "light-one",
      chapters: [{ number: 1, title: "起风", content: "# 第1章 起风\n\n第一章正文。" }],
      snapshotChapters: [],
    });
    await mkdir(join(bookDir, "story"), { recursive: true });
    await writeFile(join(bookDir, "story", "canon.md"), "# 正典\n轻量书。\n", "utf-8");
    await mkdir(join(bookDir, "story", "workflow"), { recursive: true });
    await writeFile(join(bookDir, "story", "workflow", "manifest.json"), JSON.stringify({
      version: 1,
      updatedAt: "2026-10-03T00:00:00.000Z",
      adopted: { write: { "1": "write-ch1" } },
      candidates: { write: { "1": "write-ch1" } },
      coverage: { chaptersWrittenAdopted: 1 },
    }), "utf-8");
    await mkdir(join(bookDir, "story", "state"), { recursive: true });
    await writeFile(join(bookDir, "story", "state", "serial-ledger.json"), JSON.stringify({
      version: 1,
      updatedAt: "2026-10-03T00:00:00.000Z",
      chapters: [{ chapter: 1, artifactId: "write-ch1", title: "起风", summary: "开场", characters: [], openHooks: [], advanceHookIds: [], resolveHookIds: [] }],
    }), "utf-8");
    await writeFile(join(bookDir, "story", "state", "chapter-1.md"), "开场\n", "utf-8");
    await writeFile(join(bookDir, "story", "state", "chapter-1.ref.json"), JSON.stringify({ artifactId: "write-ch1", chapterNumber: 1 }), "utf-8");

    const state = new StateManager(root);
    const result = await deleteLatestChapter(state, "light-one");
    expect(result.deletedChapter).toBe(1);
    const savedIndex = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8")) as ChapterMeta[];
    expect(savedIndex).toEqual([]);
    await expect(readFile(join(bookDir, "chapters", ".trash", "0001_起风.md"), "utf-8")).resolves.toContain("第一章正文");
    const manifest = JSON.parse(await readFile(join(bookDir, "story", "workflow", "manifest.json"), "utf-8")) as { adopted: { write: Record<string, string> } };
    expect(manifest.adopted.write["1"]).toBeUndefined();
    const ledger = JSON.parse(await readFile(join(bookDir, "story", "state", "serial-ledger.json"), "utf-8")) as { chapters: unknown[] };
    expect(ledger.chapters).toEqual([]);
    await expect(exists(join(bookDir, "story", "state", "chapter-1.md"))).resolves.toBe(false);
  });

  it("deletes only the latest lightweight chapter and leaves the first chapter memory", async () => {
    const { root, bookDir } = await setupBook({
      bookId: "light-two",
      chapters: [
        { number: 1, title: "起风", content: "# 第1章 起风\n\n第一章正文。" },
        { number: 2, title: "落雨", content: "# 第2章 落雨\n\n第二章正文。" },
      ],
      snapshotChapters: [],
    });
    await writeFile(join(bookDir, "story", "canon.md"), "# 正典\n轻量书。\n", "utf-8");
    await mkdir(join(bookDir, "story", "workflow"), { recursive: true });
    await writeFile(join(bookDir, "story", "workflow", "manifest.json"), JSON.stringify({
      version: 1,
      updatedAt: "2026-10-03T00:00:00.000Z",
      adopted: { write: { "1": "write-ch1", "2": "write-ch2" } },
      candidates: { write: { "1": "write-ch1", "2": "write-ch2" } },
      coverage: { chaptersWrittenAdopted: 2 },
    }), "utf-8");
    await mkdir(join(bookDir, "story", "state"), { recursive: true });
    await writeFile(join(bookDir, "story", "state", "serial-ledger.json"), JSON.stringify({
      version: 1,
      updatedAt: "2026-10-03T00:00:00.000Z",
      chapters: [
        { chapter: 1, artifactId: "write-ch1", title: "起风", summary: "第一章记忆", characters: [{ name: "林", status: "在港" }], openHooks: [], advanceHookIds: [], resolveHookIds: [] },
        { chapter: 2, artifactId: "write-ch2", title: "落雨", summary: "第二章记忆", characters: [], openHooks: [], advanceHookIds: [], resolveHookIds: [] },
      ],
    }), "utf-8");
    await writeFile(join(bookDir, "story", "state", "chapter-1.md"), "第一章记忆\n", "utf-8");
    await writeFile(join(bookDir, "story", "state", "chapter-1.ref.json"), JSON.stringify({ artifactId: "write-ch1", chapterNumber: 1 }), "utf-8");
    await writeFile(join(bookDir, "story", "state", "chapter-2.md"), "第二章记忆\n", "utf-8");
    await writeFile(join(bookDir, "story", "state", "chapter-2.ref.json"), JSON.stringify({ artifactId: "write-ch2", chapterNumber: 2 }), "utf-8");

    const state = new StateManager(root);
    const result = await deleteLatestChapter(state, "light-two");
    expect(result.deletedChapter).toBe(2);
    await expect(readFile(join(bookDir, "chapters", "0001_起风.md"), "utf-8")).resolves.toContain("第一章正文");
    const manifest = JSON.parse(await readFile(join(bookDir, "story", "workflow", "manifest.json"), "utf-8")) as { adopted: { write: Record<string, string> }; candidates: { write: Record<string, string> } };
    expect(manifest.adopted.write).toEqual({ "1": "write-ch1" });
    expect(manifest.candidates.write["2"]).toBeUndefined();
    const ledger = JSON.parse(await readFile(join(bookDir, "story", "state", "serial-ledger.json"), "utf-8")) as { chapters: Array<{ chapter: number; summary: string }> };
    expect(ledger.chapters.map((item) => item.chapter)).toEqual([1]);
    expect(ledger.chapters[0]?.summary).toBe("第一章记忆");
    await expect(readFile(join(bookDir, "story", "state", "chapter-1.md"), "utf-8")).resolves.toContain("第一章记忆");
    await expect(exists(join(bookDir, "story", "state", "chapter-2.md"))).resolves.toBe(false);
  });
});
