/** SPDX-License-Identifier: AGPL-3.0-only */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BookStageView } from "../lib/book-stage";
import type { TFunction } from "../hooks/use-i18n";
import { adoptWeaveAndRefreshStage } from "../components/AuthoringWeavePanel";
import { BookDetail } from "../pages/BookDetail";
import { weaveLengthGateCopy } from "../lib/stage-copy";

const mocks = vi.hoisted(() => ({
  post: vi.fn(), invalidate: vi.fn(), bump: vi.fn(), stage: null as BookStageView | null,
}));
vi.mock("../hooks/use-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hooks/use-api")>(),
  postApi: mocks.post,
  useApi: () => ({
    data: { book: { id: "book", title: "合成书", genre: "古风", status: "active", chapterWordCount: 5000, targetChapters: 260, language: "zh" }, chapters: [], nextChapter: 1 },
    loading: false, error: null, refetch: async () => {},
  }),
}));
vi.mock("../hooks/use-book-stage", () => ({ useBookStage: () => mocks.stage, invalidateBookStage: mocks.invalidate }));
vi.mock("../store/chat", () => ({ useChatStore: { getState: () => ({ bumpBookDataVersion: mocks.bump }) } }));
vi.mock("../components/AuthoringWritePanel", () => ({ AuthoringWritePanel: () => createElement("section", { "data-testid": "write-panel-fixture" }) }));
vi.mock("../components/SerialCockpitStrip", () => ({ SerialCockpitStrip: () => null, startDraft: vi.fn(), startWriteNext: vi.fn() }));

const noop = () => {};
const nav = { toDashboard: noop, toChapter: noop, toAnalytics: noop, toTruth: noop, toBook: noop, toOutline: noop, toBookSettings: noop, toAsk: noop };
const t = ((key: string) => key) as TFunction;
function renderWrite() {
  return renderToStaticMarkup(createElement(BookDetail, { bookId: "book", nav, theme: "light", t, sse: { messages: [] } }));
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.stage = null;
});

describe("adopted weave to write handoff", () => {
  it("invalidates the shared stage only after adoption succeeds", async () => {
    let finish!: (result: { message: string }) => void;
    mocks.post.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const work = adoptWeaveAndRefreshStage("book", "chapters-1-50");
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.bump).not.toHaveBeenCalled();
    finish({ message: "规划已采用" });
    expect(await work).toEqual({ message: "规划已采用" });
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/authoring/weave/adopt", { bookId: "book", artifactId: "chapters-1-50" });
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith("book");
    expect(mocks.bump).toHaveBeenCalledTimes(1);
  });

  it("does not mark a failed adoption as a stage change", async () => {
    mocks.post.mockRejectedValueOnce(new Error("采用失败"));
    await expect(adoptWeaveAndRefreshStage("book", "chapters-1-50")).rejects.toThrow("采用失败");
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.bump).not.toHaveBeenCalled();
  });

  it("does not claim that an outline is missing before stage facts arrive", () => {
    const html = renderWrite();
    expect(html).toContain('data-testid="write-panel-fixture"');
    expect(html).not.toContain("还没有可写的章");
    expect(html).not.toContain('data-testid="write-empty"');
  });

  it("removes the missing-outline empty state when adopted stage facts say write", () => {
    mocks.stage = { stage: "write", steps: { ask: "done", ground: "done", weave: "done", write: "current" } };
    const html = renderWrite();
    expect(html).toContain('data-testid="write-panel-fixture"');
    expect(html).not.toContain("还没有可写的章");
  });

  it("still shows the existing guidance when loaded facts confirm no chapter outline", () => {
    mocks.stage = { stage: "weave", steps: { ask: "done", ground: "done", weave: "current", write: "todo" } };
    expect(renderWrite()).toContain("还没有可写的章");
  });

  it("shows a 先定全书篇幅 gate when canon length is missing", () => {
    const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const panel = readFileSync(join(studioRoot, "src/components/AuthoringWeavePanel.tsx"), "utf8");
    const copy = weaveLengthGateCopy(true);
    expect(copy).toEqual({
      title: "先定全书篇幅",
      subtitle: "请先在问心正典里确认目标章数和每章字数",
      action: "去问心",
      target: "ask",
    });
    expect(panel).toMatch(/weave-length-gate/);
    expect(panel).toMatch(/data\.canon\?\.targetChapters/);
    expect(panel).toMatch(/weaveLengthGateCopy/);
    expect(panel).not.toMatch(/targetChapters \|\| 36/);
  });
});
