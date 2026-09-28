/**
 * Group a long chapter table by volume, then filter by chapter number or title.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  findMatchingVolumeForChapter,
  formatVolumeLabel,
  type VolumeMapTree,
} from "@actalk/inkos-core/volume-map-tree";

export const CHAPTER_TABLE_VIRTUAL_THRESHOLD = 100;

export interface ChapterTableGroup<T> {
  readonly id: string;
  readonly title: string;
  readonly chapters: readonly T[];
}

export function buildChapterGroups<T extends { readonly number: number; readonly title: string }>(
  chapters: readonly T[],
  tree: VolumeMapTree | null,
  isZh: boolean,
): ChapterTableGroup<T>[] {
  if (chapters.length === 0) return [];
  if (!tree || tree.volumes.length === 0) {
    return [{ id: "all", title: isZh ? "全部章节" : "All chapters", chapters }];
  }
  const buckets = new Map<string, T[]>();
  for (const volume of tree.volumes) buckets.set(volume.id, []);
  const ungrouped: T[] = [];
  for (const chapter of chapters) {
    const volume = findMatchingVolumeForChapter(tree, chapter.number);
    if (!volume) {
      ungrouped.push(chapter);
      continue;
    }
    buckets.get(volume.id)?.push(chapter);
  }
  const groups: ChapterTableGroup<T>[] = [];
  for (const volume of tree.volumes) {
    const rows = buckets.get(volume.id) ?? [];
    if (rows.length === 0) continue;
    groups.push({
      id: volume.id,
      title: formatVolumeLabel(volume.volumeNumber, volume.title, isZh),
      chapters: rows,
    });
  }
  if (ungrouped.length > 0) {
    groups.push({
      id: "ungrouped",
      title: isZh ? "未分卷" : "Ungrouped",
      chapters: ungrouped,
    });
  }
  return groups;
}

export function filterChapterGroups<T extends { readonly number: number; readonly title: string }>(
  groups: readonly ChapterTableGroup<T>[],
  query: string,
): ChapterTableGroup<T>[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups.map((group) => ({ ...group, chapters: group.chapters }));
  return groups.flatMap((group) => {
    const chapters = group.chapters.filter((chapter) => {
      const haystack = `${chapter.number} ${chapter.title} 第${chapter.number}章 chapter ${chapter.number}`.toLowerCase();
      return haystack.includes(needle);
    });
    return chapters.length > 0 ? [{ ...group, chapters }] : [];
  });
}

export function defaultOpenGroupId<T extends { readonly number: number }>(
  groups: readonly ChapterTableGroup<T>[],
  focusChapter: number,
): string | null {
  const match = groups.find((group) => group.chapters.some((chapter) => chapter.number === focusChapter));
  return match?.id ?? groups[groups.length - 1]?.id ?? null;
}
