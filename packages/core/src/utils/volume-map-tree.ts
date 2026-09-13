/**
 * Parse volume_map.md into a 卷→章 tree and apply in-place edits.
 * G1 still requires a real chapter entry; this parser does not invent one.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type VolumeMapNodeKind = "volume" | "chapter" | "range" | "note";

export const MAX_VOLUME_TREE_LABEL_CHARS = 22;
export const MAX_CHAPTER_TITLE_CHARS = 12;
export const HARD_CHAPTER_TITLE_CHARS = 20;

export function chapterTitleLimit(language?: "zh" | "en"): number {
  return language === "en" ? MAX_CHAPTER_TITLE_CHARS * 2 : MAX_CHAPTER_TITLE_CHARS;
}

export interface VolumeMapChapterNode {
  readonly kind: "chapter" | "range";
  readonly id: string;
  readonly chapterNumber: number;
  readonly endChapter?: number;
  readonly title: string;
  readonly summary: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface VolumeMapNoteNode {
  readonly kind: "note";
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface VolumeMapVolumeNode {
  readonly kind: "volume";
  readonly id: string;
  readonly volumeNumber: number | null;
  readonly title: string;
  readonly okr: string;
  /** Full pre-chapter volume body (OKR + notes). Unedited lines stay in canon. */
  readonly body: string;
  readonly startChapter?: number;
  readonly endChapter?: number;
  readonly chapters: ReadonlyArray<VolumeMapChapterNode>;
  readonly notes: ReadonlyArray<VolumeMapNoteNode>;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface VolumeMapTree {
  readonly volumes: ReadonlyArray<VolumeMapVolumeNode>;
  readonly orphanChapters: ReadonlyArray<VolumeMapChapterNode>;
  readonly orphanNotes: ReadonlyArray<VolumeMapNoteNode>;
  readonly chapterCount: number;
  readonly volumeCount: number;
}

export interface PlannedVolumeRange {
  readonly volumeNumber: number;
  readonly startChapter: number;
  readonly endChapter: number;
  readonly title?: string;
}

export interface AssembledVolumeChapter {
  readonly chapterNumber: number;
  readonly title: string;
  readonly summary: string;
}

export interface AssembledVolume {
  readonly volumeNumber: number;
  readonly title: string;
  readonly startChapter: number;
  readonly endChapter: number;
  readonly body: string;
  readonly chapters: ReadonlyArray<AssembledVolumeChapter>;
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

const VOLUME_MARKER = /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?(第\s*([一二三四五六七八九十百千万零〇两\d]+)\s*卷|Volume\s+(\d+)|卷\s*([一二三四五六七八九十百\d]+))(?:\*\*)?/i;
const RANGE_ON_LINE = /[（(]\s*(?:第|[Cc]hapters?\s+)?(\d+)\s*[-–~～—]\s*(\d+)\s*(?:章)?\s*[）)]|(?:第|[Cc]hapters?\s+)(\d+)\s*[-–~～—]\s*(\d+)\s*(?:章)?/i;
const EXACT_CHAPTER = /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?(?:Chapter\s*(\d+)|第\s*(\d+)\s*章)(?!\s*[-~–—]\s*\d)(?:[:：-])?(?:\*\*)?\s*(.*)$/i;
const RANGE_CHAPTER = /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?(?:Chapter\s*(\d+)\s*[-~–—]\s*(\d+)|第\s*(\d+)\s*[-~–—]\s*(\d+)\s*章)(?:[:：-])?(?:\*\*)?\s*(.*)$/i;
const OKR_LINE = /(?:Objective|Key\s*Results?|KR\s*\d+|卷级目标|关键成果|关键结果|本卷要抵达|卷末必须落下)/i;
const PROSE_HEADING_JUNK = /(?:埋线?|各卷OKR|OKR|KR\s*\d+|节奏原则|情绪曲线|回收承诺)/i;
const VOLUME_NOTE_JUNK = /节点[A-Za-z0-9一二三四五六七八九十]|分章|事件清单/;

export function parseChineseInt(raw: string): number | null {
  const trimmed = raw.replace(/\s+/g, "");
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (trimmed === "十") return 10;
  if (trimmed.startsWith("十")) {
    const rest = parseChineseInt(trimmed.slice(1));
    return rest == null ? null : 10 + rest;
  }
  const tenAt = trimmed.indexOf("十");
  if (tenAt >= 0) {
    const left = trimmed.slice(0, tenAt);
    const right = trimmed.slice(tenAt + 1);
    const hi = left ? CN_DIGIT[left] : 1;
    const lo = right ? (CN_DIGIT[right] ?? parseChineseInt(right)) : 0;
    if (hi == null || lo == null) return null;
    return hi * 10 + lo;
  }
  return CN_DIGIT[trimmed] ?? null;
}

export function truncateOutlineLabel(text: string, max = MAX_VOLUME_TREE_LABEL_CHARS): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  if (max <= 1) return "…";
  return `${cleaned.slice(0, max - 1)}…`;
}

