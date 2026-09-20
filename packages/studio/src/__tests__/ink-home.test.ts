import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StudioHeader, type StudioHeaderNav } from "../components/StudioHeader";
import { NewBookIntro } from "../components/NewBookIntro";
import { BookWorkspaceNav } from "../components/BookWorkspaceNav";
import type { TFunction } from "../hooks/use-i18n";

const noop = () => {};
const nav: StudioHeaderNav = {
  toDashboard: noop, toServices: noop, toProjectSettings: noop, toAuthor: noop,
  toChat: noop, toAsk: noop, toBookCreate: noop, toDaemon: noop, toLogs: noop,
  toGenres: noop, toStyle: noop, toTranslation: noop, toImport: noop, toRadar: noop,
  toDoctor: noop, toCheckUpdate: noop, toAnalytics: noop, toFilmStudio: noop,
};
const t = ((key: string) => key) as TFunction;
describe("ink home rendered hierarchy", () => {
  it("renders only the brand and a single global configuration trigger", () => {
    const html = renderToStaticMarkup(createElement(StudioHeader, { nav, t, isZh: true, isDark: false, onToggleTheme: noop, studyCurrent: true, sse: { messages: [] } }));
    expect((html.match(/<button\b/g) ?? []).length).toBe(2);
    expect(html).toContain("墨生万象");
    expect(html).toContain('aria-label="配置"');
    expect(html).not.toContain('data-testid="nav-study"');
    expect(html).not.toContain("theme-top");
  });
  it("presents the user's exact introduction and one creative action", () => {
    const html = renderToStaticMarkup(createElement(NewBookIntro, { isZh: true, onEnterAsk: noop }));
    expect(html).toContain("以墨问心，你想写一个什么样的故事？");
    expect(html).toContain("讨论故事框架，整理正典，才能进入设定、大纲与正文创作");
    expect(html).toContain("问心 · 研墨 · 织卷 · 落笔");
    expect(html).toContain("署上你的名字");
    expect(html).toContain("上传设置头像");
    expect((html.match(/data-testid="intro-enter-ask"/g) ?? []).length).toBe(1);
    expect(html).not.toMatch(/导入作品|新建作品|开始问心/);
  });
  it("uses a single accessible stage strip without repeated model or home controls", () => {
    const html = renderToStaticMarkup(createElement(BookWorkspaceNav, {
      bookId: "潮声未寄", active: "weave", isZh: true, t,
      nav: { toAsk: noop, toBook: noop, toOutline: noop, toBookSettings: noop },
      stage: { steps: { ask: "done", ground: "done", weave: "current", write: "todo" } },
    }));
    expect((html.match(/data-testid="book-step-/g) ?? []).length).toBe(4);
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
    expect(html).toContain('data-testid="book-overview-link"');
    expect(html).not.toMatch(/创作模型|审查模型|返回书房/);
  });

  it("puts aria-current on the book title when the overview is open", () => {
    const html = renderToStaticMarkup(createElement(BookWorkspaceNav, {
      bookId: "潮声未寄", active: "study", isZh: true, t,
      nav: { toAsk: noop, toBook: noop, toOutline: noop, toBookSettings: noop },
      stage: { steps: { ask: "done", ground: "done", weave: "todo", write: "todo" } },
    }));
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/data-testid="book-overview-link"[^>]*aria-current="page"/);
    expect(html).not.toMatch(/data-testid="book-step-[^"]+"[^>]*aria-current="page"/);
  });
});
