import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bookManuscriptExportPath,
  continueShortPrompt,
  manuscriptToPlainText,
  shortManuscriptExportPath,
} from "./work-export";
import {
  SIDEBAR_CREATE_ITEM_KEYS,
  SIDEBAR_SECTION_ORDER,
  SIDEBAR_SYSTEM_ITEM_KEYS,
  SIDEBAR_TOOL_ITEM_KEYS,
} from "./sidebar-create-items";

describe("manuscript export helpers", () => {
  it("builds book and short 原文 download paths", () => {
    expect(bookManuscriptExportPath("harbor")).toBe("/api/v1/books/harbor/export?format=txt");
    expect(bookManuscriptExportPath("harbor", "md", true)).toBe(
      "/api/v1/books/harbor/export?format=md&approvedOnly=true",
    );
    expect(shortManuscriptExportPath("明日来信")).toBe(
      `/api/v1/shorts/${encodeURIComponent("明日来信")}/export?format=txt`,
    );
    expect(shortManuscriptExportPath("elevator", "md")).toBe("/api/v1/shorts/elevator/export?format=md");
    expect(bookManuscriptExportPath("harbor", "fanqie", true, {
      fromChapter: 2,
      toChapter: 8,
      layout: "per-chapter",
      blankLine: false,
      indent: true,
    })).toBe("/api/v1/books/harbor/export?format=fanqie&approvedOnly=true&from=2&to=8&layout=per-chapter&blankLine=0&indent=1");
    expect(shortManuscriptExportPath("明日来信", "fanqie")).toBe(
      `/api/v1/shorts/${encodeURIComponent("明日来信")}/export?format=fanqie`,
    );
  });

  it("puts 番茄纯文本 and 复制本章 on the long and short flows", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const read = (rel: string) => readFileSync(join(src, rel), "utf8");
    expect(read("pages/BookDetail.tsx")).toContain("番茄纯文本");
    expect(read("pages/BookDetail.tsx")).toContain("FanqieExportFields");
    expect(read("components/FanqieExportFields.tsx")).toContain("段间空一行");
    expect(read("components/FanqieExportFields.tsx")).toContain("段首空两格");
    expect(read("pages/ChapterReader.tsx")).toContain("复制本章");
    expect(read("pages/ChapterReader.tsx")).toContain("chapter-copy-plain");
    expect(read("components/AuthoringWritePanel.tsx")).toContain("write-copy-chapter");
    expect(read("components/AuthoringWritePanel.tsx")).toContain("复制本章");
    expect(read("pages/ShortReader.tsx")).toContain("short-copy-plain");
    expect(read("pages/ShortReader.tsx")).toContain("番茄纯文本");
    expect(read("pages/Dashboard.tsx")).toContain("book-export-fanqie-");
    expect(read("pages/ShortSettings.tsx")).toContain("short-settings-fanqie");
  });

  it("strips markdown chrome for 导出原文 txt", () => {
    expect(manuscriptToPlainText("# 标题\n\n**加粗** 和 *斜体*\n\n- 一句")).toBe("标题\n\n加粗 和 斜体\n\n一句");
  });

  it("keeps a continue-writing prompt that names the existing short", () => {
    expect(continueShortPrompt("电梯多一层", "elevator").zh).toContain("elevator");
    expect(continueShortPrompt("电梯多一层", "elevator").zh).toContain("电梯多一层");
  });
});

describe("sidebar create items", () => {
  it("only exposes long novel and short story", () => {
    expect([...SIDEBAR_CREATE_ITEM_KEYS]).toEqual(["nav.createNovel", "nav.createShort"]);
  });

  it("binds tools and system items in 清游 order", () => {
    expect([...SIDEBAR_SECTION_ORDER]).toEqual(["author", "create", "sessions", "tools", "system"]);
    expect([...SIDEBAR_TOOL_ITEM_KEYS]).toEqual(["nav.style", "nav.genreTemplates"]);
    expect([...SIDEBAR_SYSTEM_ITEM_KEYS]).toEqual([
      "nav.config",
      "nav.projectSettings",
      "nav.authorProfile",
      "nav.daemon",
      "nav.logs",
      "nav.checkUpdate",
    ]);
  });
});