function stripDecor(line: string): string {
  return line.replace(/^#+\s*/, "").replace(/^[-*]\s+/, "").replace(/\*\*/g, "").trim();
}

function looksLikeHeadingLine(line: string): boolean {
  return /^\s{0,3}#{1,6}\s+\S/.test(line) || /^\s{0,3}[-*]\s+\S/.test(line);
}

function restAfterVolumeMarker(stripped: string): string {
  return stripped
    .replace(/^(第\s*[一二三四五六七八九十百千万零〇两\d]+\s*卷|Volume\s+\d+)/i, "")
    .trim();
}

function volumeNameFromRest(rest: string): string {
  return rest.replace(/[（(].*$/, "").replace(/[：:].*$/, "").replace(/^[·.\s]+/, "").trim();
}

/**
 * Canonical volume heading: `第N卷 卷名（第a–b章）` / `Volume N Title (a-b)`.
 * `第N卷·节点A` / `第一卷分章事件清单` / colon-dumps become 备注, not volumes.
 */
function isLikelyVolumeHeadingLine(line: string): boolean {
  const stripped = stripDecor(line);
  if (!stripped) return false;
  if (!/^(第\s*[一二三四五六七八九十百千万零〇两\d]+\s*卷|Volume\s+\d+)/i.test(stripped)) {
    return false;
  }
  if (PROSE_HEADING_JUNK.test(stripped) && !RANGE_ON_LINE.test(stripped)) return false;
  if (VOLUME_NOTE_JUNK.test(stripped)) return false;
  const rest = restAfterVolumeMarker(stripped);
  const name = volumeNameFromRest(rest);
  if (!name) return false;
  if (VOLUME_NOTE_JUNK.test(name)) return false;
  if (/^[：:]/.test(rest)) return false;
  if (RANGE_ON_LINE.test(stripped)) return name.length <= 24;
  if (stripped.length > 40) return false;
  if (/[：:]/.test(stripped)) return false;
  return name.length > 0 && name.length <= 16;
}

function isNoteHeadingLine(line: string): boolean {
  if (!looksLikeHeadingLine(line)) return false;
  const stripped = stripDecor(line);
  if (parseChapterLine(line)) return false;
  if (isLikelyVolumeHeadingLine(line)) return false;
  return /^(第\s*[一二三四五六七八九十百千万零〇两\d]+\s*卷|Volume\s+\d+)/i.test(stripped);
}

function extractShortVolumeTitle(line: string, rangeIndex?: number): string {
  let working = rangeIndex != null ? line.slice(0, rangeIndex).replace(/[（(]\s*$/, "") : line;
  working = stripDecor(working).replace(/[：:]\s*$/, "").trim();
  const junkAt = working.search(/[：:].*(?:埋|OKR|KR|节奏|钩子)|埋[线：:]|各卷OKR/);
  if (junkAt >= 0) working = working.slice(0, junkAt).trim();
  if (working.length > 36) working = working.slice(0, 36).trim();
  return working;
}

export function formatVolumeLabel(volumeNumber: number | null, title: string, isZh: boolean): string {
  const cleaned = extractShortVolumeTitle(title) || title.replace(/^#+\s*/, "").trim();
  const short = truncateOutlineLabel(cleaned);
  if (short) return short;
  if (volumeNumber == null) return isZh ? "本卷" : "This volume";
  return isZh ? `第${volumeNumber}卷` : `Volume ${volumeNumber}`;
}

function parseVolumeHeader(line: string): {
  volumeNumber: number | null;
  title: string;
  startChapter?: number;
  endChapter?: number;
} | null {
  if (!isLikelyVolumeHeadingLine(line)) return null;
  const match = stripDecor(line).match(VOLUME_MARKER) ?? line.match(VOLUME_MARKER);
  if (!match) return null;
  const rawNumber = match[2] ?? match[3] ?? match[4] ?? "";
  const volumeNumber = parseChineseInt(rawNumber);
  const range = line.match(RANGE_ON_LINE);
  const startChapter = range ? Number.parseInt(range[1] ?? range[3] ?? "", 10) : undefined;
  const endChapter = range ? Number.parseInt(range[2] ?? range[4] ?? "", 10) : undefined;
  const title = extractShortVolumeTitle(line, range?.index);
  return {
    volumeNumber,
    title,
    startChapter: Number.isInteger(startChapter) ? startChapter : undefined,
    endChapter: Number.isInteger(endChapter) ? endChapter : undefined,
  };
}

function parseChapterLine(line: string): VolumeMapChapterNode | null {
  const range = line.match(RANGE_CHAPTER);
  if (range) {
    const start = Number.parseInt(range[1] ?? range[3] ?? "", 10);
    const end = Number.parseInt(range[2] ?? range[4] ?? "", 10);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    const title = (range[5] ?? "").trim();
    return {
      kind: "range",
      id: `range:${start}-${end}`,
      chapterNumber: Math.min(start, end),
      endChapter: Math.max(start, end),
      title,
      summary: "",
      lineStart: 0,
      lineEnd: 0,
    };
  }
  const exact = line.match(EXACT_CHAPTER);
  if (!exact) return null;
  const chapterNumber = Number.parseInt(exact[1] ?? exact[2] ?? "", 10);
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) return null;
  return {
    kind: "chapter",
    id: `chapter:${chapterNumber}`,
    chapterNumber,
    title: (exact[3] ?? "").trim(),
    summary: "",
    lineStart: 0,
    lineEnd: 0,
  };
}

function isStructuralLine(line: string): boolean {
  return Boolean(parseVolumeHeader(line) || parseChapterLine(line) || isNoteHeadingLine(line));
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const next = [...lines];
  while (next.length && next[next.length - 1]!.trim() === "") next.pop();
  return next;
}

function collectSummary(lines: ReadonlyArray<string>, start: number): { summary: string; end: number } {
  const collected: string[] = [];
  let end = start - 1;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isStructuralLine(line)) break;
    collected.push(line);
    end = index;
  }
  while (collected.length && collected[collected.length - 1]!.trim() === "") {
    collected.pop();
    end -= 1;
  }
  while (collected.length && collected[0]!.trim() === "") collected.shift();
  return { summary: collected.join("\n"), end: end < start ? start - 1 : end };
}

function extractOkr(bodyLines: ReadonlyArray<string>): string {
  const okrLines = bodyLines.filter((line) => OKR_LINE.test(line));
  if (okrLines.length > 0) return okrLines.join("\n").trim();
  const prose = bodyLines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !isStructuralLine(line));
  return prose.slice(0, 3).join("\n").trim();
}

