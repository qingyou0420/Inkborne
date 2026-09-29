import { describe, expect, it } from "vitest";
import { deriveActiveBookId, deriveBookChromeTab, deriveStartupGate, isBookCreateChatRoute } from "./App";

describe("deriveActiveBookId", () => {
  it("returns the current book across book-centered routes", () => {
    expect(deriveActiveBookId({ page: "book", bookId: "alpha" })).toBe("alpha");
    expect(deriveActiveBookId({ page: "book-outline", bookId: "alpha" })).toBe("alpha");
    expect(deriveActiveBookId({ page: "book-ask", bookId: "alpha" })).toBe("alpha");
    expect(deriveActiveBookId({ page: "book-ground", bookId: "alpha" })).toBe("alpha");
    expect(deriveActiveBookId({ page: "book-weave", bookId: "alpha" })).toBe("alpha");
    expect(deriveActiveBookId({ page: "book-write", bookId: "alpha" })).toBe("alpha");
    expect(deriveActiveBookId({ page: "chapter", bookId: "beta", chapterNumber: 3 })).toBe("beta");
    expect(deriveActiveBookId({ page: "truth", bookId: "gamma" })).toBe("gamma");
    expect(deriveActiveBookId({ page: "analytics", bookId: "delta" })).toBe("delta");
    expect(deriveActiveBookId({ page: "book-settings", bookId: "epsilon" })).toBe("epsilon");
  });

  it("returns undefined for non-book routes", () => {
    expect(deriveActiveBookId({ page: "dashboard" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "services" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "style" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "update" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "short", storyId: "明日来信" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "short-settings", storyId: "明日来信" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "short-analytics", storyId: "明日来信" })).toBeUndefined();
    expect(deriveActiveBookId({ page: "author" })).toBeUndefined();
  });
});

describe("deriveBookChromeTab", () => {
  it("maps book-scoped routes to the shared chrome tab", () => {
    expect(deriveBookChromeTab({ page: "book", bookId: "zui" })).toBe("study");
    expect(deriveBookChromeTab({ page: "book-ask", bookId: "zui" })).toBe("ask");
    expect(deriveBookChromeTab({ page: "book-ground", bookId: "zui" })).toBe("ground");
    expect(deriveBookChromeTab({ page: "book-weave", bookId: "zui" })).toBe("weave");
    expect(deriveBookChromeTab({ page: "book-write", bookId: "zui" })).toBe("write");
    expect(deriveBookChromeTab({ page: "chapter", bookId: "zui", chapterNumber: 3 })).toBe("study");
    expect(deriveBookChromeTab({ page: "truth", bookId: "zui" })).toBe("study");
    expect(deriveBookChromeTab({ page: "analytics", bookId: "zui" })).toBe("study");
    expect(deriveBookChromeTab({ page: "dashboard" })).toBeNull();
    expect(deriveBookChromeTab({ page: "author" })).toBeNull();
  });
});

describe("isBookCreateChatRoute", () => {
  it("routes new-book creation through chat instead of the standalone form page", () => {
    expect(isBookCreateChatRoute({ page: "book-create" })).toBe(true);
    expect(isBookCreateChatRoute({ page: "book", bookId: "alpha" })).toBe(false);
  });
});

describe("deriveStartupGate", () => {
  it("shows startup errors instead of spinning forever before the project is ready", () => {
    expect(deriveStartupGate({ ready: false, projectError: null })).toBe("loading");
    expect(deriveStartupGate({ ready: false, projectError: "bad inkos.json" })).toBe("error");
    expect(deriveStartupGate({ ready: true, projectError: "later refetch failed" })).toBe("ready");
  });
});
