/** SPDX-License-Identifier: AGPL-3.0-only */
import { describe, expect, it } from "vitest";
import {
  firstUnwrittenChapter,
  mergeWriteDirectory,
  writeChapterMark,
  writeMarkDotState,
  writeMarkLabel,
  writeStateMissing,
} from "./write-directory";

const volumeMap = [
  "## 第1卷 试炼（1-5章）",
  "Objective：开局。",
  "",
  "## 第 1 章 入局",
  "走进档案室。",
  "## 第 2 章 夜谈",
  "廊下旧案。",
  "## 第 3 章 残页",
  "半页案卷。",
].join("\n");

describe("write directory marks", () => {
  it("labels candidate / adopted / new-candidate / empty", () => {
    expect(writeChapterMark({})).toBe("empty");
    expect(writeChapterMark({ candidateId: "w1" })).toBe("candidate");
    expect(writeChapterMark({ adoptedId: "w1", candidateId: "w1" })).toBe("adopted");
    expect(writeChapterMark({ adoptedId: "w1", candidateId: "w2" })).toBe("adopted-new");
    expect(writeChapterMark({ hasPersistedChapter: true })).toBe("adopted");
    expect(writeMarkLabel("empty", true)).toBe("未写");
    expect(writeMarkLabel("candidate", true)).toBe("有候选");
    expect(writeMarkLabel("adopted", true)).toBe("已采用");
    expect(writeMarkLabel("adopted-new", true)).toBe("已采用 · 新候选");
    expect(writeMarkDotState("empty")).toBe("todo");
    expect(writeMarkDotState("candidate")).toBe("current");
    expect(writeMarkDotState("adopted")).toBe("done");
    expect(writeMarkDotState("adopted-new")).toBe("current");
  });

  it("lists planned volume chapters and overlays write status", () => {
    const directory = mergeWriteDirectory({
      volumeMap,
      persisted: [{ number: 1, title: "入局（已写）", wordCount: 2800 }],
      candidates: { "3": "write-3-c", "5": "write-5-c" },
      adopted: { "1": "write-1-a", "3": "write-3-a" },
    });
    expect(directory.map((chapter) => [chapter.number, chapter.mark, chapter.title])).toEqual([
      [1, "adopted", "入局"],
      [2, "empty", "夜谈"],
      [3, "adopted-new", "残页"],
      [4, "empty", ""],
      [5, "candidate", ""],
    ]);
    expect(firstUnwrittenChapter(directory, 9)).toBe(2);
  });

  it("keeps persisted chapters that are not in the adopted map", () => {
    const directory = mergeWriteDirectory({
      volumeMap: "## 第1卷 试炼（1-2章）\n",
      persisted: [{ number: 8, title: "后记", wordCount: 400 }],
    });
    expect(directory.map((chapter) => chapter.number)).toEqual([1, 2, 8]);
    expect(directory[2]).toMatchObject({ number: 8, mark: "adopted", title: "后记" });
    expect(firstUnwrittenChapter(directory, 3)).toBe(1);
  });

  it("falls back to nextChapter when every planned chapter is written", () => {
    const directory = mergeWriteDirectory({
      volumeMap: "## 第1卷 试炼（1-2章）\n",
      persisted: [{ number: 1, title: "一", wordCount: 1 }, { number: 2, title: "二", wordCount: 1 }],
    });
    expect(firstUnwrittenChapter(directory, 3)).toBe(3);
  });

  it("marks adopted chapters whose state file is missing or stale", () => {
    expect(writeStateMissing({ adoptedId: "w1" })).toBe(true);
    expect(writeStateMissing({ adoptedId: "w1", stateArtifactId: "w0" })).toBe(true);
    expect(writeStateMissing({ adoptedId: "w1", stateArtifactId: "w1" })).toBe(false);
    expect(writeStateMissing({})).toBe(false);
    const directory = mergeWriteDirectory({
      volumeMap,
      adopted: { "1": "write-1-a", "2": "write-2-a" },
      stateRefs: { "1": "write-1-a" },
    });
    expect(directory.find((chapter) => chapter.number === 1)?.stateMissing).toBe(false);
    expect(directory.find((chapter) => chapter.number === 2)?.stateMissing).toBe(true);
  });
});
