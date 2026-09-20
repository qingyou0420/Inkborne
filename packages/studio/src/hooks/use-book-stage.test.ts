import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { invalidateBookStage, loadBookStage, shouldInvalidateBookStageEvent, useBookStage } from "./use-book-stage";
import type { BookStageView } from "../lib/book-stage";
import { useChatStore } from "../store/chat";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./use-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./use-api")>(),
  fetchJson: mocks.fetch,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function ReadStage() {
  return createElement("output", null, useBookStage("book")?.stage ?? "loading");
}

beforeEach(() => {
  invalidateBookStage();
  mocks.fetch.mockReset();
  useChatStore.setState({ bookDataVersion: 0 });
});

describe("shouldInvalidateBookStageEvent", () => {
  it("drops /stage cache on truth:written", () => {
    expect(shouldInvalidateBookStageEvent("truth:written")).toBe(true);
  });

  it("still ignores progress and unrelated session events", () => {
    expect(shouldInvalidateBookStageEvent("write:complete")).toBe(true);
    expect(shouldInvalidateBookStageEvent("rewrite:complete")).toBe(true);
    expect(shouldInvalidateBookStageEvent("revise:complete")).toBe(true);
    expect(shouldInvalidateBookStageEvent("weave:progress")).toBe(false);
    expect(shouldInvalidateBookStageEvent("book:creating")).toBe(false);
    expect(shouldInvalidateBookStageEvent("session:title")).toBe(false);
  });
});

describe("stage reads across weave adoption", () => {
  const before: BookStageView = { stage: "weave", steps: { ask: "done", ground: "done", weave: "current", write: "todo" } };
  const adopted: BookStageView = { stage: "write", steps: { ask: "done", ground: "done", weave: "done", write: "current" } };

  it.each(["before", "after"])("ignores an invalidated response arriving %s the adopted-stage response", async (order) => {
    const staleReply = deferred<BookStageView>();
    const freshReply = deferred<BookStageView>();
    mocks.fetch.mockReturnValueOnce(staleReply.promise).mockReturnValueOnce(freshReply.promise);
    const stale = loadBookStage("book", 0);
    invalidateBookStage("book");
    const current = loadBookStage("book", 0);
    if (order === "before") {
      staleReply.resolve(before);
      await stale;
      // The old request must not remove the new in-flight request either.
      expect(loadBookStage("book", 0)).toBe(current);
    }
    freshReply.resolve(adopted);
    await current;
    if (order === "after") {
      staleReply.resolve(before);
      await stale;
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(renderToStaticMarkup(createElement(ReadStage))).toBe("<output>write</output>");
  });

  it("does not repopulate an invalidated cache when the next page has not loaded yet", async () => {
    const staleReply = deferred<BookStageView>();
    mocks.fetch.mockReturnValueOnce(staleReply.promise);
    const stale = loadBookStage("book", 0);
    invalidateBookStage("book");
    staleReply.resolve(before);
    await stale;
    expect(renderToStaticMarkup(createElement(ReadStage))).toBe("<output>loading</output>");
  });
});
