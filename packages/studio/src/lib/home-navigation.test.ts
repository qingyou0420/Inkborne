import { describe, expect, it } from "vitest";
import { bookResumeStage, isStartupHomeHash, startupBookRoute } from "./home-navigation";

describe("home startup and bookshelf continuation", () => {
  it("stays at home for zero or multiple books", () => {
    expect(startupBookRoute([], { removed: "write" })).toBeNull();
    expect(startupBookRoute([{ id: "a" }, { id: "b" }], { a: "write" })).toBeNull();
  });
  it("resumes the existing single book from its last stage rather than a deleted preferred book", () => {
    expect(startupBookRoute([{ id: "b", stage: "ground" }], { removed: "write", b: "weave" })).toEqual({ page: "book-weave", bookId: "b" });
    expect(startupBookRoute([{ id: "b", stage: "ground" }], { removed: "write" })).toEqual({ page: "book-ground", bookId: "b" });
  });
  it("leaves settings, new-book intros and specific sessions untouched on startup", () => {
    for (const hash of ["#/services", "#/book/intro", "#/book/new?session=x", "#/book/a/ask", "#/invalid"]) expect(isStartupHomeHash(hash)).toBe(false);
    for (const hash of ["", "#", "#/"]) expect(isStartupHomeHash(hash)).toBe(true);
  });
  it("uses Ask when a legacy book has no known stage and routes Write through its directory", () => {
    expect(bookResumeStage({ id: "legacy", stage: "unknown" }, {})).toBe("ask");
    expect(startupBookRoute([{ id: "a", stage: "write" }], {})).toEqual({ page: "book-write", bookId: "a" });
  });
});
