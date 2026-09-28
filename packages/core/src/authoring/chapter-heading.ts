/**
 * Chapter-title lines at the start of a manuscript.
 * Models often echo the chapter number and title twice; only those
 * leading duplicates are removed. A later sentence that mentions the
 * same words stays in the body.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export interface ChapterHeadingInput {
  readonly chapterNumber?: number;
  readonly title?: string;
}

export interface ParsedChapterHeading {
  readonly chapterNumber: number;
  readonly title: string;
}

const CN_DIGIT: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const NUMBER = "\\d+|[零〇一二三四五六七八九十百两]+";
const WITH_TITLE = new RegExp(
  `^(?:第\\s*(${NUMBER})\\s*章|Chapter\\s+(\\d+))(?:\\s*[:：]\\s*|\\s+)(\\S.{0,39})\\s*$`,
  "i",
);
const BARE = new RegExp(`^(?:第\\s*(${NUMBER})\\s*章|Chapter\\s+(\\d+))\\s*$`, "i");

export function parseChapterNumberToken(raw: string): number | null {
  const text = raw.replace(/\s+/g, "");
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const value = Number.parseInt(text, 10);
    return value > 0 ? value : null;
  }
  const hundredAt = text.indexOf("百");
  if (hundredAt >= 0) {
    const hiRaw = text.slice(0, hundredAt);
    const hi = hiRaw ? CN_DIGIT[hiRaw] : 1;
    if (hi == null) return null;
    const rest = text.slice(hundredAt + 1);
    if (!rest) return hi * 100;
    if (rest.startsWith("零") || rest.startsWith("〇")) {
      const lo = parseSmallNumber(rest.slice(1));
      return lo == null ? null : hi * 100 + lo;
    }
    const lo = parseSmallNumber(rest);
    return lo == null ? null : hi * 100 + lo;
  }
  return parseSmallNumber(text);
}

function parseSmallNumber(text: string): number | null {
  if (!text) return 0;
  if (text === "十") return 10;
  if (text.startsWith("十")) {
    const lo = CN_DIGIT[text.slice(1)];
    return lo == null || text.length > 2 ? null : 10 + lo;
  }
  const tenAt = text.indexOf("十");
  if (tenAt >= 0) {
    const hi = CN_DIGIT[text.slice(0, tenAt)];
    const right = text.slice(tenAt + 1);
    const lo = right ? CN_DIGIT[right] : 0;
    if (hi == null || lo == null || (right.length > 1)) return null;
    return hi * 10 + lo;
  }
  if (text.length !== 1) return null;
  return CN_DIGIT[text] ?? null;
}

function unwrapHeadingLine(line: string): string {
  let text = line.trim().replace(/^#{1,6}\s*/, "");
  text = text.replace(/^\*\*(.+)\*\*$/u, "$1").replace(/^__(.+)__$/u, "$1").trim();
  const quoted = text.match(/^[「“"](.+)[」”"]$/u);
  if (quoted?.[1]) text = quoted[1].trim();
  return text.trim();
}

export function parseChapterHeadingLine(line: string): ParsedChapterHeading | null {
  const text = unwrapHeadingLine(line);
  if (!text) return null;
  const titled = WITH_TITLE.exec(text);
  if (titled) {
    const chapterNumber = parseChapterNumberToken(titled[1] || titled[2] || "");
    const title = (titled[3] ?? "").trim();
    if (!chapterNumber || !title) return null;
    if (/[。！？!?]/.test(title)) return null;
    return { chapterNumber, title };
  }
  const bare = BARE.exec(text);
  if (!bare) return null;
  const chapterNumber = parseChapterNumberToken(bare[1] || bare[2] || "");
  if (!chapterNumber) return null;
  return { chapterNumber, title: "" };
}

function headingAllowed(parsed: ParsedChapterHeading, chapterNumber: number | undefined): boolean {
  return chapterNumber == null || parsed.chapterNumber === chapterNumber;
}