export function parseVolumeMapTree(markdown: string): VolumeMapTree {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const volumes: VolumeMapVolumeNode[] = [];
  const orphanChapters: VolumeMapChapterNode[] = [];
  const orphanNotes: VolumeMapNoteNode[] = [];

  type OpenVolume = {
    volumeNumber: number | null;
    title: string;
    startChapter?: number;
    endChapter?: number;
    lineStart: number;
    chapters: VolumeMapChapterNode[];
    notes: VolumeMapNoteNode[];
  };

  let current: OpenVolume | null = null;

  const flushVolume = (endLine: number) => {
    if (!current) return;
    const id = current.volumeNumber != null ? `volume:${current.volumeNumber}` : `volume:${current.lineStart}`;
    const firstChapterStart = current.chapters[0]?.lineStart;
    const firstNoteStart = current.notes[0]?.lineStart;
    const bodyUntil = firstChapterStart ?? firstNoteStart ?? endLine + 1;
    const bodyLines = trimTrailingBlankLines(lines.slice(current.lineStart + 1, bodyUntil));
    volumes.push({
      kind: "volume",
      id,
      volumeNumber: current.volumeNumber,
      title: current.title,
      okr: extractOkr(bodyLines),
      body: bodyLines.join("\n"),
      startChapter: current.startChapter,
      endChapter: current.endChapter,
      chapters: current.chapters,
      notes: current.notes,
      lineStart: current.lineStart,
      lineEnd: Math.max(current.lineStart, endLine),
    });
    current = null;
  };

  const pushChapter = (node: VolumeMapChapterNode, lineIndex: number) => {
    const follow = collectSummary(lines, lineIndex + 1);
    const complete: VolumeMapChapterNode = {
      ...node,
      summary: node.title && !follow.summary ? "" : follow.summary,
      title: node.title,
      lineStart: lineIndex,
      lineEnd: follow.end >= lineIndex ? follow.end : lineIndex,
    };
    if (current) current.chapters.push(complete);
    else orphanChapters.push(complete);
    return complete.lineEnd;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const volume = parseVolumeHeader(line);
    if (volume) {
      flushVolume(index - 1);
      current = {
        ...volume,
        lineStart: index,
        chapters: [],
        notes: [],
      };
      continue;
    }
    if (isNoteHeadingLine(line)) {
      const follow = collectSummary(lines, index + 1);
      const note: VolumeMapNoteNode = {
        kind: "note",
        id: `note:${index}`,
        title: stripDecor(line),
        body: follow.summary,
        lineStart: index,
        lineEnd: follow.end >= index ? follow.end : index,
      };
      if (current) current.notes.push(note);
      else orphanNotes.push(note);
      index = note.lineEnd;
      continue;
    }
    const chapter = parseChapterLine(line);
    if (chapter) {
      index = pushChapter(chapter, index);
    }
  }
  flushVolume(lines.length - 1);

  const chapterCount = [...volumes.flatMap((volume) => volume.chapters), ...orphanChapters].reduce((sum, node) => {
    if (node.kind === "range" && node.endChapter) return sum + (node.endChapter - node.chapterNumber + 1);
    return sum + 1;
  }, 0);

  return {
    volumes,
    orphanChapters,
    orphanNotes,
    chapterCount,
    volumeCount: volumes.length,
  };
}

export function findExactChapterNode(
  tree: VolumeMapTree,
  chapterNumber: number,
): VolumeMapChapterNode | undefined {
  const nodes = [...tree.volumes.flatMap((volume) => volume.chapters), ...tree.orphanChapters];
  return nodes.find((node) => node.kind === "chapter" && node.chapterNumber === chapterNumber);
}

export function findChapterNode(
  tree: VolumeMapTree,
  chapterNumber: number,
): VolumeMapChapterNode | undefined {
  const exact = findExactChapterNode(tree, chapterNumber);
  if (exact) return exact;
  const nodes = [...tree.volumes.flatMap((volume) => volume.chapters), ...tree.orphanChapters];
  return nodes.find((node) => {
    if (node.kind === "range" && node.endChapter) {
      return chapterNumber >= node.chapterNumber && chapterNumber <= node.endChapter;
    }
    return node.chapterNumber === chapterNumber;
  });
}

export function findMatchingVolumeForChapter(
  tree: VolumeMapTree,
  chapterNumber: number,
): VolumeMapVolumeNode | undefined {
  const exact = tree.volumes.find((volume) => volume.chapters.some((node) => (
    node.kind === "chapter" && node.chapterNumber === chapterNumber
  )));
  if (exact) return exact;
  const declared = tree.volumes.find((volume) => (
    volume.startChapter != null
    && volume.endChapter != null
    && chapterNumber >= volume.startChapter
    && chapterNumber <= volume.endChapter
  ));
  if (declared) return declared;
  return tree.volumes.find((volume) => volume.chapters.some((node) => (
    node.kind === "range"
    && node.endChapter != null
    && chapterNumber >= node.chapterNumber
    && chapterNumber <= node.endChapter
  )));
}

export function findVolumeForChapter(
  tree: VolumeMapTree,
  chapterNumber: number,
): VolumeMapVolumeNode | undefined {
  return findMatchingVolumeForChapter(tree, chapterNumber) ?? tree.volumes[0];
}

export function findVolumeOwningNode(
  tree: VolumeMapTree,
  nodeId: string,
): VolumeMapVolumeNode | undefined {
  return tree.volumes.find((volume) =>
    volume.id === nodeId
    || volume.chapters.some((chapter) => chapter.id === nodeId)
    || volume.notes.some((note) => note.id === nodeId)
  );
}

export function recommendedOutlineNodeId(tree: VolumeMapTree, nextChapter: number): string | null {
  const chapter = findChapterNode(tree, nextChapter);
  if (chapter) return chapter.id;
  const volume = findVolumeForChapter(tree, nextChapter);
  if (volume) return volume.id;
  return tree.volumes[0]?.id ?? tree.orphanChapters[0]?.id ?? null;
}

export function findNodeById(
  tree: VolumeMapTree,
  nodeId: string,
): VolumeMapVolumeNode | VolumeMapChapterNode | VolumeMapNoteNode | undefined {
  return tree.volumes.find((volume) => volume.id === nodeId)
    ?? tree.volumes.flatMap((volume) => volume.chapters).find((node) => node.id === nodeId)
    ?? tree.volumes.flatMap((volume) => volume.notes).find((node) => node.id === nodeId)
    ?? tree.orphanChapters.find((node) => node.id === nodeId)
    ?? tree.orphanNotes.find((node) => node.id === nodeId);
}

function replaceLineRange(
  markdown: string,
  start: number,
  end: number,
  replacement: ReadonlyArray<string>,
): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const next = [...lines.slice(0, start), ...replacement, ...lines.slice(end + 1)];
  return next.join("\n");
}

