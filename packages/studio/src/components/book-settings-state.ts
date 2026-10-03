/** SPDX-License-Identifier: AGPL-3.0-only */
export type BookSettingsStatus = "active" | "paused" | "completed" | "dropped";

export interface BookSettingsDraft {
  readonly status: BookSettingsStatus;
  readonly chapterWordCount: number;
  readonly targetChapters: number;
}

/** Four-stage length belongs to Ask even if a stale form contains length fields. */
export function buildBookSettingsUpdate(authoringBook: boolean, draft: BookSettingsDraft): Partial<BookSettingsDraft> | null {
  if (authoringBook) return { status: draft.status };
  if (!Number.isInteger(draft.chapterWordCount) || draft.chapterWordCount < 100
    || !Number.isInteger(draft.targetChapters) || draft.targetChapters < 1) return null;
  return { ...draft };
}
