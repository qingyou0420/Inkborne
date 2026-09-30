/**
 * TXT 导出的清洗：去掉 Markdown，整理成能贴进番茄等平台后台的段落。
 *
 * 默认：
 * - 段间空一行。网页编辑器粘贴纯文本时，单个换行经常被并成同一段；空一行才能稳稳切开。
 * - 段首不缩进。阅读器自己会首行缩进，再写两个全角空格容易叠成双缩进。
 * 这两项都可以关掉或打开。标题行不缩进。
 * 分节符（---、***、空行横线等）先整行认出来，再统一写成一行 `* * *`，不加段首缩进。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export interface FanqieStyle {
  /** 段与段之间空一行。默认开。 */
  readonly blankLine?: boolean;
  /** 段首加两个全角空格。默认关。 */
  readonly indent?: boolean;
}

export interface FanqieExportOptions extends FanqieStyle {
  readonly fromChapter?: number;
  readonly toChapter?: number;
  readonly layout?: "combined" | "per-chapter";
}

export interface FanqieChapterFile {
  readonly fileName: string;
  readonly text: string;
}

export interface FanqieManuscript {
  readonly combined: string;
  readonly files: ReadonlyArray<FanqieChapterFile>;
  readonly chaptersExported: number;
  readonly numbered: boolean;
}

/** 纯文本里的分节符。星号加空格，便于居中，也不会被当成 Markdown 横线或一长串破折号。 */
export const SCENE_BREAK = "* * *";

