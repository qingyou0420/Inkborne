import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChapterManuscriptTable } from "./ChapterManuscriptTable";

describe("chapter table virtual window", () => {
  it("shows the chapters that belong at the middle and the bottom", () => {
    const chapters = Array.from({ length: 120 }, (_, index) => ({
      number: index + 1,
      title: `章${index + 1}`,
    }));
    const volumeMap = ["## 第1卷 上卷（1-60章）", "## 第2卷 下卷（61-120章）"].join("\n");
    const markup = (scrollTop: number) => renderToStaticMarkup(createElement(ChapterManuscriptTable, {
      chapters,
      nextChapter: 1,
      volumeMap,
      isZh: true,
      t: ((key: string) => key) as never,
      forceOpenAll: true,
      forcedScrollTop: scrollTop,
      forcedViewport: 480,
      renderChapter: (chapter: { number: number; title: string }) => createElement(
        "tr",
        { key: chapter.number, "data-chapter": chapter.number },
        createElement("td", null, String(chapter.number)),
      ),
    }));
    const numbers = (html: string) => [...html.matchAll(/data-chapter="(\d+)"/g)].map((match) => Number(match[1]));
    const middleHtml = markup(61 * 48);
    expect(middleHtml.indexOf("chapter-table-head")).toBeLessThan(middleHtml.indexOf("chapter-table-scroll"));
    const middle = numbers(middleHtml);
    expect(middle.length).toBeGreaterThan(0);
    expect(Math.min(...middle)).toBeGreaterThan(40);
    expect(Math.max(...middle)).toBeLessThan(90);
    expect(middle).not.toContain(1);
    expect(middle).not.toContain(120);
    const bottom = numbers(markup(122 * 48));
    expect(bottom).toContain(120);
    expect(bottom).not.toContain(1);
    expect(Math.min(...bottom)).toBeGreaterThan(90);
  });
});
