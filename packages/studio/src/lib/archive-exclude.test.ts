import { describe, expect, it } from "vitest";
import { isExcludedFromProjectArchive } from "./archive-exclude";

describe("isExcludedFromProjectArchive", () => {
  it("drops key files and .env, and keeps the rest of the book", () => {
    expect(isExcludedFromProjectArchive(".inkos/secrets.json")).toBe(true);
    expect(isExcludedFromProjectArchive("books/demo/.inkos/secrets.json")).toBe(true);
    expect(isExcludedFromProjectArchive(".env")).toBe(true);
    expect(isExcludedFromProjectArchive("books/demo/.env")).toBe(true);
    expect(isExcludedFromProjectArchive("secrets.json")).toBe(true);
    expect(isExcludedFromProjectArchive(".env.example")).toBe(false);
    expect(isExcludedFromProjectArchive("books/demo/chapters/0001.md")).toBe(false);
    expect(isExcludedFromProjectArchive(".inkos/config.json")).toBe(false);
  });
});