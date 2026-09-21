import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioServer } from "../api/server.js";

describe("books export Content-Disposition", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-book-export-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("exports a Chinese book id without throwing ByteString and includes filename*", async () => {
    const bookId = "醉词";
    const bookDir = join(root, "books", bookId);
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: bookId,
      title: bookId,
      platform: "qidian",
      genre: "urban",
      status: "drafting",
      targetChapters: 10,
      chapterWordCount: 3000,
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    }), "utf-8");
    await writeFile(join(bookDir, "chapters", "0001_开篇.md"), "# 第1章 开篇\n\n正文。\n", "utf-8");

    const app = createStudioServer({} as never, root);
    const res = await app.request(`/api/v1/books/${encodeURIComponent(bookId)}/export?format=txt`);

    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition");
    expect(disposition).toBeTruthy();
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain(encodeURIComponent(`${bookId}.txt`));
    expect(disposition).not.toMatch(/[\u0080-\uFFFF]/);
    expect(await res.text()).toContain("醉词");
  });
});
