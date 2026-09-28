/**
 * Remember the chapter a book was last opened on, so 书房 can return there.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const PREFIX = "inkborne:last-chapter:";

export function rememberLastChapter(bookId: string, chapterNumber: number): void {
  if (typeof window === "undefined" || !bookId || !Number.isInteger(chapterNumber) || chapterNumber < 1) return;
  window.localStorage.setItem(`${PREFIX}${bookId}`, String(chapterNumber));
}

export function readLastChapter(bookId: string): number | null {
  if (typeof window === "undefined" || !bookId) return null;
  const raw = window.localStorage.getItem(`${PREFIX}${bookId}`);
  const chapter = Number(raw);
  return Number.isInteger(chapter) && chapter >= 1 ? chapter : null;
}
