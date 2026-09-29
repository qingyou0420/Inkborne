/** SPDX-License-Identifier: AGPL-3.0-only */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthoringWritePanel } from "./AuthoringWritePanel";

const mocks = vi.hoisted(() => ({ body: "" }));

vi.mock("../hooks/use-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/use-api")>();
  return {
    ...actual,
    useApi: (path: string) => {
      if (path.includes("/authoring/workspace")) {
        return { data: { artifacts: [], runs: [], manifest: {} }, loading: false, error: null, refetch: async () => {} };
      }
      if (path.includes("/chapters/")) {
        return { data: { content: mocks.body, chapterNumber: 9 }, loading: false, error: null, refetch: async () => {} };
      }
      return { data: null, loading: false, error: null, refetch: async () => {} };
    },
  };
});

function renderWrite() {
  return renderToStaticMarkup(createElement(AuthoringWritePanel, {
    bookId: "book",
    chapterNumber: 9,
    chapterTitle: "立听不名",
    isZh: true,
  }));
}

function readingHtml(html: string): string {
  return html.split("write-manuscript-reading")[1] ?? "";
}

describe("write page chapter heading", () => {
  beforeEach(() => { mocks.body = ""; });

  it("renders a hash heading only in the page title", () => {
    mocks.body = "# 第9章 立听不名\n\n正文…";
    const html = renderWrite();
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain("第 9 章 立听不名");
    expect(readingHtml(html)).toContain("正文…");
    expect(readingHtml(html)).not.toContain("立听不名");
    expect(readingHtml(html)).not.toContain("第9章");
    expect(html).toContain("现在 3 字");
    expect(html).not.toContain("现在 11 字");
  });

  it("renders a plain heading line only in the page title", () => {
    mocks.body = "第9章 立听不名\n\n正文…";
    const html = renderWrite();
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(readingHtml(html)).toContain("正文…");
    expect(readingHtml(html)).not.toContain("立听不名");
    expect(readingHtml(html)).not.toContain("第9章");
    expect(html).toContain("现在 3 字");
    expect(html).not.toContain("现在 10 字");
  });

  it("keeps a heading whose chapter number is different", () => {
    mocks.body = "# 第8章 旧题\n\n正文…";
    const html = renderWrite();
    expect(readingHtml(html)).toContain("第8章");
    expect(readingHtml(html)).toContain("旧题");
    expect(readingHtml(html)).toContain("正文…");
  });

  it("keeps a sentence that only starts like a chapter heading", () => {
    mocks.body = "第9章就出事了。\n\n正文…";
    const html = renderWrite();
    expect(readingHtml(html)).toContain("第9章就出事了。");
    expect(readingHtml(html)).toContain("正文…");
    expect(html).toContain("现在 11 字");
  });

  it("leaves the editor textarea on the stored manuscript", () => {
    const source = readFileSync(new URL("./AuthoringWritePanel.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/value=\{body\}/);
    expect(source).not.toMatch(/value=\{readingBody\}/);
    expect(source).toMatch(/ManuscriptView body=\{readingBody\}/);
  });
});
