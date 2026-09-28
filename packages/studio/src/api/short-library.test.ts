import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeStudioShortAnalytics,
  decodeStoryId,
  deleteStudioShort,
  exportStudioShortManuscript,
  listStudioShorts,
  loadStudioShort,
  updateStudioShort,
} from "./short-library.js";

describe("short library", () => {
  it("lists completed and in-progress shorts without treating them as books", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-shorts-"));
    await mkdir(join(root, "shorts", "明日来信", "final"), { recursive: true });
    await mkdir(join(root, "shorts", "elevator", "outline"), { recursive: true });
    await writeFile(join(root, "shorts", "明日来信", "brief.json"), JSON.stringify({
      storyId: "明日来信",
      title: "明日来信",
      chapterCount: 12,
    }), "utf-8");
    await writeFile(join(root, "shorts", "明日来信", "status.json"), JSON.stringify({
      status: "complete",
      stage: "complete",
      id: "明日来信",
    }), "utf-8");
    await writeFile(join(root, "shorts", "明日来信", "final", "full.md"), "# 明日来信\n\n终稿。", "utf-8");
    await writeFile(join(root, "shorts", "elevator", "brief.json"), JSON.stringify({
      storyId: "elevator",
      title: "电梯多一层",
      chapterCount: 12,
      createdAt: "2026-09-01T00:00:00.000Z",
    }), "utf-8");
    await writeFile(join(root, "shorts", "elevator", "status.json"), JSON.stringify({
      status: "needs-review",
      stage: "awaiting-outline-confirm",
    }), "utf-8");
    await writeFile(join(root, "shorts", "elevator", "outline", "v002.md"), "## 大纲", "utf-8");

    const listed = await listStudioShorts(root);
    expect(listed.map((item) => ({ id: item.id, status: item.status, kind: item.kind }))).toEqual([
      { id: "elevator", status: "outlining", kind: "short" },
      { id: "明日来信", status: "completed", kind: "short" },
    ]);
    expect(listed.find((item) => item.id === "明日来信")?.manuscriptPath).toBe("shorts/明日来信/final/full.md");
    expect(listed.find((item) => item.id === "elevator")?.createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(listed.every((item) => typeof item.createdAt === "string" && item.createdAt.length > 0)).toBe(true);

    const finished = await loadStudioShort(root, "明日来信");
    expect(finished).toMatchObject({
      title: "明日来信",
      contentKind: "manuscript",
      content: expect.stringContaining("终稿"),
    });
    const outline = await loadStudioShort(root, "elevator");
    expect(outline).toMatchObject({
      title: "电梯多一层",
      contentKind: "outline",
      status: "outlining",
    });
  });

  it("updates short metadata without creating a books/ folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-shorts-update-"));
    await mkdir(join(root, "shorts", "elevator"), { recursive: true });
    await writeFile(join(root, "shorts", "elevator", "brief.json"), JSON.stringify({
      storyId: "elevator",
      title: "电梯多一层",
      chapterCount: 12,
      direction: "旧方向",
    }), "utf-8");

    const updated = await updateStudioShort(root, "elevator", {
      title: "电梯又多一层",
      chapterCount: 8,
      direction: "把反转提前",
    });
    expect(updated).toMatchObject({
      id: "elevator",
      title: "电梯又多一层",
      chapterCount: 8,
      direction: "把反转提前",
      kind: "short",
    });
    await expect(access(join(root, "books"))).rejects.toThrow();
    const brief = JSON.parse(await readFile(join(root, "shorts", "elevator", "brief.json"), "utf-8")) as {
      title: string;
    };
    expect(brief.title).toBe("电梯又多一层");
  });

  it("exports finished prose as txt/md and deletes only shorts/<id>/", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-shorts-export-"));
    await mkdir(join(root, "shorts", "明日来信", "final"), { recursive: true });
    await mkdir(join(root, "books", "keep-me"), { recursive: true });
    await writeFile(join(root, "shorts", "明日来信", "brief.json"), JSON.stringify({
      storyId: "明日来信",
      title: "明日来信",
      chapterCount: 2,
    }), "utf-8");
    await writeFile(join(root, "shorts", "明日来信", "final", "full.md"), "# 明日来信\n\n终稿正文。", "utf-8");
    await writeFile(join(root, "books", "keep-me", "book.json"), "{}", "utf-8");

    const md = await exportStudioShortManuscript(root, "明日来信", "md");
    expect(md).toMatchObject({
      fileName: "明日来信.md",
      contentType: "text/markdown; charset=utf-8",
      payload: expect.stringContaining("# 明日来信"),
    });
    const txt = await exportStudioShortManuscript(root, "明日来信", "txt");
    expect(txt?.payload).toContain("终稿正文");
    expect(txt?.payload).not.toContain("# 明日来信");
    expect(txt?.contentType).toContain("text/plain");

    await writeFile(join(root, "shorts", "明日来信", "final", "full.md"), [
      "# 明日来信",
      "",
      "# 第1章 信",
      "",
      "# 第1章 信",
      "",
      "信到了。",
      "",
      "## 作者有话说",
      "",
      "谢谢。",
      "",
      "# 第2章 回",
      "",
      "回了。",
    ].join("\n"), "utf-8");
    const fanqie = await exportStudioShortManuscript(root, "明日来信", "fanqie");
    expect(String(fanqie?.payload)).toContain("第1章 信");
    expect(String(fanqie?.payload).match(/第1章 信/g)).toHaveLength(1);
    expect(String(fanqie?.payload)).not.toContain("作者有话说");
    expect(String(fanqie?.payload)).toContain("第2章 回");
    const one = await exportStudioShortManuscript(root, "明日来信", "fanqie", {
      fromChapter: 2,
      toChapter: 2,
      layout: "per-chapter",
    });
    expect(one?.fileName).toBe("第0002章 回.txt");
    expect(String(one?.payload)).toContain("回了。");
    expect(String(one?.payload)).not.toContain("第1章");

    const analytics = await computeStudioShortAnalytics(root, "明日来信");
    expect(analytics).toMatchObject({
      kind: "short",
      totalChapters: 2,
      statusDistribution: { completed: 1 },
    });
    expect(analytics?.totalWords).toBeGreaterThan(0);

    expect(await deleteStudioShort(root, "../books/keep-me")).toBe(false);
    expect(await deleteStudioShort(root, "明日来信")).toBe(true);
    expect(await deleteStudioShort(root, "明日来信")).toBe(true);
    expect(await deleteStudioShort(root, "missing")).toBe(true);
    await expect(access(join(root, "shorts", "明日来信"))).rejects.toThrow();
    await expect(access(join(root, "books", "keep-me", "book.json"))).resolves.toBeUndefined();
    const afterDelete = await listStudioShorts(root);
    expect(afterDelete.find((item) => item.id === "明日来信")).toBeUndefined();
  });

  it("decodes Chinese short ids the same way as reader routes", () => {
    expect(decodeStoryId("明日来信")).toBe("明日来信");
    expect(decodeStoryId(encodeURIComponent("明日来信"))).toBe("明日来信");
    expect(decodeStoryId(encodeURIComponent(encodeURIComponent("明日来信")))).toBe("明日来信");
  });
});
