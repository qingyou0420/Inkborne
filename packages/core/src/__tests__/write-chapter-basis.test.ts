import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWriteChapterBasis } from "../authoring/context.js";

describe("loadWriteChapterBasis", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("has no previous chapter for chapter 1, clips the previous ending, and reports volume progress", async () => {
    root = await mkdtemp(join(tmpdir(), "write-basis-"));
    const bookDir = join(root, "books", "harbor");
    await mkdir(join(bookDir, "story", "outline"), { recursive: true });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: "harbor",
      title: "夜港",
      chapterWordCount: 2000,
    }), "utf-8");
    const previous = `甲`.repeat(40) + `乙`.repeat(320);
    await writeFile(join(bookDir, "chapters", "0001_雨.md"), `# 第1章 雨\n\n${previous}\n`, "utf-8");
    await writeFile(join(bookDir, "story", "outline", "volume_map.md"), [
      "## 第1卷 上卷（1-2章）",
      "这一卷要把信送到。",
      "",
      "## 第 1 章 雨",
      "雨夜出门。",
      "",
      "## 第 2 章 信",
      "信到了码头。",
      "",
    ].join("\n"), "utf-8");

    const first = await loadWriteChapterBasis({ projectRoot: root, bookId: "harbor" }, 1);
    expect(first.previousEnding).toBe("");
    expect(first.title).toContain("雨");
    expect(first.summary).toContain("雨夜");
    expect(first.progress).toContain("第 1 章");
    expect(first.progress).toContain("一共 2 章");
    expect(first.targetWordCount).toBe(2000);

    const second = await loadWriteChapterBasis({ projectRoot: root, bookId: "harbor" }, 2);
    expect(second.previousEnding.startsWith("…")).toBe(true);
    expect(second.previousEnding.length).toBeLessThanOrEqual(301);
    expect(second.previousEnding.endsWith("乙")).toBe(true);
    expect(second.previousEnding).not.toContain("甲");
    expect(second.title).toContain("信");
    expect(second.progress).toContain("第 2 章");
  });
});
