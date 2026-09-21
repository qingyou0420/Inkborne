import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BookConfig } from "@actalk/inkos-core";
import {
  BOOK_COVER_MAX_BYTES,
  bookCoverApiPath,
  bookCoverExtensionFor,
  clearBookCoverFile,
  isSafeBookCoverRelative,
  readBookCoverFile,
  resolveBookCoverFile,
  saveBookCoverFile,
  studioBookCoverSrc,
  validateBookCoverFile,
  withStudioCoverSrc,
} from "./book-cover-io";

function sampleBook(overrides: Partial<BookConfig> = {}): BookConfig {
  return {
    id: "醉词",
    title: "醉词",
    platform: "qidian",
    genre: "urban",
    status: "active",
    targetChapters: 200,
    chapterWordCount: 3000,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("book-cover helpers", () => {
  it("accepts common image types and rejects unsafe relative paths", () => {
    expect(bookCoverExtensionFor("image/png", "mark.PNG")).toBe("png");
    expect(bookCoverExtensionFor("image/jpeg", "cover.jpeg")).toBe("jpg");
    expect(bookCoverExtensionFor("", "cover.webp")).toBe("webp");
    expect(bookCoverExtensionFor("text/plain", "cover.txt")).toBeNull();
    expect(isSafeBookCoverRelative("cover.png")).toBe(true);
    expect(isSafeBookCoverRelative("assets/cover.webp")).toBe(true);
    expect(isSafeBookCoverRelative("../cover.png")).toBe(false);
    expect(isSafeBookCoverRelative("chapters/cover.png")).toBe(false);
    expect(validateBookCoverFile({ type: "image/gif", size: 12, name: "a.gif" }, true)).toBeNull();
    expect(validateBookCoverFile({ type: "image/png", size: BOOK_COVER_MAX_BYTES + 1 }, true))
      .toContain("6 MB");
  });

  it("builds a dedicated Studio cover URL instead of project/files", () => {
    expect(bookCoverApiPath("醉词", "2026-09-06T00:00:00.000Z"))
      .toBe(`/api/v1/books/${encodeURIComponent("醉词")}/cover?v=${encodeURIComponent("2026-09-06T00:00:00.000Z")}`);
    expect(studioBookCoverSrc("demo", undefined)).toBeUndefined();
    expect(withStudioCoverSrc({
      id: "demo",
      coverImagePath: "cover.png",
      updatedAt: "t",
    }).coverImagePath).toBe("/api/v1/books/demo/cover?v=t");
  });
});

describe("book-cover-io", () => {
  it("writes cover.<ext> beside book.json, replaces, then clears back to no file", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkborne-cover-"));
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const saved = await saveBookCoverFile(bookDir, sampleBook(), png, "image/png", "封面.png");
    expect(saved.coverImagePath).toBe("cover.png");
    await expect(readFile(join(bookDir, "cover.png"))).resolves.toHaveLength(8);

    const jpg = new Uint8Array([255, 216, 255, 224]);
    const replaced = await saveBookCoverFile(bookDir, saved, jpg, "image/jpeg", "next.jpg");
    expect(replaced.coverImagePath).toBe("cover.jpg");
    await expect(readFile(join(bookDir, "cover.jpg"))).resolves.toHaveLength(4);
    await expect(readFile(join(bookDir, "cover.png"))).rejects.toMatchObject({ code: "ENOENT" });

    const read = await readBookCoverFile(bookDir, replaced);
    expect(read?.contentType).toBe("image/jpeg");
    expect(read?.bytes.byteLength).toBe(4);

    const cleared = await clearBookCoverFile(bookDir, replaced);
    expect(cleared.coverImagePath).toBeUndefined();
    await expect(readFile(join(bookDir, "cover.jpg"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readBookCoverFile(bookDir, cleared)).toBeNull();
  });

  it("refuses path traversal when resolving a stored cover", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkborne-cover-safe-"));
    await mkdir(join(bookDir, "assets"), { recursive: true });
    await writeFile(join(bookDir, "assets", "cover.webp"), new Uint8Array([1, 2, 3]));
    const ok = resolveBookCoverFile(bookDir, "assets/cover.webp");
    expect(ok.contentType).toBe("image/webp");
    expect(() => resolveBookCoverFile(bookDir, "../secrets.png")).toThrow(/封面路径无效/);
  });

  it("rejects oversized uploads before writing", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkborne-cover-big-"));
    const bytes = new Uint8Array(BOOK_COVER_MAX_BYTES + 1);
    await expect(saveBookCoverFile(bookDir, sampleBook(), bytes, "image/png", "big.png"))
      .rejects.toThrow(/6 MB/);
  });
});
