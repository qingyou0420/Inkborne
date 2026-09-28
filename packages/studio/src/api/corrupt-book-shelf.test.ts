import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioServer } from "./server.js";

const projectConfig = {
  name: "test",
  version: "0.1.0",
  language: "zh",
  llm: {
    provider: "custom",
    service: "custom",
    configSource: "studio",
    baseUrl: "https://example.invalid",
    model: "test-model",
    apiFormat: "chat",
    stream: true,
  },
} as never;

function bookJson(id: string, title: string): string {
  return `${JSON.stringify({
    id,
    title,
    genre: "其他",
    platform: "tomato",
    status: "active",
    targetChapters: 10,
    chapterWordCount: 2000,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2)}\n`;
}

describe("corrupt book shelf", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  async function setup(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), "corrupt-shelf-"));
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(join(root, "inkos.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    await mkdir(join(root, "books", "good"), { recursive: true });
    await writeFile(join(root, "books", "good", "book.json"), bookJson("good", "好书"), "utf-8");
  }

  it("lists a healthy book beside a truncated book.json and opens the bad book with 409", async () => {
    await setup();
    const badDir = join(root, "books", "bad");
    await mkdir(join(badDir, "story", "snapshots", "7"), { recursive: true });
    await writeFile(join(badDir, "book.json"), "{", "utf-8");
    const app = createStudioServer(projectConfig, root);
    const list = await app.request("/api/v1/books");
    expect(list.status).toBe(200);
    const body = await list.json() as { books: Array<{ id: string; title?: string; corrupt?: boolean; message?: string; snapshotPath?: string }> };
    const good = body.books.find((book) => book.id === "good");
    const bad = body.books.find((book) => book.id === "bad");
    expect(good?.title).toBe("好书");
    expect(good?.corrupt).toBeUndefined();
    expect(bad?.corrupt).toBe(true);
    expect(bad?.message).toMatch(/book\.json 坏了/);
    expect(bad?.message).toMatch(/snapshots[/\\]7/);
    expect(bad?.snapshotPath).toMatch(/snapshots[/\\]7/);
    const one = await app.request("/api/v1/books/bad");
    expect(one.status).toBe(409);
    const detail = await one.json() as { error: string; snapshotPath?: string };
    expect(detail.error).toBe(bad?.message);
    expect(detail.snapshotPath).toMatch(/snapshots[/\\]7/);
  });

  it("quarantines an empty book.json and still lists the other book", async () => {
    await setup();
    const emptyDir = join(root, "books", "empty");
    await mkdir(join(emptyDir, "story", "snapshots", "2"), { recursive: true });
    await writeFile(join(emptyDir, "book.json"), "", "utf-8");
    const app = createStudioServer(projectConfig, root);
    const list = await app.request("/api/v1/books");
    expect(list.status).toBe(200);
    const body = await list.json() as { books: Array<{ id: string; corrupt?: boolean; snapshotPath?: string }> };
    expect(body.books.some((book) => book.id === "good" && !book.corrupt)).toBe(true);
    const empty = body.books.find((book) => book.id === "empty");
    expect(empty?.corrupt).toBe(true);
    expect(empty?.snapshotPath).toMatch(/snapshots[/\\]2/);
    const one = await app.request("/api/v1/books/empty");
    expect(one.status).toBe(409);
  });
});
