import { access, mkdir, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isLightweightAuthoringBook } from "../authoring/context.js";
import { loadSerialLedger, SerialLedgerSchema } from "../authoring/serial-ledger.js";
import { loadManifest, renderManifest, type AuthoringStoreRoot } from "../authoring/store.js";
import { commitAtomicFileSet, type AtomicFileWrite } from "../utils/atomic-file-set.js";
import type { ChapterMeta } from "../models/chapter.js";
import { toPosixPath } from "../utils/posix-path.js";

export interface ChapterDeleteDeps {
  bookDir(bookId: string): string;
  loadChapterIndex(bookId: string): Promise<ReadonlyArray<ChapterMeta>>;
  rollbackToChapter(bookId: string, targetChapter: number): Promise<ReadonlyArray<number>>;
}

export interface DeleteLatestChapterOptions {
  /** Must equal the latest chapter number; defaults to it. Middle chapters are not deletable. */
  readonly chapterNumber?: number;
}

export interface DeleteLatestChapterResult {
  readonly bookId: string;
  readonly deletedChapter: number;
  readonly title: string;
  /** Book-relative POSIX paths of chapter files preserved under chapters/.trash/. */
  readonly trashedFiles: ReadonlyArray<string>;
  readonly rolledBackTo: number;
  readonly discarded: ReadonlyArray<number>;
}

/**
 * Delete the latest chapter of a book: the chapter markdown is preserved under
 * chapters/.trash/ (never hard-deleted), then the index, snapshots, runtime
 * artifacts, and story state are rolled back to the previous chapter via the
 * same rollback mechanism the review-reject flow uses.
 *
 * Only the latest chapter is deletable — removing a middle chapter would
 * require renumbering every later chapter and replaying state on top of it.
 */
export async function deleteLatestChapter(
  deps: ChapterDeleteDeps,
  bookId: string,
  options: DeleteLatestChapterOptions = {},
): Promise<DeleteLatestChapterResult> {
  const index = await deps.loadChapterIndex(bookId);
  if (index.length === 0) {
    throw new Error(`Book "${bookId}" has no chapters to delete.`);
  }

  const latest = index.reduce((max, chapter) => Math.max(max, chapter.number), 0);
  const requested = options.chapterNumber ?? latest;
  if (requested !== latest) {
    throw new Error(
      `Only the latest chapter (${latest}) can be deleted, but chapter ${requested} was requested. `
      + "Deleting a middle chapter would require renumbering later chapters and replaying state.",
    );
  }

  const bookDir = deps.bookDir(bookId);
  const rollbackTarget = latest - 1;
  const lightweight = await isLightweightAuthoringBook(bookDir);

  if (!lightweight) {
    // Verify the rollback snapshot is usable BEFORE touching any file, so a
    // failed restore cannot leave the book half-deleted.
    for (const required of ["current_state.md", "pending_hooks.md"]) {
      const snapshotFile = join(bookDir, "story", "snapshots", String(rollbackTarget), required);
      try {
        await stat(snapshotFile);
      } catch {
        throw new Error(
          `Cannot delete chapter ${latest}: the state snapshot for chapter ${rollbackTarget} is missing `
          + `(story/snapshots/${rollbackTarget}/${required}). Nothing was changed.`,
        );
      }
    }
  }

  // Preserve the chapter markdown in chapters/.trash/ instead of hard-deleting.
  const chaptersDir = join(bookDir, "chapters");
  const trashDir = join(chaptersDir, ".trash");
  const chapterFiles = (await readdir(chaptersDir)).filter((file) => {
    const match = file.match(/^(\d+)[_-]?.*\.md$/);
    return match !== null && parseInt(match[1]!, 10) === latest;
  });

  const trashedFiles: string[] = [];
  if (chapterFiles.length > 0) {
    await mkdir(trashDir, { recursive: true });
  }
  for (const file of chapterFiles) {
    const trashedName = await pickAvailableName(trashDir, file);
    await rename(join(chaptersDir, file), join(trashDir, trashedName));
    trashedFiles.push(toPosixPath(join("chapters", ".trash", trashedName)));
  }

  const discarded = lightweight
    ? await deleteLightweightChapterMemory(bookDir, bookId, latest, index)
    : await deps.rollbackToChapter(bookId, rollbackTarget);
  const entry = index.find((chapter) => chapter.number === latest);

  return {
    bookId,
    deletedChapter: latest,
    title: entry?.title ?? `第${latest}章`,
    trashedFiles,
    rolledBackTo: rollbackTarget,
    discarded,
  };
}

async function deleteLightweightChapterMemory(
  bookDir: string,
  bookId: string,
  chapterNumber: number,
  index: ReadonlyArray<ChapterMeta>,
): Promise<ReadonlyArray<number>> {
  const nextIndex = index.filter((chapter) => chapter.number !== chapterNumber);
  const root: AuthoringStoreRoot = { projectRoot: dirname(dirname(bookDir)), bookId };
  const writes: AtomicFileWrite[] = [{
    relativePath: "chapters/index.json",
    content: `${JSON.stringify(nextIndex, null, 2)}\n`,
  }];
  try {
    const manifest = await loadManifest(root);
    const adoptedWrite = { ...manifest.adopted.write };
    const candidateWrite = { ...manifest.candidates.write };
    delete adoptedWrite[String(chapterNumber)];
    delete candidateWrite[String(chapterNumber)];
    writes.push({
      relativePath: "story/workflow/manifest.json",
      content: renderManifest({
        ...manifest,
        adopted: { ...manifest.adopted, write: adoptedWrite },
        candidates: { ...manifest.candidates, write: candidateWrite },
        coverage: {
          ...manifest.coverage,
          chaptersWrittenAdopted: Object.keys(adoptedWrite).length,
        },
      }),
    });
  } catch {
    /* books without a workflow manifest still drop the chapter file and index */
  }
  try {
    const ledger = await loadSerialLedger(bookDir);
    if (ledger) {
      writes.push({
        relativePath: "story/state/serial-ledger.json",
        content: `${JSON.stringify(SerialLedgerSchema.parse({
          ...ledger,
          updatedAt: new Date().toISOString(),
          chapters: ledger.chapters.filter((chapter) => chapter.chapter !== chapterNumber),
        }), null, 2)}\n`,
      });
    }
  } catch {
    /* corrupt ledger keeps its bytes; index and adopted pointers still drop this chapter */
  }
  await commitAtomicFileSet({
    rootDir: bookDir,
    writes,
    deletes: [
      `story/state/chapter-${chapterNumber}.md`,
      `story/state/chapter-${chapterNumber}.ref.json`,
    ],
  });
  return [chapterNumber];
}

async function pickAvailableName(dir: string, fileName: string): Promise<string> {
  const dot = fileName.lastIndexOf(".");
  const base = dot === -1 ? fileName : fileName.slice(0, dot);
  const ext = dot === -1 ? "" : fileName.slice(dot);
  let candidate = fileName;
  for (let suffix = 2; await pathExists(join(dir, candidate)); suffix += 1) {
    candidate = `${base}-${suffix}${ext}`;
  }
  return candidate;
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}
