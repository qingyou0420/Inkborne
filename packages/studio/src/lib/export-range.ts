/**
 * Chapter-range drafts for export. Typing keeps the raw string; clamp and
 * swap happen when the field is committed (blur or Enter). Stepping clamps
 * immediately because that click or arrow key is itself a commit.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Fold fullwidth ASCII (digits, dot, minus) into halfwidth. */
function canonicalizeNumericDraft(raw: string): string {
  return raw.trim().replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
}

/**
 * Read a typed chapter draft. Does not clamp and does not invent a replacement
 * string — callers that are still editing must keep `raw` as-is.
 * Empty or non-numeric drafts are null. Decimals truncate toward zero.
 */
export function parseChapterDraft(raw: string): number | null {
  const text = canonicalizeNumericDraft(raw);
  if (!text || !/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const value = Math.trunc(Number(text));
  return Number.isFinite(value) ? value : null;
}

function upperBound(chapterCount: number): number {
  if (!Number.isFinite(chapterCount) || chapterCount < 1) return 0;
  return Math.floor(chapterCount);
}

/**
 * Commit one bound. Empty stays empty (no limit). Non-numeric stays empty
 * rather than guessing chapter 1. 0, negatives, and fractions below 1 become 1.
 * When chapterCount is missing or 0, only the lower bound applies.
 */
export function normalizeRangeField(raw: string, chapterCount: number): string {
  const parsed = parseChapterDraft(raw);
  if (parsed === null) return "";
  const lower = Math.max(1, parsed);
  const upper = upperBound(chapterCount);
  return String(upper > 0 ? Math.min(lower, upper) : lower);
}

export function normalizeRange(from: string, to: string, chapterCount: number): {
  readonly from: string;
  readonly to: string;
  readonly swapped: boolean;
} {
  let start = normalizeRangeField(from, chapterCount);
  let end = normalizeRangeField(to, chapterCount);
  let swapped = false;
  if (start && end && Number(start) > Number(end)) {
    const previous = start;
    start = end;
    end = previous;
    swapped = true;
  }
  return { from: start, to: end, swapped };
}

function clampChapter(value: number, chapterCount: number): number {
  const lower = Math.max(1, value);
  const upper = upperBound(chapterCount);
  return upper > 0 ? Math.min(lower, upper) : lower;
}

/**
 * Step one bound. Empty or non-numeric text does not continue from a guessed
 * number: plus on "from" starts at 1, plus on "to" starts at the chapter total
 * (or 1 when the total is unknown), and minus lands on 1. A parsed value
 * (fullwidth digits included) moves by `delta`, then clamps to 1..chapterCount.
 * An unknown total only clamps the lower bound.
 */
export function stepRangeField(
  raw: string,
  delta: number,
  chapterCount: number,
  kind: "from" | "to",
): string {
  const step = Number.isFinite(delta) ? delta : 0;
  const parsed = parseChapterDraft(raw);
  if (parsed === null) {
    if (step < 0) return "1";
    const upper = upperBound(chapterCount);
    if (kind === "to" && upper > 0) return String(upper);
    return "1";
  }
  return String(clampChapter(parsed + step, chapterCount));
}

/** Highest chapter number. An empty list is 0, so chapters 1 and 3 stay 3 rather than 2. */
export function maxChapterNumber(chapters: ReadonlyArray<{ readonly number: number }>): number {
  let max = 0;
  for (const chapter of chapters) {
    if (Number.isFinite(chapter.number) && chapter.number > max) max = chapter.number;
  }
  return max;
}