const AUTHOR_NOTE_RE = /^(?:#{1,6}[ \t]+)?(?:【|\[)?(?:作者有话说|作者的话|作者说|作者备注)(?:】|\])?(?:[ \t]*[:：].*)?$/;
const OUTLINE_HEADING_RE = /^(?:#{1,6}[ \t]+)?(?:【|\[)?(?:章纲|本章纲要|本章细纲|本章大纲|细纲|写作备注)(?:】|\])?[ \t]*[:：]?[ \t]*$/;
const CHAPTER_HEADING_RE = /^(?:#{1,6}[ \t]+)?第[ \t]*([0-9]+|[零〇一二三四五六七八九十百千两]+)[ \t]*章(?:[ \t]*[:：.．\-—][ \t]*|[ \t]+)?(.*)$/;
const ENGLISH_HEADING_RE = /^(?:#{1,6}[ \t]+)?Chapter[ \t]+(\d+)[ \t]*[:：.．\-—]?[ \t]*(.*)$/i;

export function resolveFanqieStyle(style?: FanqieStyle): { blankLine: boolean; indent: boolean } {
  return {
    blankLine: style?.blankLine !== false,
    indent: style?.indent === true,
  };
}

export function fanqieOptionsFromQuery(input: {
  readonly from?: string | null;
  readonly to?: string | null;
  readonly layout?: string | null;
  readonly blankLine?: string | null;
  readonly indent?: string | null;
}): FanqieExportOptions {
  const fromChapter = parseChapterQuery(input.from);
  const toChapter = parseChapterQuery(input.to);
  if (fromChapter !== undefined && toChapter !== undefined && fromChapter > toChapter) {
    throw new Error("起始章不能大于结束章。");
  }
  if (input.layout && input.layout !== "combined" && input.layout !== "per-chapter") {
    throw new Error("排版方式只能是合成一个文件，或一章一个文件。");
  }
  return {
    ...(fromChapter !== undefined ? { fromChapter } : {}),
    ...(toChapter !== undefined ? { toChapter } : {}),
    layout: input.layout === "per-chapter" ? "per-chapter" : "combined",
    blankLine: input.blankLine !== "0",
    indent: input.indent === "1",
  };
}

export function fanqieChapterHeading(chapterNumber: number, title: string): string {
  const bare = stripRepeatedChapterPrefix(title, chapterNumber);
  if (!bare) return `第${chapterNumber}章`;
  return `第${chapterNumber}章 ${bare}`;
}

export function fanqieChapterFileName(chapterNumber: number, title: string): string {
  const padded = String(chapterNumber).padStart(4, "0");
  const bare = stripRepeatedChapterPrefix(title, chapterNumber) || "未命名";
  return `第${padded}章 ${sanitizeFilePart(bare)}.txt`;
}

export function fanqieDownloadName(title: string, layout: "combined" | "per-chapter"): string {
  const safe = sanitizeFilePart(title || "书");
  return layout === "per-chapter" ? `${safe}.zip` : `${safe}.txt`;
}

export function renderFanqieChapter(input: {
  readonly chapterNumber: number;
  readonly title?: string;
  readonly markdown: string;
  readonly style?: FanqieStyle;
}): string {
  const title = resolveFanqieTitle(input.markdown, input.chapterNumber, input.title ?? "");
  const heading = fanqieChapterHeading(input.chapterNumber, title);
  const paragraphs = extractParagraphs(input.markdown, {
    chapterNumber: input.chapterNumber,
    title,
  });
  return joinHeadingAndParagraphs(heading, paragraphs, resolveFanqieStyle(input.style));
}

export function describeFanqieManuscript(markdown: string, title: string): {
  readonly numbered: boolean;
  readonly chapters: ReadonlyArray<{ readonly number: number; readonly title: string }>;
} {
  const split = splitManuscript(markdown, title);
  return {
    numbered: split.numbered,
    chapters: split.pieces.map((piece) => ({ number: piece.number, title: piece.title })),
  };
}

export function renderFanqieManuscript(input: {
  readonly title: string;
  readonly markdown: string;
  readonly style?: FanqieStyle;
  readonly fromChapter?: number;
  readonly toChapter?: number;
}): FanqieManuscript {
  const style = resolveFanqieStyle(input.style);
  const split = splitManuscript(input.markdown, input.title);
  const selected = split.pieces.filter((piece) => inRange(piece.number, input.fromChapter, input.toChapter));
  if (input.fromChapter !== undefined && input.toChapter !== undefined && input.fromChapter > input.toChapter) {
    throw new Error("起始章不能大于结束章。");
  }
  if (selected.length === 0) {
    throw new Error("没有可导出的章节。");
  }

  const files: FanqieChapterFile[] = [];
  const used = new Set<string>();
  const chapterTexts: string[] = [];
  for (const piece of selected) {
    const text = piece.numbered
      ? renderFanqieChapter({
        chapterNumber: piece.number,
        title: piece.title,
        markdown: piece.markdown,
        style,
      })
      : renderUntitledPiece(piece.title, piece.markdown, style);
    if (!text.trim()) continue;
    chapterTexts.push(text);
    const fileName = piece.numbered
      ? fanqieChapterFileName(piece.number, piece.title)
      : `${sanitizeFilePart(piece.title || input.title || "正文")}.txt`;
    files.push({ fileName: uniqueFileName(fileName, used), text: `${text.trim()}\n` });
  }
  if (files.length === 0) {
    throw new Error("没有可导出的正文。");
  }

  const preface = split.numbered
    ? prefaceParagraphs(split.preface, input.title)
    : [];
  const includePreface = preface.length > 0 && (input.fromChapter === undefined || input.fromChapter <= 1);
  const body = [
    ...(includePreface ? [joinHeadingAndParagraphs("", preface, style)] : []),
    ...chapterTexts,
  ].filter((part) => part.trim());
  const workTitle = input.title.trim();
  const combined = workTitle && normalizeText(body[0]?.split("\n")[0] ?? "") !== normalizeText(workTitle)
    ? [workTitle, ...body].join("\n\n")
    : body.join("\n\n");

  return {
    combined: `${combined.trim()}\n`,
    files,
    chaptersExported: files.length,
    numbered: split.numbered,
  };
}

function renderUntitledPiece(title: string, markdown: string, style: { blankLine: boolean; indent: boolean }): string {
  const paragraphs = extractParagraphs(markdown, { title });
  return joinHeadingAndParagraphs(title.trim(), paragraphs, style);
}

function joinHeadingAndParagraphs(
  heading: string,
  paragraphs: readonly string[],
  style: { blankLine: boolean; indent: boolean },
): string {
  const body = paragraphs.map((paragraph) => {
    if (paragraph === SCENE_BREAK) return paragraph;
    return style.indent ? `\u3000\u3000${paragraph}` : paragraph;
  });
  const separator = style.blankLine ? "\n\n" : "\n";
  const parts = [heading.trim(), body.join(separator)].filter((part) => part.length > 0);
  if (!style.blankLine) return parts.join("\n").trim();
  return parts.join("\n\n").trim();
}

function extractParagraphs(
  markdown: string,
  identity: { readonly chapterNumber?: number; readonly title: string },
): string[] {
  const prepared = stripFencedCode(stripFrontmatter(markdown).replace(/<!--[\s\S]*?-->/g, ""));
  const kept = stripNotes(prepared.split(/\r?\n/));
  const body = stripLeadingTitles(kept, identity);
  const paragraphs: string[] = [];
  let pendingBreak = false;
  let seenBody = false;
  for (const line of body) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isSceneBreakLine(trimmed)) {
      if (seenBody) pendingBreak = true;
      continue;
    }
    const text = stripInlineMarkdown(line).trim();
    if (!text) continue;
    if (pendingBreak) {
      paragraphs.push(SCENE_BREAK);
      pendingBreak = false;
    }
    paragraphs.push(text);
    seenBody = true;
  }
  return paragraphs;
}

const HORIZONTAL_LINE_CHARS = new Set(["—", "―", "─"]);

/** Whole line is a scene break. Checked before inline Markdown is stripped. */
function isSceneBreakLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let kind: "ascii" | "horizontal" | "equals" | "" = "";
  let marker = "";
  let count = 0;
  for (const char of trimmed) {
    if (char === " " || char === "\t" || char === "\u3000") continue;
    if (char === "-" || char === "*" || char === "_") {
      if (kind !== "" && kind !== "ascii") return false;
      if (marker && char !== marker) return false;
      kind = "ascii";
      marker = char;
      count += 1;
      continue;
    }
    if (HORIZONTAL_LINE_CHARS.has(char)) {
      if (kind !== "" && kind !== "horizontal") return false;
      kind = "horizontal";
      count += 1;
      continue;
    }
    if (char === "=") {
      if (kind !== "" && kind !== "equals") return false;
      kind = "equals";
      count += 1;
      continue;
    }
    return false;
  }
  if (kind === "ascii") return count >= 3;
  if (kind === "horizontal") return count >= 2;
  if (kind === "equals") return count >= 3;
  return false;
}

function prefaceParagraphs(markdown: string, bookTitle: string): string[] {
  const paragraphs = extractParagraphs(markdown, { title: bookTitle });
  if (paragraphs.length === 1 && normalizeText(paragraphs[0] ?? "") === normalizeText(bookTitle)) return [];
  return paragraphs;
}

interface ManuscriptPiece {
  readonly number: number;
  readonly title: string;
  readonly markdown: string;
  readonly numbered: boolean;
}

function splitManuscript(markdown: string, fallbackTitle: string): {
  preface: string;
  numbered: boolean;
  pieces: ManuscriptPiece[];
} {
  const lines = markdown.split(/\r?\n/);
  const starts: number[] = [];
  let openNumber: number | undefined;
  let openTitle = "";
  let sawBody = false;
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseChapterHeading(lines[index] ?? "");
    if (!parsed) {
      if ((lines[index] ?? "").trim()) sawBody = true;
      continue;
    }
    const duplicateTitle = openNumber === parsed.number
      && normalizeText(parsed.rest) === normalizeText(openTitle)
      && !sawBody;
    if (duplicateTitle) continue;
    starts.push(index);
    openNumber = parsed.number;
    openTitle = parsed.rest;
    sawBody = false;
  }
  if (starts.length === 0) {
    return {
      preface: "",
      numbered: false,
      pieces: [{
        number: 1,
        title: fallbackTitle.trim() || "正文",
        markdown,
        numbered: false,
      }],
    };
  }
  const first = starts[0] ?? 0;
  const pieces: ManuscriptPiece[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index] ?? 0;
    const end = starts[index + 1] ?? lines.length;
    const parsed = parseChapterHeading(lines[start] ?? "");
    const number = parsed?.number ?? index + 1;
    const title = parsed?.rest.trim() || fallbackTitle.trim() || `第${number}章`;
    pieces.push({
      number,
      title,
      markdown: lines.slice(start, end).join("\n"),
      numbered: true,
    });
  }
  return {
    preface: lines.slice(0, first).join("\n"),
    numbered: true,
    pieces,
  };
}

