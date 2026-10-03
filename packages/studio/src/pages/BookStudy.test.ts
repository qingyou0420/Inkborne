/** SPDX-License-Identifier: AGPL-3.0-only */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { AuthoringWorkspace } from "../lib/authoring-workspace";
import { BookStudy } from "./BookStudy";

const state = vi.hoisted(() => ({
  workspace: null as AuthoringWorkspace | null,
  loading: false,
  error: null as string | null,
}));

vi.mock("../hooks/use-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hooks/use-api")>(),
  useApi: (path: string) => {
    const base = { loading: false, error: null, refetch: async () => {} };
    if (path.startsWith("/authoring/workspace")) {
      return { ...base, data: state.workspace, loading: state.loading, error: state.error };
    }
    if (path === "/books/test") {
      return { ...base, data: {
        book: { id: "test", title: "灯下归舟", genre: "奇幻", status: "active", language: "zh" },
        chapters: [], nextChapter: 1,
      } };
    }
    return { ...base, data: null };
  },
}));

vi.mock("../hooks/use-book-stage", () => ({
  useBookStage: () => ({ steps: { ask: "done", ground: "done", weave: "current", write: "locked" }, workflow: {} }),
}));

const noop = () => {};
const props: ComponentProps<typeof BookStudy> = {
  bookId: "test", theme: "light", t: (key) => key, sse: { messages: [] },
  nav: {
    toDashboard: noop, toChapter: noop, toTruth: noop, toBook: noop,
    toAsk: noop, toOutline: noop, toBookSettings: noop,
  },
};

function groundMarkup(): string {
  const html = renderToStaticMarkup(createElement(BookStudy, props));
  return html.split('data-testid="study-step-ground"')[1]?.split("</li>")[0] ?? "";
}

beforeEach(() => {
  state.loading = false;
  state.error = null;
  state.workspace = {
    authoringBook: true,
    catalog: { categories: ["主要人物", "世界"], entries: [
      { id: "lin", category: "主要人物", name: "林舟", file: "story/settings/主要人物/林舟.md", adoptedArtifactId: "lin-1" },
      { id: "river", category: "世界", name: "河港", file: "story/settings/世界/河港.md" },
    ] },
    manifest: { coverage: { settingsAdopted: 0, settingsTarget: 9 } },
  };
});

it("renders the catalog's adopted person and progress in the actual overview row", () => {
  const html = groundMarkup();
  expect(html).toContain("设定部分采用 1/2 · 1 位已采用人物");
  expect(html).not.toContain("设定未定稿");
  expect(html).not.toContain("0/9");
});

it("does not display retained previous-book counts while the workspace is loading", () => {
  state.loading = true;
  expect(groundMarkup()).toContain("正在读取设定…");
  expect(groundMarkup()).not.toContain("位已采用人物");
});

it("shows an unavailable state instead of retained counts when workspace loading fails", () => {
  state.error = "read failed";
  expect(groundMarkup()).toContain("暂时无法读取设定状态");
  expect(groundMarkup()).not.toContain("位已采用人物");
});
