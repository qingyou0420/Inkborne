/** SPDX-License-Identifier: AGPL-3.0-only */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookSettingsDrawer } from "./BookSettingsDrawer";
import { buildBookSettingsUpdate } from "./book-settings-state";

const state = vi.hoisted(() => ({
  reads: [] as string[],
  authoringBook: true as boolean | undefined,
  bookLoading: false,
  workspaceLoading: false,
  bookError: null as string | null,
  workspaceError: null as string | null,
}));

vi.mock("./ui/drawer", () => ({
  Drawer: ({ open, children }: { open: boolean; children: ReactNode }) => open ? createElement("div", null, children) : null,
}));
vi.mock("../store/chat", () => ({
  useChatStore: { getState: () => ({ bumpBookDataVersion: vi.fn() }) },
}));
vi.mock("../hooks/use-api", () => ({
  fetchJson: vi.fn(),
  invalidateApiPaths: vi.fn(),
  useApi: (path: string) => {
    state.reads.push(path);
    const refetch = async () => {};
    if (path.startsWith("/books/")) return {
      data: { book: { title: "灯下归舟", chapterWordCount: 4400, targetChapters: 123, status: "paused" } },
      loading: state.bookLoading, error: state.bookError, refetch,
    };
    return { data: { authoringBook: state.authoringBook }, loading: state.workspaceLoading, error: state.workspaceError, refetch };
  },
}));

const noop = () => {};
const props = { bookId: "book a", open: true, onClose: noop, onDeleted: noop, onEditLength: noop, isZh: true, t: (key: string) => key };
const render = (open = true) => renderToStaticMarkup(createElement(BookSettingsDrawer, { ...props, open }));

beforeEach(() => {
  state.reads = [];
  state.authoringBook = true;
  state.bookLoading = false;
  state.workspaceLoading = false;
  state.bookError = null;
  state.workspaceError = null;
});

describe("book settings authority", () => {
  it("only sends status for four-stage books even when a draft contains stale length values", () => {
    expect(buildBookSettingsUpdate(true, { status: "completed", chapterWordCount: 8000, targetChapters: 999 })).toEqual({ status: "completed" });
    expect(buildBookSettingsUpdate(true, { status: "paused", chapterWordCount: NaN, targetChapters: 0 })).toEqual({ status: "paused" });
  });

  it("keeps legacy length updates and rejects invalid lengths", () => {
    const draft = { status: "active" as const, chapterWordCount: 4400, targetChapters: 123 };
    expect(buildBookSettingsUpdate(false, draft)).toEqual(draft);
    for (const chapterWordCount of [NaN, 0, 99, 100.5]) expect(buildBookSettingsUpdate(false, { ...draft, chapterWordCount })).toBeNull();
    for (const targetChapters of [0, -1, 1.5]) expect(buildBookSettingsUpdate(false, { ...draft, targetChapters })).toBeNull();
  });

  it("routes new-book length to Ask and retains status and deletion", () => {
    const html = render();
    expect(state.reads).toEqual(["/books/book%20a", "/authoring/workspace?bookId=book%20a&summary=1"]);
    expect(html).toContain("去问心修改篇幅");
    expect(html).not.toContain('type="number"');
    expect(html).toContain('value="paused" selected=""');
    expect(html).toContain('data-testid="book-danger-zone"');
    expect(html).toMatch(/data-testid="book-delete-confirm" disabled=""/);
  });

  it("keeps existing lengths editable for legacy workspace responses without an authoring flag", () => {
    state.authoringBook = undefined;
    const html = render();
    expect(html.match(/type="number"/g)).toHaveLength(2);
    expect(html).toContain('value="4400"');
    expect(html).toContain('value="123"');
    expect(html).not.toContain("去问心修改篇幅");
  });

  it.each(["book", "workspace"] as const)("does not expose retained form data while %s is loading", (kind) => {
    state[`${kind}Loading`] = true;
    const html = render();
    expect(html).toContain("正在读取作品设置");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("book.save");
  });

  it.each(["book", "workspace"] as const)("shows %s read errors and retry instead of editable defaults", (kind) => {
    state[`${kind}Error`] = "书稿读取失败";
    const html = render();
    expect(html).toContain("书稿读取失败");
    expect(html).toContain("重新读取作品设置");
    expect(html).not.toContain("book.save");
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain("book-delete-confirm");
  });

  it("does not load book settings while the drawer is closed", () => {
    expect(render(false)).toBe("");
    expect(state.reads).toEqual([]);
  });
});