function inRange(number: number, fromChapter: number | undefined, toChapter: number | undefined): boolean {
  if (fromChapter !== undefined && number < fromChapter) return false;
  if (toChapter !== undefined && number > toChapter) return false;
  return true;
}

function stripNotes(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const trimmed = (lines[index] ?? "").trim();
    if (AUTHOR_NOTE_RE.test(trimmed)) break;
    if (OUTLINE_HEADING_RE.test(trimmed)) {
      index = consumeOutline(lines, index);
      continue;
    }
    kept.push(lines[index] ?? "");
    index += 1;
  }
  return kept;
}

function consumeOutline(lines: readonly string[], start: number): number {
  let index = start + 1;
  let sawBlank = false;
  while (index < lines.length) {
    const next = (lines[index] ?? "").trim();
    if (!next) {
      sawBlank = true;
      index += 1;
      continue;
    }
    if (AUTHOR_NOTE_RE.test(next) || parseChapterHeading(next) || OUTLINE_HEADING_RE.test(next)) return index;
    if (isListLine(next)) {
      index += 1;
      continue;
    }
    if (sawBlank || next.length >= 80) return index;
    index += 1;
  }
  return index;
}

function stripLeadingTitles(
  lines: readonly string[],
  identity: { readonly chapterNumber?: number; readonly title: string },
): string[] {
  let index = 0;
  while (index < lines.length) {
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (isTitleLine(trimmed, identity)) {
      index += 1;
      continue;
    }
    break;
  }
  return lines.slice(index);
}

