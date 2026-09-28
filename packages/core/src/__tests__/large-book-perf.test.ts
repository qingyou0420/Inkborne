/**
 * 300 chapters × 5000 chars. Times the old directory walk against the indexed path.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { loadAuthoringWorkspaceLists, type AuthoringStoreRoot } from "../authoring/store.js";
import { ensureWorkflowIndex, scanWorkflowIndex } from "../authoring/workflow-index.js";
import { resolveChapterFile } from "../authoring/chapter-index.js";
import { listChapterVersions, storeAutosaveVersion } from "../state/chapter-workspace.js";
import { StateManager } from "../state/manager.js";

const CHAPTERS = 300;
const CHAPTER_CHARS = 5000;
const VERSIONS_PER_MEASURED_CHAPTER = 30;
const ARTIFACTS_PER_CHAPTER = 5;
const BOOK_ID = "big-book";

let projectRoot = "";

async function writePool(count: number, worker: (index: number) => Promise<void>): Promise<void> {
  const batch = 40;
  for (let start = 0; start < count; start += batch) {
    const jobs: Array<Promise<void>> = [];
    for (let index = start; index < Math.min(count, start + batch); index += 1) jobs.push(worker(index));
    await Promise.all(jobs);
  }
}

async function time<T>(label: string, run: () => Promise<T>): Promise<{ label: string; ms: number; value: T }> {
  const started = performance.now();
  const value = await run();
  const ms = performance.now() - started;
  return { label, ms, value };
}

describe("large book performance", () => {
  afterAll(async () => {
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
  });

  it("opens the write and study workspace for a 300-chapter book in under a second", async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-large-book-"));
    const bookDir = join(projectRoot, "books", BOOK_ID);
    const chaptersDir = join(bookDir, "chapters");
    const workflowDir = join(bookDir, "story", "workflow");
    const body = `${"字".repeat(CHAPTER_CHARS)}\n`;
    await mkdir(chaptersDir, { recursive: true });
    await mkdir(join(bookDir, "story"), { recursive: true });
    const index = Array.from({ length: CHAPTERS }, (_, offset) => {
      const number = offset + 1;
      const file = `${String(number).padStart(4, "0")}_章.md`;
      return {
        number,
        title: `第${number}章`,
        file,
        status: "approved",
        wordCount: CHAPTER_CHARS,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      };
    });
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: BOOK_ID,
      title: "三百章假书",
      language: "zh",
      genre: "仙侠",
      status: "writing",
      chapterWordCount: CHAPTER_CHARS,
      targetChapters: CHAPTERS,
    }), "utf-8");
    await writeFile(join(chaptersDir, "index.json"), JSON.stringify(index), "utf-8");
    await writePool(CHAPTERS, async (offset) => {
      const number = offset + 1;
      await writeFile(join(chaptersDir, `${String(number).padStart(4, "0")}_章.md`), body, "utf-8");
    });

    const measuredChapter = 150;
    const versionDir = join(chaptersDir, ".versions", String(measuredChapter).padStart(4, "0"));
    await mkdir(versionDir, { recursive: true });
    await writePool(VERSIONS_PER_MEASURED_CHAPTER, async (offset) => {
      const id = `${String(1_700_000_000_000 + offset).padStart(13, "0")}_autosave_${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${String(offset).padStart(12, "0")}`;
      await writeFile(join(versionDir, `${id}.md`), body, "utf-8");
    });

    await writePool(CHAPTERS, async (offset) => {
      const number = offset + 1;
      for (let version = 1; version <= ARTIFACTS_PER_CHAPTER; version += 1) {
        const artifactId = `write-chapter-${number}-${version}`;
        const dir = join(workflowDir, "artifacts", artifactId);
        await mkdir(dir, { recursive: true });
        const meta = {
          artifactId,
          stage: "write",
          scope: `chapter:${number}`,
          version,
          source: "generate",
          status: version === ARTIFACTS_PER_CHAPTER ? "candidate" : "archived",
          bodyPath: "body.md",
          inputRefs: [],
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, number, version)).toISOString(),
        };
        await writeFile(join(dir, "meta.json"), JSON.stringify(meta), "utf-8");
        await writeFile(join(dir, "body.md"), "候选\n", "utf-8");
      }
      const reportId = `report-${number}`;
      const reportDir = join(workflowDir, "reviews");
      await mkdir(reportDir, { recursive: true });
      await writeFile(join(reportDir, `${reportId}.json`), JSON.stringify({
        reportId,
        stage: "write",
        targetRefs: [`write-chapter-${number}-${ARTIFACTS_PER_CHAPTER}`],
        coverage: `第${number}章`,
        inputRefs: [],
        actualReviewModel: "bench",
        createdAt: "2026-02-01T00:00:00.000Z",
        summary: "过目",
        issues: [],
        stale: false,
        incomplete: false,
      }), "utf-8");
    });

    const store: AuthoringStoreRoot = { projectRoot, bookId: BOOK_ID };
    const beforeScan = await time("改前·工作流整目录", () => scanWorkflowIndex(workflowDir));
    expect(beforeScan.value.artifacts).toHaveLength(CHAPTERS * ARTIFACTS_PER_CHAPTER);
    expect(beforeScan.value.reports).toHaveLength(CHAPTERS);
    await ensureWorkflowIndex(workflowDir);

    const chapterLoad = await time("改后·落笔按章", () => loadAuthoringWorkspaceLists(store, { chapter: measuredChapter }));
    expect(chapterLoad.value.artifacts).toHaveLength(ARTIFACTS_PER_CHAPTER);
    expect(chapterLoad.value.reports).toHaveLength(1);
    const studyLoad = await time("改后·书房摘要", () => loadAuthoringWorkspaceLists(store, { summary: true }));
    expect(studyLoad.value.artifacts).toEqual([]);

    const coldVersions = await time("改前·版本全文", () => listChapterVersions(bookDir, measuredChapter));
    expect(coldVersions.value.length).toBeGreaterThan(0);
    const warmVersions = await time("改后·版本元数据", () => listChapterVersions(bookDir, measuredChapter));
    expect(warmVersions.value).toHaveLength(coldVersions.value.length);

    const beforeChapterLookup = await time("改前·章路径扫目录", async () => {
      const files = await readdir(chaptersDir);
      const padded = String(measuredChapter).padStart(4, "0");
      return files.find((file) => file.startsWith(`${padded}_`) && file.endsWith(".md"));
    });
    const afterChapterLookup = await time("改后·章路径查索引", () => resolveChapterFile(bookDir, measuredChapter));
    expect(afterChapterLookup.value?.fileName).toBe(beforeChapterLookup.value);

    const state = new StateManager(projectRoot);
    const bookGet = await time("落笔页·书籍接口", async () => {
      const book = await state.loadBookConfig(BOOK_ID);
      const chapters = await state.loadChapterIndex(BOOK_ID);
      const nextChapter = await state.getNextChapterNumber(BOOK_ID);
      return { title: book.title, chapters: chapters.length, nextChapter };
    });
    expect(bookGet.value.chapters).toBe(CHAPTERS);

    const autosave = await time("自动保存一章", () => storeAutosaveVersion(
      bookDir,
      measuredChapter,
      `${body}停笔`,
      new Date("2026-08-01T00:00:00.000Z"),
      { fresh: true, diskContent: body },
    ));
    expect(autosave.value.source === "autosave" || autosave.value.source === "manual").toBe(true);

    const writePageMs = bookGet.ms + chapterLoad.ms + afterChapterLookup.ms;
    const rows = [
      beforeScan,
      chapterLoad,
      studyLoad,
      coldVersions,
      warmVersions,
      beforeChapterLookup,
      afterChapterLookup,
      bookGet,
      autosave,
      { label: "落笔页打开（书籍接口+按章工作区+章路径）", ms: writePageMs },
    ];
    console.info(`\n[large-book] ${CHAPTERS}章 × ${CHAPTER_CHARS}字，每章 ${ARTIFACTS_PER_CHAPTER} 份候选`);
    for (const row of rows) console.info(`[large-book] ${row.label}: ${row.ms.toFixed(1)} ms`);

    expect(chapterLoad.ms).toBeLessThan(1000);
    expect(studyLoad.ms).toBeLessThan(1000);
    expect(writePageMs).toBeLessThan(1000);
    expect(warmVersions.ms).toBeLessThan(coldVersions.ms);
  }, 180_000);
});
