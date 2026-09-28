/**
 * Chapter range for a Tomato export. Empty bounds mean the whole book.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function fanqieRangeProblem(from: string, to: string, chapterCount: number, isZh: boolean): string {
  const startRaw = from.trim();
  const endRaw = to.trim();
  if (!startRaw && !endRaw) return "";
  const parse = (raw: string): number | "empty" | "invalid" => {
    if (!raw) return "empty";
    if (!/^[1-9]\d*$/.test(raw)) return "invalid";
    return Number(raw);
  };
  const start = parse(startRaw);
  const end = parse(endRaw);
  if (start === "invalid" || end === "invalid") {
    return isZh ? "章范围要填正整数" : "Chapter range must be a positive integer";
  }
  const startN = start === "empty" ? 1 : start;
  const endN = end === "empty" ? Math.max(chapterCount, startN) : end;
  if (chapterCount > 0 && (startN > chapterCount || endN > chapterCount)) {
    return isZh ? "章范围超出这本书的章数" : "Chapter range is past the end of this book";
  }
  if (startN > endN) {
    return isZh ? "起始章不能大于结束章" : "The start chapter cannot be after the end chapter";
  }
  return "";
}
