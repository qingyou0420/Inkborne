/** SPDX-License-Identifier: AGPL-3.0-only */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuthoringArtifact } from "../lib/authoring-workspace";
import { ManuscriptHistoryDrawer } from "./ManuscriptHistoryDrawer";

const mocks = vi.hoisted(() => ({ body: "" }));

vi.mock("./ui/drawer", () => ({
  Drawer: ({ open, children }: { open: boolean; children: ReactNode }) => (
    open ? createElement("div", { "data-testid": "history-drawer" }, children) : null
  ),
}));
vi.mock("../hooks/use-api", () => ({
  useApi: (path: string) => {
    if (path.includes("/authoring/artifacts/v1")) {
      return {
        data: { body: mocks.body, meta: { artifactId: "v1" } },
        loading: false,
        error: null,
        refetch: async () => {},
      };
    }
    return { data: null, loading: false, error: null, refetch: async () => {} };
  },
}));

const artifact: AuthoringArtifact = {
  artifactId: "v1",
  stage: "write",
  scope: "chapter:9",
  version: 1,
  status: "candidate",
  label: "v1",
};

function renderHistory(chapterNumber?: number) {
  return renderToStaticMarkup(createElement(ManuscriptHistoryDrawer, {
    open: true,
    bookId: "book",
    title: "本章版本",
    artifacts: [artifact],
    currentId: "v1",
    isZh: true,
    onClose: () => {},
    onRestore: async () => true,
    chapterNumber,
    initialSelectedId: "v1",
  }));
}

function readingHtml(html: string): string {
  return html.split("ink-manuscript")[1] ?? "";
}

describe("history drawer chapter heading", () => {
  beforeEach(() => { mocks.body = ""; });

  it("drops a same-chapter hash heading from an old version", () => {
    mocks.body = "# 第9章 立听不名\n\n正文…";
    const html = renderHistory(9);
    expect(readingHtml(html)).toContain("正文…");
    expect(readingHtml(html)).not.toContain("立听不名");
    expect(readingHtml(html)).not.toContain("第9章");
  });

  it("drops a plain same-chapter heading line from an old version", () => {
    mocks.body = "第9章 立听不名\n\n正文…";
    const html = renderHistory(9);
    expect(readingHtml(html)).toContain("正文…");
    expect(readingHtml(html)).not.toContain("立听不名");
    expect(readingHtml(html)).not.toContain("第9章");
  });

  it("keeps a different chapter number and a sentence that is not a heading", () => {
    mocks.body = "# 第8章 旧题\n\n第9章就出事了。";
    const html = renderHistory(9);
    expect(readingHtml(html)).toContain("第8章");
    expect(readingHtml(html)).toContain("旧题");
    expect(readingHtml(html)).toContain("第9章就出事了。");
  });

  it("leaves headings in place when the drawer is not showing a chapter", () => {
    mocks.body = "# 第9章 立听不名\n\n正文…";
    const html = renderHistory(undefined);
    expect(readingHtml(html)).toContain("立听不名");
    expect(readingHtml(html)).toContain("正文…");
  });
});
