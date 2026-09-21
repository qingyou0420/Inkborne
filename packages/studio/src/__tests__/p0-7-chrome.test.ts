/**
 * P0-7 source contracts: chrome 上提、页头收口、按钮三级、对话框 / 抽屉。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldInvalidateBookStageEvent } from "../hooks/use-book-stage";

const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(rel: string): string {
  return readFileSync(join(studioRoot, rel), "utf8");
}

describe("P0-7 chrome lift", () => {
  it("renders BookWorkspaceNav once in the App header and drops page-local chrome", () => {
    const app = read("src/App.tsx");
    expect(app).toMatch(/BookWorkspaceNav/);
    expect(app).toMatch(/deriveBookChromeTab/);
    expect(app).toMatch(/shouldInvalidateBookStageEvent/);
    expect(app).toMatch(/invalidationPathsForChapterMutationSse/);
    expect(app).toMatch(/invalidationPathsForAuthoringRunSse/);
    expect(app).toMatch(/max-w-\[880px\]/);
    expect(app).toMatch(/max-w-\[1200px\]/);
    for (const file of [
      "src/pages/BookStudy.tsx",
      "src/pages/BookAskPage.tsx",
      "src/pages/BookGround.tsx",
      "src/pages/OutlineWorkspace.tsx",
      "src/pages/BookDetail.tsx",
    ]) {
      expect(read(file)).not.toMatch(/<BookWorkspaceNav/);
    }
  });

  it("unifies system headers: no breadcrumbs, 32px serif, no h1 icons", () => {
    const pages = [
      "src/pages/AuthorPage.tsx",
      "src/pages/LogViewer.tsx",
      "src/pages/DaemonControl.tsx",
      "src/pages/ProjectSettings.tsx",
      "src/pages/CheckUpdate.tsx",
      "src/pages/ServiceListPage.tsx",
      "src/pages/GenreManager.tsx",
      "src/pages/StyleManager.tsx",
      "src/pages/TruthFiles.tsx",
      "src/pages/ChapterReader.tsx",
    ];
    for (const file of pages) {
      const src = read(file);
      expect(src).not.toMatch(/bread\.home/);
      expect(src).not.toMatch(/bread\.books/);
    }
    expect(read("src/pages/ProjectSettings.tsx")).not.toMatch(/Settings2/);
    expect(read("src/pages/CheckUpdate.tsx")).not.toMatch(/RefreshCw size=\{28\}/);
    const groundPage = read("src/pages/BookGround.tsx");
    expect(groundPage).toMatch(/AuthoringGroundPanel/);
    expect(groundPage).not.toMatch(/text-\[32px\]/);
    expect(read("src/pages/BookStudy.tsx")).toMatch(/text-\[32px\]/);
    const writePage = read("src/pages/BookDetail.tsx");
    expect(writePage).not.toMatch(/text-\[32px\]/);
    expect(writePage).toMatch(/AuthoringWritePanel/);
    expect(writePage.indexOf("<AuthoringWritePanel")).toBeLessThan(writePage.indexOf('<details className="write-legacy"'));
  });
});

describe("P0-7 dialogs and buttons", () => {
  it("lands three-tier buttons and a themed drawer primitive", () => {
    const css = read("src/index.css");
    const button = read("src/components/ui/button.tsx");
    expect(css).toMatch(/\.btn-primary/);
    expect(css).toMatch(/\.btn-secondary/);
    expect(css).toMatch(/\.btn-ghost/);
    expect(css).toMatch(/\.fade-in-150/);
    expect(button).toMatch(/primary:/);
    expect(existsSync(join(studioRoot, "src/components/ui/drawer.tsx"))).toBe(true);
    const drawer = read("src/components/ui/drawer.tsx");
    expect(drawer).toMatch(/Escape/);
    expect(drawer).toMatch(/max-w-\[420px\]/);
    expect(drawer).toMatch(/text-\[18px\]/);
    expect(drawer).toMatch(/bg-foreground\/20/);
    expect(read("src/components/BookSettingsDrawer.tsx")).toMatch(/<Drawer/);
    expect(read("src/components/BookToolsDrawer.tsx")).toMatch(/<Drawer/);
  });

  it("drops ConfirmDialog shadow, X, and side-slide; reuses it for rename", () => {
    const dialog = read("src/components/ConfirmDialog.tsx");
    expect(dialog).not.toMatch(/shadow-2xl/);
    expect(dialog).not.toMatch(/chat-msg-assistant/);
    expect(dialog).not.toMatch(/<X /);
    expect(dialog).toMatch(/fade-in-150/);
    expect(dialog).toMatch(/text-destructive-foreground|btn-danger/);
    const sidebar = read("src/components/Sidebar.tsx");
    expect(sidebar).toMatch(/nav\.renameAsk/);
    expect(sidebar).not.toMatch(/from "\.\/ui\/dialog"/);
    expect(sidebar).toMatch(/session-rename-input/);
  });

  it("moves short delete into ShortSettings and unifies empty states", () => {
    expect(read("src/pages/ShortReader.tsx")).not.toMatch(/short-danger-zone/);
    expect(read("src/pages/ShortSettings.tsx")).toMatch(/short-danger-zone/);
    const empty = read("src/components/LiteraryEmpty.tsx");
    expect(empty).toMatch(/text-2xl/);
    expect(empty).toMatch(/btn-primary/);
    expect(empty).not.toMatch(/border-border/);
    expect(read("src/pages/OutlineWorkspace.tsx")).toMatch(/LiteraryEmpty/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/LiteraryEmpty/);
    expect(read("src/pages/LogViewer.tsx")).toMatch(/LiteraryEmpty/);
    expect(read("src/pages/TruthFiles.tsx")).toMatch(/LiteraryEmpty/);
    expect(read("src/hooks/use-i18n.ts")).not.toMatch(/暂无文件/);
  });

  it("invalidates shared /stage on write/weave/book SSE but ignores progress", () => {
    expect(shouldInvalidateBookStageEvent("write:complete")).toBe(true);
    expect(shouldInvalidateBookStageEvent("rewrite:complete")).toBe(true);
    expect(shouldInvalidateBookStageEvent("revise:complete")).toBe(true);
    expect(shouldInvalidateBookStageEvent("weave:complete")).toBe(true);
    expect(shouldInvalidateBookStageEvent("book:deleted")).toBe(true);
    expect(shouldInvalidateBookStageEvent("truth:written")).toBe(true);
    expect(shouldInvalidateBookStageEvent("weave:progress")).toBe(false);
    expect(shouldInvalidateBookStageEvent("book:creating")).toBe(false);
    expect(shouldInvalidateBookStageEvent("session:title")).toBe(false);
  });

  it("refreshes the open chapter body after rewrite SSE", () => {
    expect(read("src/pages/ChapterReader.tsx")).toMatch(/shouldRefetchChapterBody/);
    expect(read("src/pages/ChapterReader.tsx")).toMatch(/handleChapterChanged/);
    expect(read("src/components/ChapterWorkspacePanel.tsx")).toMatch(/postApi\(`\/books\/\$\{bookId\}\/rewrite/);
  });
});
