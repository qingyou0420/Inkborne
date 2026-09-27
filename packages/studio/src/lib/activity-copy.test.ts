import { describe, expect, it } from "vitest";
import { deriveActivityHeadline, formatActivityEvent, isActivityEvent } from "./activity-copy";

const books = [{ id: "zui", title: "醉词" }];

describe("activity-copy", () => {
  it("accepts the live-feed whitelist and drops noise", () => {
    expect(isActivityEvent("write:start")).toBe(true);
    expect(isActivityEvent("llm:progress")).toBe(true);
    expect(isActivityEvent("tool:start")).toBe(true);
    expect(isActivityEvent("ping")).toBe(false);
    expect(isActivityEvent("session:title")).toBe(false);
  });

  it("renders write/weave/tool events as author-facing sentences", () => {
    const write = formatActivityEvent(
      { event: "write:start", data: { bookId: "zui", chapterNumber: 3 }, timestamp: Date.parse("2026-09-06T14:02:00") },
      books,
      true,
    );
    expect(write?.bookTitle).toBe("醉词");
    expect(write?.text).toBe("落笔 · 第 3 章 起草中");
    expect(write?.text).not.toMatch(/write:start/);

    const progress = formatActivityEvent(
      { event: "llm:progress", data: { bookId: "zui", totalChars: 1240 }, timestamp: Date.now() },
      books,
      true,
    );
    expect(progress?.text).toContain("1,240 字");
    expect(progress?.text).not.toMatch(/llm:progress/);

    const weave = formatActivityEvent(
      { event: "weave:complete", data: { bookId: "zui" }, timestamp: Date.now() },
      books,
      true,
    );
    expect(weave?.text).toBe("织卷完成");

    const tool = formatActivityEvent(
      { event: "tool:start", data: { bookId: "zui", tool: "写入真相文件" }, timestamp: Date.now() },
      books,
      true,
    );
    expect(tool?.text).toBe("问心 · 工具「写入真相文件」");

    const en = formatActivityEvent(
      { event: "write:complete", data: { bookId: "zui", chapterNumber: 3, wordCount: 800 }, timestamp: Date.now() },
      books,
      false,
    );
    expect(en?.text).toMatch(/Writing · ch\. 3 done/);
    expect(en?.text).not.toMatch(/write:complete/);
  });

  it("derives a live headline from the newest start event", () => {
    expect(deriveActivityHeadline([], books, true)).toBe("引擎空闲");
    expect(deriveActivityHeadline(
      [{ event: "write:start", data: { bookId: "zui", chapterNumber: 3 } }],
      books,
      true,
    )).toBe("正在写《醉词》第 3 章");
    expect(deriveActivityHeadline(
      [{ event: "weave:start", data: { bookId: "zui" } }],
      books,
      false,
    )).toBe("Weaving “醉词”");
  });
});
