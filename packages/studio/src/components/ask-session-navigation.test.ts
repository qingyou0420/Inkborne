/** SPDX-License-Identifier: AGPL-3.0-only */
import { expect, it, vi } from "vitest";
import { initialAskHistoryScope, navigateAskSession } from "./ask-session-navigation";

it.each([null, "book-a"])("keeps the composer and session unchanged until navigation to %s is accepted", (bookId) => {
  let accept: (() => void) | undefined;
  const mutate = vi.fn();
  const nav = { toBookCreate: (_id?: string, next?: () => void) => { accept = next; }, toAsk: (_book: string, _id?: string, next?: () => void) => { accept = next; } };
  navigateAskSession(nav, bookId, "session-b", mutate);
  expect(mutate).not.toHaveBeenCalled(); // Continue editing never invokes the callback.
  accept?.();
  expect(mutate).toHaveBeenCalledOnce();
});

it("selects the current book even before the lazy books request resolves", () => {
  expect(initialAskHistoryScope("book-a")).toBe("book:book-a");
  expect(initialAskHistoryScope()).toBe("new");
});
