import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { singleChapterExportFileName } from "@actalk/inkos-core";
import { attachmentDisposition } from "../api/attachment-disposition";
import {
  bookManuscriptExportPath,
  continueShortPrompt,
  filenameFromContentDisposition,
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
    expect(bookManuscriptExportPath("harbor", "txt", true, {
      fromChapter: 2,
      toChapter: 8,
      layout: "per-chapter",
      blankLine: false,
      indent: true,
    })).toBe("/api/v1/books/harbor/export?format=txt&approvedOnly=true&from=2&to=8&layout=per-chapter&blankLine=0&indent=1");
    expect(bookManuscriptExportPath("harbor", "md", false, { fromChapter: 2, layout: "per-chapter" })).toBe(
      "/api/v1/books/harbor/export?format=md",
    );
    expect(shortManuscriptExportPath("明日来信", "txt")).toBe(
      `/api/v1/shorts/${encodeURIComponent("明日来信")}/export?format=txt`,
    );
    expect(shortManuscriptExportPath("明日来信", "txt", { fromChapter: 2, layout: "per-chapter" })).toBe(
      `/api/v1/shorts/${encodeURIComponent("明日来信")}/export?format=txt&from=2&layout=per-chapter`,
    );
    expect(bookManuscriptExportPath("harbor", "txt", true, {
      chapter: 3,
      fromChapter: 1,
      toChapter: 8,
      layout: "per-chapter",
      blankLine: false,
      indent: true,
    })).toBe("/api/v1/books/harbor/export?format=txt&approvedOnly=true&chapter=3&blankLine=0&indent=1");
    expect(bookManuscriptExportPath("harbor", "md", false, { chapter: 3, fromChapter: 2 })).toBe(
      "/api/v1/books/harbor/export?format=md&chapter=3",
    );
    expect(bookManuscriptExportPath("harbor", "epub", false, { chapter: 3 })).toBe(
      "/api/v1/books/harbor/export?format=epub&chapter=3",
    );
  });

  it("names a single exported chapter with the book, chapter number, and title", () => {
    expect(singleChapterExportFileName("夜港", 3, "夜雨", "txt")).toBe("夜港 第3章 夜雨.txt");
    expect(singleChapterExportFileName("夜港", 3, "", "md")).toBe("夜港 第3章 未命名.md");
    expect(singleChapterExportFileName("夜港", 3, "第3章 夜雨", "epub")).toBe("夜港 第3章 夜雨.epub");
    expect(singleChapterExportFileName("夜/港", 3, "雨:夜?", "txt")).toBe("夜 港 第3章 雨 夜.txt");
    expect(singleChapterExportFileName("", 3, "第3章", "txt")).toBe("书 第3章 未命名.txt");
  });

  it("keeps TXT layout fields and 复制本章 on the long and short flows", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const read = (rel: string) => readFileSync(join(src, rel), "utf8");
    const phrase = "番茄" + "纯文本";
    const bookDetail = read("pages/BookDetail.tsx");
    expect(bookDetail).not.toContain(phrase);
    expect(bookDetail).not.toContain("write-export-tools");
    expect(bookDetail).toContain("<ExportMenu");
    expect(read("components/FanqieExportFields.tsx")).toContain("段间空一行");
    expect(read("components/FanqieExportFields.tsx")).toContain("段首空两格");
    expect(read("components/FanqieExportFields.tsx")).toContain("贴进番茄");
    expect(read("pages/ChapterReader.tsx")).toContain("复制本章");
    expect(read("pages/ChapterReader.tsx")).toContain("chapter-copy-plain");
    expect(read("pages/ChapterReader.tsx")).not.toContain("chapter-copy-fanqie");
    const panel = read("components/AuthoringWritePanel.tsx");
    expect(panel).toContain("write-copy-chapter");
    expect(panel).toContain("复制本章");
    const bar = panel.slice(panel.indexOf('data-testid="write-action-bar"'));
    const edit = bar.indexOf("编辑");
    const review = bar.indexOf("审查");
    const adopt = bar.indexOf("采用");
    const exported = bar.indexOf("导出");
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(review).toBeGreaterThan(edit);
    expect(adopt).toBeGreaterThan(review);
    expect(exported).toBeGreaterThan(adopt);
    expect(read("pages/ShortReader.tsx")).toContain("short-copy-plain");
    expect(read("pages/ShortReader.tsx")).toContain("short-fanqie-export");
    expect(read("pages/ShortReader.tsx")).toContain("下载 TXT");
    expect(read("pages/ShortReader.tsx")).not.toContain(phrase);
    expect(read("pages/Dashboard.tsx")).not.toContain("book-export-fanqie-");
    expect(read("pages/Dashboard.tsx")).not.toContain("short-export-fanqie-");
    expect(read("pages/ShortSettings.tsx")).not.toContain("short-settings-fanqie");
  });

  it("does not leave the old plain-text label visible under packages", () => {
    const phrase = "番茄" + "纯文本";
    const packagesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    expect(filesContaining(packagesRoot, phrase)).toEqual([]);
  });

  it("reads a download filename from Content-Disposition", () => {
    const chinese = "夜港 第3章 夜雨.txt";
    const header = `attachment; filename="_.txt"; filename*=UTF-8''${encodeURIComponent(chinese)}`;
    expect(filenameFromContentDisposition(header, "第3章.txt")).toBe(chinese);
    expect(filenameFromContentDisposition(attachmentDisposition(chinese), "第3章.txt")).toBe(chinese);
    expect(filenameFromContentDisposition('attachment; filename="harbor.txt"', "第3章.txt")).toBe("harbor.txt");
    expect(filenameFromContentDisposition("attachment", "第3章.txt")).toBe("第3章.txt");
    expect(filenameFromContentDisposition(null, "第3章.txt")).toBe("第3章.txt");
    const broken = "attachment; filename*=UTF-8''%ZZ; filename=\"harbor.txt\"";
    expect(() => filenameFromContentDisposition(broken, "第3章.txt")).not.toThrow();
    expect(filenameFromContentDisposition(broken, "第3章.txt")).toBe("harbor.txt");
    expect(() => filenameFromContentDisposition("attachment; filename*=UTF-8''%E4%B8", "第3章.txt")).not.toThrow();
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''%E4%B8", "第3章.txt")).toBe("第3章.txt");
  });

  it("strips markdown chrome for 导出原文 txt", () => {
    expect(manuscriptToPlainText("# 标题\n\n**加粗** 和 *斜体*\n\n- 一句")).toBe("标题\n\n加粗 和 斜体\n\n一句");
  });

  it("keeps a continue-writing prompt that names the existing short", () => {
    expect(continueShortPrompt("电梯多一层", "elevator").zh).toContain("elevator");
    expect(continueShortPrompt("电梯多一层", "elevator").zh).toContain("电梯多一层");
  });
});

function filesContaining(dir: string, phrase: string): string[] {
  const hits: string[] = [];
  const skip = new Set(["node_modules", "dist", "coverage", ".git"]);
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|css|md|json|html)$/.test(entry.name)) continue;
      if (readFileSync(full, "utf8").includes(phrase)) hits.push(full);
    }
  };
  walk(dir);
  return hits;
}

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
