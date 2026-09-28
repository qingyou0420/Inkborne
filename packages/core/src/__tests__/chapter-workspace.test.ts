import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveChapterFile } from "../authoring/chapter-index.js";
import {
  archiveChapterVersion,
  CHAPTER_VERSION_KEEP,
  listChapterVersions,
  readChapterPlanDocument,
  readChapterUserBrief,
  readChapterVersion,
  saveChapterUserBrief,
} from "../state/chapter-workspace.js";

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

describe("chapter workspace", () => {
  it("persists, reads, and clears a per-chapter user brief", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-chapter-workspace-"));

    await expect(readChapterUserBrief(bookDir, 3)).resolves.toBe("");
    await saveChapterUserBrief(bookDir, 3, "  保留雨夜证词，重写结尾。  ");
    await expect(readChapterUserBrief(bookDir, 3)).resolves.toBe("保留雨夜证词，重写结尾。");

    await saveChapterUserBrief(bookDir, 3, " \n ");
    await expect(readChapterUserBrief(bookDir, 3)).resolves.toBe("");
    await expect(exists(join(bookDir, "story", "runtime", "chapter-0003.user-brief.md")))
      .resolves.toBe(false);
  });

  it("reads the persisted system plan without requiring one to exist", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-chapter-workspace-"));
    await expect(readChapterPlanDocument(bookDir, 2)).resolves.toBeNull();

    const runtimeDir = join(bookDir, "story", "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "chapter-0002.plan.md"), "# Chapter 2 Plan\n\nKeep the witness alive.", "utf-8");

    await expect(readChapterPlanDocument(bookDir, 2))
      .resolves.toBe("# Chapter 2 Plan\n\nKeep the witness alive.");
  });

  it("archives immutable chapter versions and lists newest first", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-chapter-workspace-"));
    const first = await archiveChapterVersion(
      bookDir,
      4,
      "# 第4章 初稿\n\n旧正文。",
      "manual",
      new Date("2026-07-01T00:00:00.000Z"),
    );
    const second = await archiveChapterVersion(
      bookDir,
      4,
      "# 第4章 二稿\n\n新正文。",
      "revision",
      new Date("2026-07-02T00:00:00.000Z"),
    );

    expect(first.id).not.toBe(second.id);
    await expect(readChapterVersion(bookDir, 4, first.id))
      .resolves.toBe("# 第4章 初稿\n\n旧正文。");
    await expect(readChapterVersion(bookDir, 4, second.id))
      .resolves.toBe("# 第4章 二稿\n\n新正文。");

    const versions = await listChapterVersions(bookDir, 4);
    expect(versions.map((version) => version.id)).toEqual([second.id, first.id]);
    expect(versions.map((version) => version.source)).toEqual(["revision", "manual"]);
    expect(versions.map((version) => version.createdAt)).toEqual([
      "2026-07-02T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    ]);
    expect(versions.map((version) => version.characterCount)).toEqual([
      "# 第4章 二稿\n\n新正文。".length,
      "# 第4章 初稿\n\n旧正文。".length,
    ]);
  });

  it("rejects unsafe version ids instead of reading outside the archive", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-chapter-workspace-"));
    await expect(readChapterVersion(bookDir, 1, "../book.json"))
      .rejects.toThrow(/invalid chapter version id/i);
  });

  it("does not expose archives from another chapter", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-chapter-workspace-"));
    const version = await archiveChapterVersion(
      bookDir,
      1,
      "# 第1章",
      "regeneration",
      new Date("2026-07-03T00:00:00.000Z"),
    );

    await expect(readChapterVersion(bookDir, 2, version.id)).rejects.toThrow();
    await expect(readFile(
      join(bookDir, "chapters", ".versions", "0001", `${version.id}.md`),
      "utf-8",
    )).resolves.toBe("# 第1章");
  });

  it("lists version metadata without rereading the chapter text", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-chapter-workspace-"));
    const saved = await archiveChapterVersion(
      bookDir,
      6,
      "原文五字",
      "manual",
      new Date("2026-07-04T00:00:00.000Z"),
    );
    await listChapterVersions(bookDir, 6);
    await writeFile(
      join(bookDir, "chapters", ".versions", "0006", `${saved.id}.md`),
      "被换掉的更长正文",
      "utf-8",
    );
    const listed = await listChapterVersions(bookDir, 6);
    expect(listed[0]?.characterCount).toBe("原文五字".length);
    expect(listed[0]?.source).toBe("manual");
  });

  it("caps autosaves but keeps the manual baseline and the only original autosave", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-chapter-workspace-"));
    const manual = await archiveChapterVersion(
      bookDir,
      9,
      "改前原文",
      "manual",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    for (let index = 0; index < CHAPTER_VERSION_KEEP + 5; index += 1) {
      await archiveChapterVersion(
        bookDir,
        9,
        `自动${index}`,
        "autosave",
        new Date(Date.UTC(2026, 1, 1, 0, index)),
      );
    }
    const kept = await listChapterVersions(bookDir, 9);
    expect(kept.some((version) => version.id === manual.id)).toBe(true);
    expect(kept.filter((version) => version.source === "autosave")).toHaveLength(CHAPTER_VERSION_KEEP);
    await expect(readChapterVersion(bookDir, 9, manual.id)).resolves.toBe("改前原文");

    const autosaveOnly = await mkdtemp(join(tmpdir(), "inkos-chapter-workspace-"));
    const oldest = await archiveChapterVersion(
      autosaveOnly,
      2,
      "唯一原文",
      "autosave",
      new Date("2026-01-02T00:00:00.000Z"),
    );
    for (let index = 0; index < CHAPTER_VERSION_KEEP + 4; index += 1) {
      await archiveChapterVersion(
        autosaveOnly,
        2,
        `后续${index}`,
        "autosave",
        new Date(Date.UTC(2026, 3, 1, 0, index + 1)),
      );
    }
    const autosaves = await listChapterVersions(autosaveOnly, 2);
    expect(autosaves.some((version) => version.id === oldest.id)).toBe(true);
    await expect(readChapterVersion(autosaveOnly, 2, oldest.id)).resolves.toBe("唯一原文");
  });

  it("opens a chapter from the index file name", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-chapter-workspace-"));
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await writeFile(join(bookDir, "chapters", "0007_aaa.md"), "甲", "utf-8");
    await writeFile(join(bookDir, "chapters", "0007_zzz.md"), "乙", "utf-8");
    await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([{
      number: 7,
      title: "乙章",
      file: "0007_zzz.md",
      status: "approved",
      wordCount: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }]), "utf-8");
    await expect(resolveChapterFile(bookDir, 7)).resolves.toMatchObject({
      fileName: "0007_zzz.md",
      relativePath: "chapters/0007_zzz.md",
      title: "乙章",
    });
  });
});
