/**
 * A hand edit keeps the chapter number from the moment it was typed.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export interface PendingChapterEdit {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly content: string;
  readonly artifactId?: string;
}

export function trackChapterEdit(
  bookId: string,
  chapterNumber: number,
  content: string,
  baseline: string,
  artifactId?: string,
): PendingChapterEdit | null {
  if (content === baseline) return null;
  return {
    bookId,
    chapterNumber,
    content,
    ...(artifactId ? { artifactId } : {}),
  };
}

export function chapterEditRequest(pending: PendingChapterEdit): {
  bookId: string;
  chapterNumber: number;
  content: string;
  artifactId?: string;
  autosave: true;
} {
  return {
    bookId: pending.bookId,
    chapterNumber: pending.chapterNumber,
    content: pending.content,
    ...(pending.artifactId ? { artifactId: pending.artifactId } : {}),
    autosave: true,
  };
}
