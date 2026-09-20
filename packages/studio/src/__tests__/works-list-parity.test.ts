import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SIDEBAR_CREATE_ITEM_KEYS,
  SIDEBAR_SECTION_ORDER,
  SIDEBAR_SYSTEM_ITEM_KEYS,
  SIDEBAR_TOOL_ITEM_KEYS,
} from "../lib/sidebar-create-items";

const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(rel: string): string {
  return readFileSync(join(studioRoot, rel), "utf8");
}

function sectionIndex(source: string, marker: string): number {
  const index = source.indexOf(marker);
  expect(index).toBeGreaterThan(-1);
  return index;
}

describe("sidebar create block", () => {
  it("temporarily keeps only 长篇 and 短篇", () => {
    const sidebar = read("src/components/Sidebar.tsx");
    const createBlock = sidebar.slice(
      sidebar.indexOf("nav.createSection"),
      sidebar.indexOf("nav.history"),
    );

    expect(SIDEBAR_CREATE_ITEM_KEYS).toEqual(["nav.createNovel", "nav.createShort"]);
    expect(createBlock).toMatch(/sidebar-create-list/);
    expect(createBlock).toMatch(/SIDEBAR_CREATE_ITEM_KEYS/);
    expect(createBlock).toMatch(/sidebar-create-novel/);
    expect(createBlock).toMatch(/sidebar-create-short/);
    expect(createBlock).toMatch(/nav\.createNovel/);
    expect(createBlock).not.toMatch(/nav\.createScript/);
    expect(createBlock).not.toMatch(/nav\.createStoryboard/);
    expect(createBlock).not.toMatch(/nav\.createInteractiveFilm/);
    expect(createBlock).not.toMatch(/nav\.createFanfic/);
    expect(createBlock).not.toMatch(/nav\.createSpinoff/);
    expect(createBlock).not.toMatch(/nav\.createImitation/);
    expect(createBlock).not.toMatch(/nav\.createContinuation/);
    expect(createBlock).not.toMatch(/nav\.createTranslation/);
    expect(createBlock).not.toMatch(/nav\.createBranching/);
    expect(createBlock).not.toMatch(/nav\.createFree/);
  });

  it("renders left-nav sections in 清游 order with the bound items", () => {
    const sidebar = read("src/components/Sidebar.tsx");
    const i18n = read("src/hooks/use-i18n.ts");

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

    const author = sectionIndex(sidebar, "sidebar-author");
    const create = sectionIndex(sidebar, "nav.createSection");
    const sessions = sectionIndex(sidebar, "nav.history");
    const tools = sectionIndex(sidebar, "nav.tools");
    const system = sectionIndex(sidebar, "nav.system");
    expect(author).toBeLessThan(create);
    expect(create).toBeLessThan(sessions);
    expect(sessions).toBeLessThan(tools);
    expect(tools).toBeLessThan(system);

    expect(i18n).toMatch(/"nav\.createSection": \{ zh: "开始创作"/);
    expect(i18n).toMatch(/"nav\.history": \{ zh: "问心记录"/);
    expect(i18n).toMatch(/"nav\.signYourName": \{ zh: "署上你的名字"/);
    expect(i18n).toMatch(/"dash\.title": \{ zh: "书架"/);
    expect(i18n).toMatch(/"nav\.tools": \{ zh: "工具"/);
    expect(i18n).toMatch(/"nav\.system": \{ zh: "设置"/);
    expect(i18n).toMatch(/"nav\.style": \{ zh: "文风学习"/);
    expect(i18n).toMatch(/"nav\.genreTemplates": \{ zh: "题材模板"/);
    expect(i18n).toMatch(/"nav\.logs": \{ zh: "实时动态"/);
    expect(i18n).toMatch(/"nav\.daemon": \{ zh: "守护进程"/);
    expect(i18n).toMatch(/"nav\.authorProfile": \{ zh: "资料设置"/);
    expect(i18n).toMatch(/"nav\.newAsk": \{ zh: "新开会话"/);
    expect(i18n).toMatch(/"nav\.newAskPlaceholder": \{ zh: "新的会话"/);
    expect(sidebar).toMatch(/nav\.newAskPlaceholder/);
    expect(sidebar).not.toMatch(/\bdot=/);
    expect(sidebar).toMatch(/Activity/);
    expect(sidebar).toMatch(/toDashboard/);
    expect(sidebar).not.toMatch(/sidebar-works-list/);
    expect(sidebar).not.toMatch(/nav\.myBooks/);
  });

  it("hides film leftovers, import, and doctor from the left menu without deleting the features", () => {
    const sidebar = read("src/components/Sidebar.tsx");
    const toolsBlock = sidebar.slice(sidebar.indexOf("nav.tools"), sidebar.indexOf("nav.system"));
    const systemBlock = sidebar.slice(sidebar.indexOf("nav.system"), sidebar.indexOf("sidebar-brand"));

    expect(sidebar).not.toMatch(/film-projects-section/);
    expect(sidebar).not.toMatch(/nav\.createInteractiveFilm/);
    expect(sidebar).not.toMatch(/refetchFilms/);
    expect(existsSync(join(studioRoot, "src/pages/FilmWizard.tsx"))).toBe(true);
    expect(existsSync(join(studioRoot, "src/pages/ImportManager.tsx"))).toBe(true);
    expect(existsSync(join(studioRoot, "src/pages/DoctorView.tsx"))).toBe(true);
    expect(existsSync(join(studioRoot, "src/pages/TranslationManager.tsx"))).toBe(true);
    expect(existsSync(join(studioRoot, "src/pages/RadarView.tsx"))).toBe(true);

    expect(toolsBlock).toMatch(/nav\.style/);
    expect(toolsBlock).toMatch(/nav\.genreTemplates/);
    expect(toolsBlock).not.toMatch(/nav\.import/);
    expect(toolsBlock).not.toMatch(/nav\.doctor/);
    expect(toolsBlock).not.toMatch(/nav\.translation/);
    expect(toolsBlock).not.toMatch(/nav\.radar/);

    expect(systemBlock).toMatch(/nav\.config/);
    expect(systemBlock).toMatch(/nav\.projectSettings/);
    expect(systemBlock).toMatch(/nav\.checkUpdate/);
    expect(systemBlock).toMatch(/nav\.daemon/);
    expect(systemBlock).toMatch(/nav\.logs/);
    expect(systemBlock).toMatch(/nav\.authorProfile/);
    expect(systemBlock).not.toMatch(/create\.genre/);
    expect(systemBlock).not.toMatch(/nav\.genreTemplates/);
    expect(sidebar).not.toMatch(/nav\.agentOnline/);
  });

  it("opens covers at the remembered stage and keeps shorts reachable", () => {
    const dashboard = read("src/pages/Dashboard.tsx");
    expect(dashboard).toMatch(/goBookStage\(nav, book.id, stage\)/);
    expect(dashboard).toMatch(/bookResumeStage/);
    expect(dashboard).toMatch(/nav\.toShort\(short\.id\)/);
    expect(dashboard).not.toMatch(/toBookChat/);
    expect(dashboard).not.toMatch(/write-next/);
  });
});

describe("works list long/short parity", () => {
  it("labels novels by current stage and preserves the short-fiction label", () => {
    const dashboard = read("src/pages/Dashboard.tsx");
    const i18n = read("src/hooks/use-i18n.ts");

    expect(i18n).toMatch(/"home\.typeSerial": \{ zh: "连载"/);
    expect(i18n).toMatch(/"short\.badge": \{ zh: "短篇"/);
    expect(dashboard).toMatch(/STAGE_LABELS\[stage\]/);
    expect(dashboard).toMatch(/短篇/);
  });

  it("gives shorts the same cover-menu actions as books", () => {
    const dashboard = read("src/pages/Dashboard.tsx");
    expect(dashboard).toMatch(/home-short-menu-/);
    expect(dashboard).toMatch(/short-export-manuscript-/);
    expect(dashboard).toMatch(/short-delete-/);
    expect(dashboard).toMatch(/nav\.toShort\(short.id\)/);
    expect(dashboard).toMatch(/nav\.toShortSettings\(short.id\)/);
    expect(dashboard).toMatch(/导出正文/);
    expect(dashboard).toMatch(/shortManuscriptExportPath/);
    expect(dashboard).not.toMatch(/\/books\/\$\{short/);
  });

  it("labels export as 导出 for books and shorts", () => {
    const i18n = read("src/hooks/use-i18n.ts");
    const dashboard = read("src/pages/Dashboard.tsx");
    const bookDetail = read("src/pages/BookDetail.tsx");
    const exportMenu = read("src/components/ExportMenu.tsx");

    expect(i18n).toMatch(/"book\.export": \{ zh: "导出"/);
    expect(i18n).toMatch(/"book\.exportSave": \{ zh: "保存到项目"/);
    expect(dashboard).toMatch(/bookManuscriptExportPath/);
    expect(dashboard).toMatch(/shortManuscriptExportPath/);
    expect(bookDetail).toMatch(/ExportMenu/);
    expect(exportMenu).toMatch(/book-export-manuscript/);
    expect(exportMenu).toMatch(/book\.exportSave/);
  });
});

describe("works list delete refresh", () => {
  it("drops a deleted short like 明日来信 from the home shelf via short DELETE", () => {
    const dashboard = read("src/pages/Dashboard.tsx");

    expect(dashboard).toMatch(/deleteStudioShortWork/);
    expect(dashboard).toMatch(/selectWorksListShorts/);
    expect(dashboard).toMatch(/removeShortFromCollection/);
    expect(dashboard).not.toMatch(/\/books\/\$\{short/);
    expect(dashboard).not.toMatch(/\/books\/\$\{encodeURIComponent\(short/);
  });

  it("drops a deleted book from the home shelf immediately", () => {
    const dashboard = read("src/pages/Dashboard.tsx");
    const settings = read("src/components/BookSettingsDrawer.tsx");
    const nav = read("src/components/AppMoreMenu.tsx");

    expect(dashboard).toMatch(/removeBookFromCollection/);
    expect(dashboard).toMatch(/bumpBookDataVersion/);
    expect(dashboard).toMatch(/method: "DELETE"/);
    expect(dashboard).toMatch(/home-book-delete-/);

    expect(settings).toMatch(/method: "DELETE"/);
    expect(settings).toMatch(/book-danger-zone/);
    expect(nav).toMatch(/bumpBookDataVersion/);
    expect(settings).not.toMatch(/fetch\(`\/api\/v1\/books/);
  });
});
