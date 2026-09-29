import { describe, expect, it } from "vitest";
import {
  collapseDuplicateChapterHeadings,
  ensureSingleChapterHeading,
  parseChapterNumberToken,
  splitChapterHeading,
} from "../authoring/chapter-heading.js";

describe("chapter heading duplicates", () => {
  it("parses common Chinese chapter numbers", () => {
    expect(parseChapterNumberToken("八")).toBe(8);
    expect(parseChapterNumberToken("十")).toBe(10);
    expect(parseChapterNumberToken("十一")).toBe(11);
    expect(parseChapterNumberToken("二十")).toBe(20);
    expect(parseChapterNumberToken("二十三")).toBe(23);
    expect(parseChapterNumberToken("一百")).toBe(100);
    expect(parseChapterNumberToken("一百零八")).toBe(108);
    expect(parseChapterNumberToken("二百六十")).toBe(260);
  });

  it("keeps one copy when the model writes the same chapter title twice", () => {
    const body = [
      "第八章 夜雨",
      "第八章 夜雨",
      "雨下了一夜。",
      "他后来提起「第八章 夜雨」四个字。",
    ].join("\n");
    const next = collapseDuplicateChapterHeadings(body, { chapterNumber: 8, title: "夜雨" });
    const headingLines = next.split("\n").filter((line) => line.trim() === "第八章 夜雨");
    expect(headingLines).toHaveLength(1);
    expect(next).toContain("雨下了一夜。");
    expect(next).toContain("他后来提起「第八章 夜雨」四个字。");
  });

  it("treats a hash heading and a plain heading as the same title", () => {
    const body = "# 第八章 夜雨\n\n第八章 夜雨\n\n沈砚推开门。";
    const next = collapseDuplicateChapterHeadings(body, { chapterNumber: 8, title: "夜雨" });
    expect(next.startsWith("# 第八章 夜雨")).toBe(true);
    expect(next.split("\n").filter((line) => line.includes("第八章 夜雨"))).toHaveLength(1);
    expect(next).toContain("沈砚推开门。");
  });

  it("does not remove a different title or a sentence that only mentions the chapter", () => {
    const body = [
      "第八章 夜雨",
      "第八章 晨雾",
      "第一章就出事了，他没来得及撑伞。",
      "后文单独成段：他说第八章 夜雨才是关键。",
    ].join("\n");
    expect(collapseDuplicateChapterHeadings(body, { chapterNumber: 8 })).toBe(body);
  });

  it("leaves a single heading untouched and adds one only when the draft has none", () => {
    const one = "# 第1章\n沈砚走在街上。";
    expect(ensureSingleChapterHeading(one, { chapterNumber: 1, title: "雨" })).toBe(one);
    const prose = "雨下了一夜，没有标题。";
    const added = ensureSingleChapterHeading(prose, { chapterNumber: 8, title: "夜雨" });
    expect(added.startsWith("# 第8章 夜雨\n")).toBe(true);
    expect(added.match(/第8章 夜雨/g)).toHaveLength(1);
    expect(added).toContain("雨下了一夜，没有标题。");
  });

  it("splits the opening heading out of the reading body", () => {
    const split = splitChapterHeading("# 第八章 夜雨\n第八章 夜雨\n\n雨还在下。", 8);
    expect(split.title).toBe("第8章 夜雨");
    expect(split.body).toBe("雨还在下。");
    expect(split.body).not.toContain("第八章");
  });

  it("splits a same-chapter hash heading and a plain heading line", () => {
    const hashed = splitChapterHeading("# 第9章 立听不名\n\n正文…", 9);
    expect(hashed.title).toBe("第9章 立听不名");
    expect(hashed.body).toBe("正文…");
    const plain = splitChapterHeading("第9章 立听不名\n\n正文…", 9);
    expect(plain.title).toBe("第9章 立听不名");
    expect(plain.body).toBe("正文…");
  });

  it("keeps a different chapter number and a sentence that only starts like a heading", () => {
    const other = splitChapterHeading("# 第8章 立听不名\n\n正文…", 9);
    expect(other.title).toBe("");
    expect(other.body).toBe("# 第8章 立听不名\n\n正文…");
    const sentence = splitChapterHeading("第9章就出事了。\n\n正文…", 9);
    expect(sentence.title).toBe("");
    expect(sentence.body).toBe("第9章就出事了。\n\n正文…");
  });
});