function sameChapterHeading(left: ParsedChapterHeading, right: ParsedChapterHeading): boolean {
  if (left.chapterNumber !== right.chapterNumber) return false;
  const a = left.title.replace(/\s+/g, "");
  const b = right.title.replace(/\s+/g, "");
  return a === b || !a || !b;
}

function leadingHeading(
  lines: readonly string[],
  chapterNumber?: number,
): { index: number; parsed: ParsedChapterHeading } | undefined {
  let index = 0;
  while (index < lines.length && lines[index]!.trim() === "") index += 1;
  if (index >= lines.length) return undefined;
  const parsed = parseChapterHeadingLine(lines[index]!);
  if (!parsed || !headingAllowed(parsed, chapterNumber)) return undefined;
  return { index, parsed };
}

/**
 * Drop extra copies of the same chapter heading at the very start.
 * Returns the original text when nothing was repeated.
 */
export function collapseDuplicateChapterHeadings(body: string, input?: ChapterHeadingInput): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let index = 0;
  while (index < lines.length && lines[index]!.trim() === "") index += 1;
  const keptLines: string[] = [];
  const keptParsed: ParsedChapterHeading[] = [];
  let removed = false;
  while (index < lines.length) {
    const raw = lines[index]!;
    if (raw.trim() === "") {
      const next = lines[index + 1];
      const nextParsed = next ? parseChapterHeadingLine(next) : null;
      if (
        nextParsed
        && headingAllowed(nextParsed, input?.chapterNumber)
        && keptParsed.some((item) => sameChapterHeading(item, nextParsed))
      ) {
        index += 1;
        continue;
      }
      break;
    }
    const parsed = parseChapterHeadingLine(raw);
    if (!parsed || !headingAllowed(parsed, input?.chapterNumber)) break;
    if (keptParsed.some((item) => sameChapterHeading(item, parsed))) {
      removed = true;
      index += 1;
      continue;
    }
    keptLines.push(raw);
    keptParsed.push(parsed);
    index += 1;
  }
  if (!removed) return body;
  const rest = lines.slice(index).join("\n").replace(/^\n+/, "");
  const head = keptLines.join("\n");
  if (!head) return rest;
  return rest ? `${head}\n\n${rest}` : head;
}

export function hasLeadingChapterHeading(body: string, chapterNumber?: number): boolean {
  return Boolean(leadingHeading(body.replace(/\r\n/g, "\n").split("\n"), chapterNumber));
}

/** One heading for a chapter that is about to be stored. Does not invent a second line. */
export function ensureSingleChapterHeading(
  body: string,
  input: { readonly chapterNumber: number; readonly title?: string },
): string {
  const collapsed = collapseDuplicateChapterHeadings(body, input);
  if (hasLeadingChapterHeading(collapsed, input.chapterNumber)) return collapsed;
  const lines = collapsed.replace(/\r\n/g, "\n").split("\n");
  const other = leadingHeading(lines);
  if (other && other.parsed.chapterNumber !== input.chapterNumber) return collapsed;
  const title = input.title?.trim() ?? "";
  const heading = title ? `# 第${input.chapterNumber}章 ${title}` : `# 第${input.chapterNumber}章`;
  const rest = collapsed.replace(/^\uFEFF/, "").trim();
  if (!rest) return `${heading}\n`;
  return `${heading}\n\n${rest.endsWith("\n") ? rest : `${rest}\n`}`;
}

/** Reading view: the opening heading is the title, not the first paragraph. */
export function splitChapterHeading(
  body: string,
  chapterNumber?: number,
): { title: string; body: string } {
  const cleaned = collapseDuplicateChapterHeadings(body, chapterNumber != null ? { chapterNumber } : undefined);
  const match = leadingHeading(cleaned.replace(/\r\n/g, "\n").split("\n"), chapterNumber);
  if (!match) return { title: "", body: cleaned.trim() };
  const title = match.parsed.title
    ? `第${match.parsed.chapterNumber}章 ${match.parsed.title}`
    : `第${match.parsed.chapterNumber}章`;
  const lines = cleaned.replace(/\r\n/g, "\n").split("\n");
  const rest = lines.slice(match.index + 1).join("\n").trim();
  return { title, body: rest };
}