function chapterHeading(node: VolumeMapChapterNode, title: string): string {
  if (node.kind === "range" && node.endChapter) {
    return `## 第 ${node.chapterNumber}-${node.endChapter} 章 ${title}`.trim();
  }
  return `## 第 ${node.chapterNumber} 章 ${title}`.trim();
}

function replaceVolumeHeadingTitle(
  oldHeading: string,
  newTitle: string,
  node: VolumeMapVolumeNode,
): string {
  const hash = oldHeading.match(/^#+/)?.[0] ?? "##";
  const rangeOnLine = oldHeading.match(/[（(]\s*(?:第|[Cc]hapters?\s+)?\d+\s*[-–~～—]\s*\d+\s*(?:章)?\s*[）)]/);
  if (rangeOnLine) return `${hash} ${newTitle}${rangeOnLine[0]}`;
  const range = node.startChapter && node.endChapter
    ? `（${node.startChapter}-${node.endChapter}章）`
    : "";
  return `${hash} ${newTitle}${range}`;
}

function replaceChapterHeadingTitle(
  oldHeading: string,
  node: VolumeMapChapterNode,
  newTitle: string,
): string {
  const rangePrefix = oldHeading.match(/^(#{1,3})\s*(第\s*\d+\s*[-–~～—]\s*\d+\s*章)\s*/);
  if (rangePrefix) return `${rangePrefix[1]} ${rangePrefix[2]} ${newTitle}`.trim();
  const zhPrefix = oldHeading.match(/^(#{1,3})\s*(第\s*\d+\s*章)\s*/);
  if (zhPrefix) return `${zhPrefix[1]} ${zhPrefix[2]} ${newTitle}`.trim();
  const enPrefix = oldHeading.match(/^(#{1,3})\s*(Chapter\s*\d+(?:\s*[-–~～—]\s*\d+)?)\s*/i);
  if (enPrefix) return `${enPrefix[1]} ${enPrefix[2]} ${newTitle}`.trim();
  return chapterHeading(node, newTitle);
}

export function outlineEditorSource(
  node: VolumeMapVolumeNode | VolumeMapChapterNode | VolumeMapNoteNode,
  options?: { readonly language?: "zh" | "en" },
): { title: string; summary: string; split: boolean } {
  if (node.kind === "volume") {
    return { title: node.title, summary: node.body, split: false };
  }
  if (node.kind === "note") {
    return { title: node.title, summary: node.body, split: false };
  }
  const split = splitOutlineTitleAndSummary(node.title, node.summary, options);
  return { title: split.title, summary: split.summary, split: split.split };
}

/**
 * Only persist fields the user actually changed. Select+blur with an
 * unchanged title/summary must not rewrite volume_map (G2).
 */
export function buildOutlineEditPatch(
  node: VolumeMapVolumeNode | VolumeMapChapterNode | VolumeMapNoteNode,
  title: string,
  summary: string,
  options?: { readonly language?: "zh" | "en" },
): { readonly title?: string; readonly summary?: string } | null {
  const source = outlineEditorSource(node, options);
  const patch: { title?: string; summary?: string } = {};
  if (title.trim() !== source.title.trim()) patch.title = title.trim();
  if (summary !== source.summary) patch.summary = summary;
  return patch.title !== undefined || patch.summary !== undefined ? patch : null;
}

/** Outline workspace save: no-op when the draft matches the selected node. */
export function applyOutlineWorkspaceSave(
  markdown: string,
  nodeId: string,
  title: string,
  summary: string,
  options?: { readonly language?: "zh" | "en" },
): string {
  const tree = parseVolumeMapTree(markdown);
  const node = findNodeById(tree, nodeId);
  if (!node) return markdown;
  const patch = buildOutlineEditPatch(node, title, summary, options);
  if (!patch) return markdown;
  return applyVolumeMapNodeEdit(markdown, nodeId, patch);
}

/**
 * In-place volume_map edits stay lossless for unedited lines: title-only
 * touches the heading; a volume summary replaces only the pre-chapter body
 * and leaves chapter blocks verbatim (including multi-paragraph summaries).
 */
export function applyVolumeMapNodeEdit(
  markdown: string,
  nodeId: string,
  patch: { readonly title?: string; readonly summary?: string },
): string {
  const tree = parseVolumeMapTree(markdown);
  const node = findNodeById(tree, nodeId);
  if (!node) return markdown;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  if (node.kind === "note") {
    const oldHeading = lines[node.lineStart] ?? "";
    const hash = oldHeading.match(/^#+/)?.[0] ?? "##";
    const nextHeading = patch.title !== undefined ? `${hash} ${patch.title}` : oldHeading;
    if (patch.summary === undefined) {
      return replaceLineRange(markdown, node.lineStart, node.lineStart, [nextHeading]);
    }
    return [
      ...lines.slice(0, node.lineStart),
      nextHeading,
      ...patch.summary.split("\n"),
      ...lines.slice(node.lineEnd + 1),
    ].join("\n");
  }

  if (node.kind === "volume") {
    const oldHeading = lines[node.lineStart] ?? "";
    const nextHeader = patch.title !== undefined
      ? replaceVolumeHeadingTitle(oldHeading, patch.title, node)
      : oldHeading;
    if (patch.summary === undefined) {
      return replaceLineRange(markdown, node.lineStart, node.lineStart, [nextHeader]);
    }
    const firstChapterStart = node.chapters[0]?.lineStart;
    const firstNoteStart = node.notes[0]?.lineStart;
    const bodyUntil = firstChapterStart ?? firstNoteStart ?? node.lineEnd + 1;
    return [...lines.slice(0, node.lineStart), nextHeader, ...patch.summary.split("\n"), ...lines.slice(bodyUntil)].join("\n");
  }

  const oldHeading = lines[node.lineStart] ?? "";
  const nextHeading = patch.title !== undefined
    ? replaceChapterHeadingTitle(oldHeading, node, patch.title)
    : oldHeading;
  if (patch.summary === undefined) {
    return replaceLineRange(markdown, node.lineStart, node.lineStart, [nextHeading]);
  }
  return [
    ...lines.slice(0, node.lineStart),
    nextHeading,
    ...patch.summary.split("\n"),
    ...lines.slice(node.lineEnd + 1),
  ].join("\n");
}

export function insertChapterStub(
  markdown: string,
  chapterNumber: number,
  volumeId?: string,
): string {
  const stub = `\n\n## 第 ${chapterNumber} 章\n`;
  if (!volumeId) return `${markdown.replace(/\s+$/, "")}${stub}`;
  const tree = parseVolumeMapTree(markdown);
  const volume = tree.volumes.find((item) => item.id === volumeId);
  if (!volume) return `${markdown.replace(/\s+$/, "")}${stub}`;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const insertAt = volume.lineEnd + 1;
  return [...lines.slice(0, insertAt), "", `## 第 ${chapterNumber} 章`, "", ...lines.slice(insertAt)].join("\n");
}

export function volumeContainsChapter(volume: VolumeMapVolumeNode, chapterNumber: number): boolean {
  if (volume.startChapter != null && volume.endChapter != null) {
    return chapterNumber >= volume.startChapter && chapterNumber <= volume.endChapter;
  }
  return volume.chapters.some((node) => {
    if (node.kind === "range" && node.endChapter) {
      return chapterNumber >= node.chapterNumber && chapterNumber <= node.endChapter;
    }
    return node.chapterNumber === chapterNumber;
  });
}

export function plannedChapterCount(volume: VolumeMapVolumeNode): number | null {
  if (volume.startChapter != null && volume.endChapter != null) {
    return volume.endChapter - volume.startChapter + 1;
  }
  if (volume.chapters.length === 0) return null;
  return volume.chapters.reduce((sum, node) => {
    if (node.kind === "range" && node.endChapter) return sum + (node.endChapter - node.chapterNumber + 1);
    return sum + 1;
  }, 0);
}

export function lastPlannedChapter(volume: VolumeMapVolumeNode): number | undefined {
  if (volume.endChapter != null) return volume.endChapter;
  const numbers = volume.chapters.map((node) => node.endChapter ?? node.chapterNumber);
  if (numbers.length === 0) return undefined;
  return Math.max(...numbers);
}

export function resolveTargetChapterCount(input: {
  readonly targetChapters?: number;
  readonly chapterWordCount?: number;
  readonly totalWords?: number;
}): number {
  const explicit = Number.isInteger(input.targetChapters) && (input.targetChapters ?? 0) > 0
    ? input.targetChapters!
    : 0;
  if (explicit > 0) return explicit;
  const words = input.totalWords ?? 0;
  const perChapter = input.chapterWordCount && input.chapterWordCount > 0 ? input.chapterWordCount : 3000;
  if (words > 0) return Math.max(1, Math.ceil(words / perChapter));
  return 1;
}

export interface ProseVolumeHint {
  readonly title: string;
  readonly chapterCount: number;
}

const HINT_TITLE_PREFIX_JUNK = /^(?:卷|第|章|埋|OKR|KR|共|各卷)/;
const HINT_TITLE_INLINE_JUNK = /埋|OKR|Objective|KR\d|末/;
const NAMED_VOLUME_TITLE =
  /(?:第\s*[一二三四五六七八九十百\d]+\s*卷|卷\s*[一二三四五六七八九十百\d]+)\s*《\s*([^》]{1,8})\s*》/g;
const PAREN_TITLE_COUNT = /([\u4e00-\u9fffA-Za-z]{1,8})\s*[（(](\d{1,3})[）)]/g;
const NAMED_TITLE_ADJACENT_COUNT =
  /(?:第\s*[一二三四五六七八九十百\d]+\s*卷|卷\s*[一二三四五六七八九十百\d]+)\s*《\s*([^》]{1,8})\s*》\s*([一二三四五六七八九十百两]+|\d{1,3})\s*章?/g;
const COUNT_RUN =
  /((?:[一二三四五六七八九十百两]+|\d{1,3})\s*章?(?:\s*[、，,]\s*(?:[一二三四五六七八九十百两]+|\d{1,3})\s*章?){2,})/g;

function isUsableHintTitle(title: string): boolean {
  return Boolean(title)
    && !HINT_TITLE_PREFIX_JUNK.test(title)
    && !HINT_TITLE_INLINE_JUNK.test(title);
}

function isVolumeSizedCount(count: number): boolean {
  return Number.isInteger(count) && count >= 8 && count <= 200;
}

function parseHintCountToken(raw: string): number | null {
  const trimmed = raw.replace(/章/g, "").trim();
  if (!trimmed) return null;
  const count = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : parseChineseInt(trimmed);
  return count != null && isVolumeSizedCount(count) ? count : null;
}

function collectNonHeadingLines(markdown: string): string[] {
  return markdown.replace(/\r\n/g, "\n").split("\n").filter((line) => !line.trimStart().startsWith("#"));
}

function parseParenTitleCounts(text: string): ProseVolumeHint[] {
  const hints: ProseVolumeHint[] = [];
  PAREN_TITLE_COUNT.lastIndex = 0;
  let match: RegExpExecArray | null = PAREN_TITLE_COUNT.exec(text);
  while (match) {
    const title = match[1] ?? "";
    const chapterCount = Number.parseInt(match[2] ?? "", 10);
    if (isUsableHintTitle(title) && isVolumeSizedCount(chapterCount)) {
      hints.push({ title, chapterCount });
    }
    match = PAREN_TITLE_COUNT.exec(text);
  }
  return hints;
}

function parseNamedVolumeTitles(text: string): string[] {
  const titles: string[] = [];
  NAMED_VOLUME_TITLE.lastIndex = 0;
  let match: RegExpExecArray | null = NAMED_VOLUME_TITLE.exec(text);
  while (match) {
    const title = (match[1] ?? "").trim();
    if (isUsableHintTitle(title)) titles.push(title);
    match = NAMED_VOLUME_TITLE.exec(text);
  }
  return titles;
}

function parseNamedTitleAdjacentCounts(text: string): ProseVolumeHint[] {
  const hints: ProseVolumeHint[] = [];
  NAMED_TITLE_ADJACENT_COUNT.lastIndex = 0;
  let match: RegExpExecArray | null = NAMED_TITLE_ADJACENT_COUNT.exec(text);
  while (match) {
    const title = (match[1] ?? "").trim();
    const chapterCount = parseHintCountToken(match[2] ?? "");
    if (isUsableHintTitle(title) && chapterCount != null) {
      hints.push({ title, chapterCount });
    }
    match = NAMED_TITLE_ADJACENT_COUNT.exec(text);
  }
  return hints;
}

function parseVolumeCountList(text: string): number[] {
  let best: number[] = [];
  COUNT_RUN.lastIndex = 0;
  let match: RegExpExecArray | null = COUNT_RUN.exec(text);
  while (match) {
    const counts = (match[1] ?? "")
      .split(/[、，,]/)
      .map((part) => parseHintCountToken(part))
      .filter((count): count is number => count != null);
    if (counts.length > best.length) best = counts;
    match = COUNT_RUN.exec(text);
  }
  return best;
}

function zipHintTitlesAndCounts(
  titles: ReadonlyArray<string>,
  counts: ReadonlyArray<number>,
): ProseVolumeHint[] {
  const length = Math.min(titles.length, counts.length);
  const hints: ProseVolumeHint[] = [];
  for (let index = 0; index < length; index += 1) {
    hints.push({ title: titles[index]!, chapterCount: counts[index]! });
  }
  return hints;
}

/**
 * Recover named volumes from leftover architect prose. 《醉词》 canon is
 * `卷一《冕旒》` plus Chinese/Arabic counts (`四十、四十、四十五…`), not only
 * `冕旒(40)`. Also accepts the parenthetical form and leftover notes stuffed
 * under 原架构笔记 after a placeholder lock.
 */
export function parseProseVolumeHints(markdown: string): ReadonlyArray<ProseVolumeHint> {
  const text = collectNonHeadingLines(markdown).join("\n");
  const namedTitles = parseNamedVolumeTitles(text);
  const countList = parseVolumeCountList(text);
  const namedWithCounts = zipHintTitlesAndCounts(namedTitles, countList);
  if (namedWithCounts.length >= 2) return namedWithCounts;

  const adjacent = parseNamedTitleAdjacentCounts(text);
  if (adjacent.length >= 2) return adjacent;

  const paren = parseParenTitleCounts(text);
  if (paren.length >= 2) return paren;

  return namedWithCounts.length > 0 ? namedWithCounts : adjacent.length > 0 ? adjacent : paren;
}

/** Locked heading that is not a real volume name (第N程 / Arc N / 埋/OKR / empty). */
export function isPlaceholderVolumeTitle(title: string | undefined): boolean {
  const cleaned = (title ?? "").replace(/^#+\s*/, "").trim();
  if (!cleaned) return true;
  const stripped = cleaned
    .replace(/^第\s*[一二三四五六七八九十百\d]+\s*卷\s*/, "")
    .replace(/^Volume\s+\d+\s*/i, "")
    .trim();
  if (!stripped) return true;
  if (/^第\s*[一二三四五六七八九十百\d]+\s*程$/.test(stripped)) return true;
  if (/^Arc\s+\d+$/i.test(stripped)) return true;
  if (/埋线?|各卷OKR|KR\s*\d+/.test(cleaned)) return true;
  if (cleaned.length > 16) return true;
  return false;
}

export function planVolumeRangesFromHints(
  hints: ReadonlyArray<ProseVolumeHint>,
  targetChapters: number,
): ReadonlyArray<PlannedVolumeRange> | null {
  if (hints.length < 2) return null;
  const total = Math.max(1, Math.floor(targetChapters));
  const ranges: PlannedVolumeRange[] = [];
  let cursor = 1;
  for (const hint of hints) {
    if (cursor > total) break;
    const endChapter = Math.min(total, cursor + hint.chapterCount - 1);
    ranges.push({
      volumeNumber: ranges.length + 1,
      startChapter: cursor,
      endChapter,
      title: hint.title,
    });
    cursor = endChapter + 1;
  }
  if (ranges.length < 2) return null;
  if (cursor <= total) {
    const last = ranges[ranges.length - 1]!;
    ranges[ranges.length - 1] = { ...last, endChapter: total };
  }
  return ranges;
}

export function planVolumeRanges(
  targetChapters: number,
  options?: { readonly existingVolumeCount?: number },
): ReadonlyArray<PlannedVolumeRange> {
  const total = Math.max(1, Math.floor(targetChapters));
  let volumeCount = options?.existingVolumeCount && options.existingVolumeCount > 0
    ? options.existingVolumeCount
    : 0;
  if (volumeCount <= 0) {
    if (total <= 20) volumeCount = 1;
    else if (total <= 45) volumeCount = 2;
    else if (total <= 80) volumeCount = 3;
    else if (total <= 120) volumeCount = 4;
    else if (total <= 180) volumeCount = 5;
    else volumeCount = Math.min(8, Math.max(5, Math.round(total / 36)));
  }
  volumeCount = Math.min(volumeCount, total);
  const base = Math.floor(total / volumeCount);
  let remainder = total % volumeCount;
  const ranges: PlannedVolumeRange[] = [];
  let cursor = 1;
  for (let index = 0; index < volumeCount; index += 1) {
    const size = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    const startChapter = cursor;
    const endChapter = Math.min(total, cursor + size - 1);
    ranges.push({ volumeNumber: index + 1, startChapter, endChapter });
    cursor = endChapter + 1;
  }
  return ranges;
}

export function listedExactChapterNumbers(tree: VolumeMapTree): ReadonlyArray<number> {
  const numbers = new Set<number>();
  for (const node of [...tree.volumes.flatMap((volume) => volume.chapters), ...tree.orphanChapters]) {
    if (node.kind === "chapter") numbers.add(node.chapterNumber);
  }
  return [...numbers].sort((left, right) => left - right);
}

export function missingExactChapters(tree: VolumeMapTree, targetChapters: number): ReadonlyArray<number> {
  const present = new Set(listedExactChapterNumbers(tree));
  const missing: number[] = [];
  for (let chapter = 1; chapter <= targetChapters; chapter += 1) {
    if (!present.has(chapter)) missing.push(chapter);
  }
  return missing;
}

export function volumeMapHasReviewableTree(tree: VolumeMapTree, targetChapters: number): boolean {
  return tree.volumeCount > 0
    && listedExactChapterNumbers(tree).length >= targetChapters
    && missingExactChapters(tree, targetChapters).length === 0;
}

export function volumeMapHasLockedVolumes(tree: VolumeMapTree): boolean {
  return tree.volumes.some((volume) =>
    volume.volumeNumber != null
    && volume.startChapter != null
    && volume.endChapter != null
    && volume.endChapter >= volume.startChapter,
  );
}

/** True only when a volume split has real names — 第N程 / Arc N do not count. */
export function volumeMapHasLockedNamedVolumes(tree: VolumeMapTree): boolean {
  return tree.volumes.some((volume) =>
    volume.volumeNumber != null
    && volume.startChapter != null
    && volume.endChapter != null
    && volume.endChapter >= volume.startChapter
    && !isPlaceholderVolumeTitle(volume.title),
  );
}

export function filledChapterNumbers(tree: VolumeMapTree): ReadonlyArray<number> {
  const numbers: number[] = [];
  for (const [number, node] of chapterNodesByNumber(tree)) {
    if (node.title.trim() || node.summary.trim()) numbers.push(number);
  }
  return numbers.sort((left, right) => left - right);
}

export function nextUnfilledChapterBatch(
  tree: VolumeMapTree,
  targetChapters: number,
  batchSize = 10,
): ReadonlyArray<number> {
  const filled = new Set(filledChapterNumbers(tree));
  let first: number | undefined;
  for (let chapter = 1; chapter <= targetChapters; chapter += 1) {
    if (!filled.has(chapter)) {
      first = chapter;
      break;
    }
  }
  if (first == null) return [];
  const home = tree.volumes.find((volume) =>
    volume.startChapter != null
    && volume.endChapter != null
    && first! >= volume.startChapter
    && first! <= volume.endChapter,
  );
  const limit = Math.min(targetChapters, home?.endChapter ?? targetChapters);
  const batch: number[] = [];
  const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 10;
  for (let chapter = first; chapter <= limit && batch.length < size; chapter += 1) {
    if (!filled.has(chapter)) batch.push(chapter);
  }
  return batch;
}

export type OutlineWeaveStep = "volumes" | "batch" | "done";

export function resolveOutlineWeaveStep(
  tree: VolumeMapTree,
  targetChapters: number,
  volumeMap?: string,
): OutlineWeaveStep {
  if (!volumeMapHasLockedNamedVolumes(tree)) {
    void volumeMap;
    return "volumes";
  }
  return nextUnfilledChapterBatch(tree, targetChapters).length > 0 ? "batch" : "done";
}

function firstVolumeOrChapterLine(tree: VolumeMapTree, lineCount: number): number {
  const starts = [
    ...tree.volumes.map((volume) => volume.lineStart),
    ...tree.orphanChapters.map((chapter) => chapter.lineStart),
  ];
  return starts.length > 0 ? Math.min(...starts) : lineCount;
}

export function volumeMapPreamble(markdown: string): string {
  const tree = parseVolumeMapTree(markdown);
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const starts = [
    ...tree.volumes.map((volume) => volume.lineStart),
    ...tree.orphanChapters.map((chapter) => chapter.lineStart),
    ...tree.orphanNotes.map((note) => note.lineStart),
  ];
  const first = starts.length > 0 ? Math.min(...starts) : lines.length;
  return lines.slice(0, first).join("\n").trim();
}

export function volumeMapLeadingNotesMarkdown(markdown: string): string {
  const tree = parseVolumeMapTree(markdown);
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const firstStructure = firstVolumeOrChapterLine(tree, lines.length);
  return tree.orphanNotes
    .filter((note) => note.lineStart < firstStructure)
    .map((note) => {
      const heading = (lines[note.lineStart] ?? "").trim() || `## ${note.title}`;
      return [heading, note.body].filter((part) => part.trim()).join("\n");
    })
    .join("\n\n")
    .trim();
}

export function leftoverVolumeMapProse(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (isStructuralLine(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

export function renderVolumeMapMarkdown(
  volumes: ReadonlyArray<AssembledVolume>,
  options?: { readonly preamble?: string; readonly leadingNotes?: string; readonly language?: "zh" | "en" },
): string {
  const language = options?.language === "en" ? "en" : "zh";
  const blocks: string[] = [];
  const preamble = options?.preamble?.trim();
  const leadingNotes = options?.leadingNotes?.trim();
  if (preamble) blocks.push(preamble);
  if (leadingNotes) blocks.push(leadingNotes);
  for (const volume of volumes) {
    const heading = language === "en"
      ? `## Volume ${volume.volumeNumber} ${volume.title} (${volume.startChapter}-${volume.endChapter})`
      : `## 第${volume.volumeNumber}卷 ${volume.title}（${volume.startChapter}-${volume.endChapter}章）`;
    const chapterBlocks = volume.chapters.map((chapter) => {
      const chapterHeading = language === "en"
        ? `## Chapter ${chapter.chapterNumber} ${chapter.title}`.trim()
        : `## 第 ${chapter.chapterNumber} 章 ${chapter.title}`.trim();
      return chapter.summary.trim()
        ? `${chapterHeading}\n${chapter.summary.trim()}`
        : chapterHeading;
    });
    blocks.push([heading, volume.body.trim(), "", ...chapterBlocks].filter((part, index, all) => {
      if (part !== "") return true;
      return index > 0 && all[index - 1] !== "";
    }).join("\n").trim());
  }
  return `${blocks.join("\n\n")}\n`;
}

export function chapterNodesByNumber(tree: VolumeMapTree): Map<number, VolumeMapChapterNode> {
  const map = new Map<number, VolumeMapChapterNode>();
  for (const node of [...tree.volumes.flatMap((volume) => volume.chapters), ...tree.orphanChapters]) {
    if (node.kind === "chapter") map.set(node.chapterNumber, node);
  }
  return map;
}

export function lockedNamedVolumeCount(tree: VolumeMapTree): number {
  return tree.volumes.filter((volume) =>
    volume.volumeNumber != null
    && volume.startChapter != null
    && volume.endChapter != null
    && volume.endChapter >= volume.startChapter
    && !isPlaceholderVolumeTitle(volume.title),
  ).length;
}

const TITLE_HARD_SEP = /[，,。．.；;：:→—–\-]/g;
const TITLE_OPENER_CLOSER: Readonly<Record<string, string>> = {
  "（": "）",
  "(": ")",
  "【": "】",
  "[": "]",
};

function titleCharCount(text: string): number {
  return [...text].length;
}

function trimChapterTitleTail(title: string): string {
  return title.replace(/[：:，,]+$/u, "").replace(/[（(]$/u, "").trim();
}

function findTitleSplitMark(title: string): number {
  TITLE_HARD_SEP.lastIndex = 0;
  let match = TITLE_HARD_SEP.exec(title);
  while (match) {
    if (match.index >= 2) return match.index;
    match = TITLE_HARD_SEP.exec(title);
  }
  for (let index = 0; index < title.length; index += 1) {
    const closer = TITLE_OPENER_CLOSER[title[index]!];
    if (!closer || index < 2) continue;
    if (title.indexOf(closer, index + 1) < 0) return index;
  }
  return -1;
}

export function splitOutlineTitleAndSummary(
  title: string,
  summary: string,
  options?: { readonly language?: "zh" | "en" },
): {
  readonly title: string;
  readonly summary: string;
  readonly split: boolean;
} {
  const trimmedTitle = title.trim();
  const trimmedSummary = summary.trim();
  const limit = chapterTitleLimit(options?.language);
  if (titleCharCount(trimmedTitle) <= limit || trimmedSummary) {
    return { title: trimmedTitle, summary, split: false };
  }
  const mark = findTitleSplitMark(trimmedTitle);
  if (mark < 0) {
    return {
      title: truncateOutlineLabel(trimmedTitle, limit),
      summary: trimmedTitle,
      split: true,
    };
  }
  const rawHead = trimmedTitle.slice(0, mark);
  const head = trimChapterTitleTail(rawHead) || rawHead;
  return {
    title: truncateOutlineLabel(head, limit),
    summary: trimmedTitle.slice(mark + 1).trim(),
    split: true,
  };
}

export function normalizeVolumeMapChapterHeadings(
  markdown: string,
  options?: { readonly language?: "zh" | "en" },
): string {
  const tree = parseVolumeMapTree(markdown);
  const chapters = [
    ...tree.volumes.flatMap((volume) => volume.chapters),
    ...tree.orphanChapters,
  ].sort((left, right) => right.lineStart - left.lineStart);
  let next = markdown;
  for (const chapter of chapters) {
    const split = splitOutlineTitleAndSummary(chapter.title, chapter.summary, options);
    if (!split.split) continue;
    next = applyVolumeMapNodeEdit(next, chapter.id, {
      title: split.title,
      summary: split.summary,
    });
  }
  return next;
}

export function tidyVolumeMapMarkdown(markdown: string, language: "zh" | "en" = "zh"): string {
  const tree = parseVolumeMapTree(markdown);
  if (tree.volumeCount === 0 && tree.orphanChapters.length === 0) return markdown;
  const blocks: string[] = [];
  const leftoverNotes = [
    ...tree.orphanNotes.map((note) => [note.title, note.body].filter(Boolean).join("\n")),
    leftoverVolumeMapProse(markdown),
  ].filter((part) => part.trim());
  if (leftoverNotes.length > 0) {
    blocks.push(leftoverNotes.join("\n\n"));
  }
  for (const volume of tree.volumes) {
    const range = volume.startChapter != null && volume.endChapter != null
      ? (language === "en"
        ? `(${volume.startChapter}-${volume.endChapter})`
        : `（${volume.startChapter}-${volume.endChapter}章）`)
      : "";
    const shortTitle = extractShortVolumeTitle(volume.title)
      .replace(/^第\s*[一二三四五六七八九十百\d]+\s*卷\s*/, "")
      .replace(/^Volume\s+\d+\s*/i, "")
      .trim() || volume.title;
    const heading = language === "en"
      ? `## Volume ${volume.volumeNumber ?? ""} ${shortTitle} ${range}`.replace(/\s+/g, " ").trim()
      : `## 第${volume.volumeNumber ?? ""}卷 ${shortTitle}${range}`.replace(/\s+/g, " ").trim();
    const chapterBlocks = volume.chapters.map((chapter) => {
      const split = splitOutlineTitleAndSummary(chapter.title, chapter.summary);
      if (chapter.kind === "range" && chapter.endChapter) {
        const rangeHeading = language === "en"
          ? `## Chapters ${chapter.chapterNumber}-${chapter.endChapter} (coarse) ${split.title}`.trim()
          : `## 第 ${chapter.chapterNumber}–${chapter.endChapter} 章（粗纲） ${split.title}`.trim();
        return split.summary ? `${rangeHeading}\n${split.summary}` : rangeHeading;
      }
      const chapterHeading = language === "en"
        ? `## Chapter ${chapter.chapterNumber} ${split.title}`.trim()
        : `## 第 ${chapter.chapterNumber} 章 ${split.title}`.trim();
      return split.summary ? `${chapterHeading}\n${split.summary}` : chapterHeading;
    });
    const noteBlock = volume.notes.length > 0
      ? [
        language === "en" ? "### Notes" : "### 备注",
        ...volume.notes.map((note) => [note.title, note.body].filter(Boolean).join("\n")),
      ].join("\n")
      : "";
    blocks.push([heading, volume.body.trim(), "", ...chapterBlocks, noteBlock].filter((part, index, all) => {
      if (part !== "") return true;
      return index > 0 && all[index - 1] !== "";
    }).join("\n").trim());
  }
  for (const chapter of tree.orphanChapters) {
    const split = splitOutlineTitleAndSummary(chapter.title, chapter.summary);
    const heading = language === "en"
      ? `## Chapter ${chapter.chapterNumber} ${split.title}`.trim()
      : `## 第 ${chapter.chapterNumber} 章 ${split.title}`.trim();
    blocks.push(split.summary ? `${heading}\n${split.summary}` : heading);
  }
  return `${blocks.join("\n\n")}\n`;
}