function isTitleLine(
  line: string,
  identity: { readonly chapterNumber?: number; readonly title: string },
): boolean {
  const bareLine = line.replace(/^#{1,6}[ \t]+/, "").trim();
  if (!bareLine) return false;
  const title = identity.title.trim();
  if (identity.chapterNumber !== undefined) {
    const canonical = fanqieChapterHeading(identity.chapterNumber, title);
    if (normalizeText(bareLine) === normalizeText(canonical)) return true;
    const parsed = parseChapterHeading(line);
    if (parsed && parsed.number === identity.chapterNumber) {
      const rest = parsed.rest.trim();
      const bareTitle = stripRepeatedChapterPrefix(title, identity.chapterNumber);
      if (!rest) return true;
      if (bareTitle && normalizeText(rest) === normalizeText(bareTitle)) return true;
      if (title && normalizeText(rest) === normalizeText(title)) return true;
    }
  }
  if (title && normalizeText(bareLine) === normalizeText(title)) return true;
  return false;
}

export function resolveFanqieTitle(markdown: string, chapterNumber: number, fallbackTitle: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseChapterHeading(trimmed);
    if (parsed && parsed.number === chapterNumber && parsed.rest.trim()) return parsed.rest.trim();
    break;
  }
  return fallbackTitle.trim();
}

function parseChapterHeading(line: string): { number: number; rest: string } | undefined {
  const trimmed = line.trim();
  const chinese = trimmed.match(CHAPTER_HEADING_RE);
  if (chinese) {
    const number = parseChapterToken(chinese[1] ?? "");
    if (number === undefined) return undefined;
    return { number, rest: (chinese[2] ?? "").trim() };
  }
  const english = trimmed.match(ENGLISH_HEADING_RE);
  if (english) {
    const number = Number(english[1]);
    if (!Number.isInteger(number) || number < 1) return undefined;
    return { number, rest: (english[2] ?? "").trim() };
  }
  return undefined;
}

function stripRepeatedChapterPrefix(title: string, chapterNumber: number): string {
  let text = title.replace(/^#{1,6}[ \t]+/, "").trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parsed = parseChapterHeading(text);
    if (!parsed || parsed.number !== chapterNumber) break;
    text = parsed.rest.trim();
  }
  return text;
}

function parseChapterToken(token: string): number | undefined {
  if (/^\d+$/.test(token)) {
    const value = Number(token);
    return value >= 1 ? value : undefined;
  }
  return parseChineseNumber(token);
}

function parseChineseNumber(input: string): number | undefined {
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let current = 0;
  let seen = false;
  for (const char of input) {
    if (char in digits) {
      current = digits[char] ?? 0;
      seen = true;
      continue;
    }
    const unit = units[char];
    if (!unit) return undefined;
    seen = true;
    total += (current === 0 ? 1 : current) * unit;
    current = 0;
  }
  if (!seen) return undefined;
  const value = total + current;
  return value >= 1 ? value : undefined;
}

function stripInlineMarkdown(line: string): string {
  let text = line.replace(/^#{1,6}[ \t]+/, "");
  text = text.replace(/^[ \t]*>[ \t]?/, "");
  text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/, "");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/(\*\*|__)([\s\S]*?)\1/g, "$2");
  text = text.replace(/(^|[^\w])[*_]([^*\n_]+?)[*_](?=[^\w]|$)/g, "$1$2");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/~~([^~\n]+?)~~/g, "$1");
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  text = text.replace(/\*\*|__|~~/g, "");
  return text;
}

/** Drop fence marker lines and keep the text inside. Plain-text export has no code blocks. */
function stripFencedCode(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .filter((line) => !/^[ \t]*```/.test(line))
    .join("\n");
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) return markdown;
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? markdown.slice(match[0].length) : markdown;
}

function isListLine(line: string): boolean {
  return /^(?:[-*+]|\d+[.)])[ \t]+/.test(line) || /^>[ \t]?/.test(line);
}

function normalizeText(value: string): string {
  return value.replace(/[\s:：.．\-—]/g, "").trim();
}

function sanitizeFilePart(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 40) || "未命名";
}

function uniqueFileName(fileName: string, used: Set<string>): string {
  if (!used.has(fileName)) {
    used.add(fileName);
    return fileName;
  }
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  let index = 2;
  while (used.has(`${stem}-${index}${ext}`)) index += 1;
  const next = `${stem}-${index}${ext}`;
  used.add(next);
  return next;
}

function parseChapterQuery(value: string | null | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value.trim())) throw new Error("章号得是正整数。");
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error("章号得是正整数。");
  return number;
}
