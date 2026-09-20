/**
 * Merge adopted weave chapters with write candidate / adopted status.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { BookStepState } from "./book-stage";
import { parseVolumeMapTree } from "./volume-map-tree";

export type WriteChapterMark = "empty" | "candidate" | "adopted" | "adopted-new";

export interface WriteDirectoryChapter {
  readonly number: number;
  readonly title: string;
  readonly mark: WriteChapterMark;
  readonly wordCount: number;
}

export interface PersistedWriteChapter {
  readonly number: number;
  readonly title: string;
  readonly wordCount?: number;
}

export function writeChapterMark(input: {
  readonly candidateId?: string;
  readonly adoptedId?: string;
  readonly hasPersistedChapter?: boolean;
}): WriteChapterMark {
  const candidateId = input.candidateId?.trim() || undefined;
  const adoptedId = input.adoptedId?.trim() || undefined;
  if (adoptedId && candidateId && candidateId !== adoptedId) return "adopted-new";
  if (adoptedId) return "adopted";
  if (candidateId) return "candidate";
  if (input.hasPersistedChapter) return "adopted";
  return "empty";
}

export function writeMarkLabel(mark: WriteChapterMark, isZh: boolean): string {
  if (mark === "candidate") return isZh ? "有候选" : "candidate";
  if (mark === "adopted") return isZh ? "已采用" : "adopted";
  if (mark === "adopted-new") return isZh ? "已采用 · 新候选" : "adopted · new candidate";
  return isZh ? "未写" : "unwritten";
}

export function writeMarkDotState(mark: WriteChapterMark): BookStepState {
  if (mark === "adopted") return "done";
  if (mark === "candidate" || mark === "adopted-new") return "current";
  return "todo";
}

export function collectPlannedChapters(volumeMap: string): Map<number, string> {
  const tree = parseVolumeMapTree(volumeMap);
  const titles = new Map<number, string>();
  const remember = (number: number, title = "") => {
    if (!Number.isInteger(number) || number < 1) return;
    const previous = titles.get(number);
    if (previous == null || (!previous.trim() && title.trim())) titles.set(number, title);
  };
  for (const volume of tree.volumes) {
    if (volume.startChapter != null && volume.endChapter != null && volume.endChapter >= volume.startChapter) {
      for (let number = volume.startChapter; number <= volume.endChapter; number += 1) remember(number);
    }
    for (const chapter of volume.chapters) {
      if (chapter.kind === "range" && chapter.endChapter && chapter.endChapter >= chapter.chapterNumber) {
        for (let number = chapter.chapterNumber; number <= chapter.endChapter; number += 1) remember(number);
      }
      remember(chapter.chapterNumber, chapter.title);
    }
  }
  for (const chapter of tree.orphanChapters) {
    if (chapter.kind === "range" && chapter.endChapter && chapter.endChapter >= chapter.chapterNumber) {
      for (let number = chapter.chapterNumber; number <= chapter.endChapter; number += 1) remember(number);
    }
    remember(chapter.chapterNumber, chapter.title);
  }
  return titles;
}

export function mergeWriteDirectory(input: {
  readonly volumeMap?: string;
  readonly persisted?: ReadonlyArray<PersistedWriteChapter>;
  readonly candidates?: Readonly<Record<string, string>>;
  readonly adopted?: Readonly<Record<string, string>>;
}): WriteDirectoryChapter[] {
  const planned = collectPlannedChapters(input.volumeMap ?? "");
  const persisted = new Map((input.persisted ?? []).map((chapter) => [chapter.number, chapter]));
  const numbers = new Set<number>([...planned.keys(), ...persisted.keys()]);
  for (const key of Object.keys(input.candidates ?? {})) {
    const number = Number(key);
    if (Number.isInteger(number) && number > 0) numbers.add(number);
  }
  for (const key of Object.keys(input.adopted ?? {})) {
    const number = Number(key);
    if (Number.isInteger(number) && number > 0) numbers.add(number);
  }
  return [...numbers].sort((left, right) => left - right).map((number) => {
    const saved = persisted.get(number);
    return {
      number,
      title: planned.get(number)?.trim() || saved?.title || "",
      mark: writeChapterMark({
        candidateId: input.candidates?.[String(number)],
        adoptedId: input.adopted?.[String(number)],
        hasPersistedChapter: Boolean(saved),
      }),
      wordCount: saved?.wordCount ?? 0,
    };
  });
}

export function firstUnwrittenChapter(
  chapters: ReadonlyArray<WriteDirectoryChapter>,
  fallback: number,
): number {
  const empty = chapters.find((chapter) => chapter.mark === "empty");
  if (empty) return empty.number;
  return Number.isInteger(fallback) && fallback > 0 ? fallback : 1;
}
