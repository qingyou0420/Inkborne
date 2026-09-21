/**
 * 织卷: book/volume/chapter outlines with checkpoints and range merge.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  applyVolumeMapNodeEdit,
  findExactChapterNode,
  findMatchingVolumeForChapter,
  parseChineseInt,
  parseVolumeMapTree,
  renderVolumeMapMarkdown,
  volumeMapLeadingNotesMarkdown,
  volumeMapPreamble,
  type AssembledVolume,
} from "../../utils/volume-map-tree.js";
import { assembleAuthoringContext, isLightweightAuthoringBook, loadCanonDocument, loadOutlineText, serializeCanonBrief } from "../context.js";
import { commitAtomicFileSet } from "../../utils/atomic-file-set.js";
import { asNumber, asString, extractJsonObject } from "../json.js";
import { completeRole } from "../llm.js";
import { fillMissingAuthoringRoles, loadRoleApiKeys, resolveAuthoringRole } from "../model-config.js";
import { assertReportReusable, parseReviewPayload, reviewPrompt } from "../review.js";
import {
  authoringRootDir,
  loadArtifact,
  loadManifest,
  loadReport,
  loadRun,
  loadRunControl,
  saveRunControl,
  newArtifactId,
  newRunId,
  saveArtifact,
  saveManifest,
  saveReport,
  saveRun,
  type AuthoringStoreRoot,
} from "../store.js";
import { WorkflowManifestSchema, type AuthoringArtifactMeta, type AuthoringLlmFn, type AuthoringReviewReport, type AuthoringRunRecord, type InputRef } from "../types.js";
import type { ProjectConfig } from "../../models/project.js";
import { closeImpactItemsAfterAdopt } from "./impact.js";

export interface WeaveRuntime {
  readonly root: AuthoringStoreRoot;
  readonly project: ProjectConfig;
  readonly llm?: AuthoringLlmFn;
}

export interface WeaveChapterBeat {
  readonly chapterNumber: number;
  readonly title: string;
  readonly summary: string;
}

function resolveSync() {
  /* placeholder for types */
}

async function resolve(project: ProjectConfig, role: "weave.main" | "weave.review", projectRoot?: string) {
  return resolveAuthoringRole({
    roleId: role,
    baseLlm: project.llm,
    roles: fillMissingAuthoringRoles(project),
    apiKeys: projectRoot ? await loadRoleApiKeys(projectRoot) : undefined,
  });
}

void resolveSync;

function isFilledBeat(beat: WeaveChapterBeat | undefined): boolean {
  return Boolean(beat?.summary && beat.summary !== "（待补概要）");
}

function parseWeaveJson(raw: string): Record<string, unknown> {
  return extractJsonObject(raw, {
    repairTextFields: ["title", "summary", "概要", "bookOutline", "全书大纲", "body", "outline"],
  });
}

function parseRequestedBeats(raw: string, requested: readonly number[]): WeaveChapterBeat[] {
  const json = parseWeaveJson(raw);
  const chapters = Array.isArray(json.chapters) ? json.chapters : [];
  return requested.map((num) => {
    const row = chapters.find((item) => {
      const rec = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return asNumber(rec.chapterNumber) === num || asNumber(rec.n) === num;
    }) as Record<string, unknown> | undefined;
    return {
      chapterNumber: num,
      title: asString(row?.title) || `第${num}章`,
      summary: asString(row?.summary) || asString(row?.概要) || "（待补概要）",
    };
  });
}

function parseReturnedBeats(raw: string): WeaveChapterBeat[] {
  const json = parseWeaveJson(raw);
  const chapters = Array.isArray(json.chapters) ? json.chapters : [];
  const beats: WeaveChapterBeat[] = [];
  for (const item of chapters) {
    const rec = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const chapterNumber = asNumber(rec.chapterNumber) ?? asNumber(rec.n);
    if (!chapterNumber) continue;
    const summary = asString(rec.summary) || asString(rec.概要);
    if (!summary || summary === "（待补概要）") continue;
    beats.push({
      chapterNumber,
      title: asString(rec.title) || `第${chapterNumber}章`,
      summary,
    });
  }
  return beats;
}

function parseVolumes(raw: string, fallbackEnd: number): AssembledVolume[] {
  const json = parseWeaveJson(raw);
  const rows = Array.isArray(json.volumes) ? json.volumes : [];
  const volumes: AssembledVolume[] = rows.flatMap((item, index) => {
    const rec = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const start = asNumber(rec.startChapter) ?? 1;
    const end = asNumber(rec.endChapter) ?? fallbackEnd;
    const volumeNumber = asNumber(rec.volumeNumber) ?? index + 1;
    return [{
      volumeNumber,
      title: stripVolumeOrdinalPrefix(asString(rec.title)),
      startChapter: start,
      endChapter: end,
      body: asString(rec.body) || asString(rec.outline) || "",
      chapters: [],
    }];
  });
  return volumes;
}

export function validateVolumePlan(
  volumes: readonly AssembledVolume[],
  targetChapters: number,
  expectedCount?: number,
): void {
  if (!volumes.length) throw new Error("模型没有返回分卷规划。");
  if (expectedCount && volumes.length !== expectedCount) {
    throw new Error(`分卷数量应为 ${expectedCount} 卷，实际 ${volumes.length} 卷。`);
  }
  const numbers = volumes.map((volume) => volume.volumeNumber);
  if (new Set(numbers).size !== numbers.length) throw new Error("分卷卷号不能重复。");
  const ordered = [...volumes].sort((left, right) => left.startChapter - right.startChapter);
  for (const volume of ordered) {
    if (!Number.isInteger(volume.volumeNumber) || volume.volumeNumber < 1) {
      throw new Error("分卷卷号必须是正整数。");
    }
    if (!Number.isInteger(volume.startChapter) || !Number.isInteger(volume.endChapter)) {
      throw new Error("分卷起止章必须是整数。");
    }
    if (volume.startChapter < 1 || volume.endChapter < volume.startChapter) {
      throw new Error("分卷起止章无效。");
    }
    if (!volume.title.trim() || !volume.body.trim()) {
      throw new Error("分卷标题和目标不能为空。");
    }
  }
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index]!.volumeNumber !== index + 1) {
      throw new Error("分卷卷号必须从 1 按范围顺序连续编号。");
    }
  }
  if (ordered[0]?.startChapter !== 1) throw new Error(`分卷必须从第 1 章开始。`);
  if (ordered.at(-1)?.endChapter !== targetChapters) {
    throw new Error(`分卷必须覆盖到第 ${targetChapters} 章。`);
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const prev = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current.startChapter <= prev.endChapter) throw new Error("分卷范围不能重叠。");
    if (current.startChapter !== prev.endChapter + 1) throw new Error("分卷范围不能有空洞。");
  }
}

function parseVolumeCountToken(raw: string): number | undefined {
  const parsed = parseChineseInt(raw) ?? Number(raw);
  return parsed > 0 ? parsed : undefined;
}

export function inferredVolumeCount(canon: { direction?: string; oneLine?: string; proposition?: string; boundaries?: string }): number | undefined {
  const blob = [canon.direction, canon.oneLine, canon.proposition, canon.boundaries].join(" ");
  const total = /(?:总共|共|全书|合计|分为|规划为)\s*([一二三四五六七八九十百两零〇\d]+)\s*卷/.exec(blob)
    ?? /([一二三四五六七八九十百两零〇\d]+)\s*卷(?:长篇|结构|规划)/.exec(blob);
  if (total?.[1]) return parseVolumeCountToken(total[1]);
  const ordinals = [...blob.matchAll(/第\s*([一二三四五六七八九十百两零〇\d]+)\s*卷/g)]
    .map((match) => parseVolumeCountToken(match[1] ?? ""))
    .filter((value): value is number => value != null);
  const unique = [...new Set(ordinals)].sort((left, right) => left - right);
  const incomplete = /尚未确定|只确认|只列|后续分卷|总卷数尚未|开头两卷|开头几卷/.test(blob);
  if (
    !incomplete
    && unique.length >= 2
    && unique[0] === 1
    && unique.every((value, index) => value === index + 1)
  ) {
    return unique.length;
  }
  return undefined;
}

function parseBookOutline(raw: string): string {
  try {
    const json = parseWeaveJson(raw);
    return asString(json.bookOutline) || asString(json.全书大纲) || "";
  } catch {
    return "";
  }
}

export function beatsFromOutline(markdown: string): WeaveChapterBeat[] {
  if (!markdown.trim()) return [];
  const tree = parseVolumeMapTree(markdown);
  const beats: WeaveChapterBeat[] = [];
  for (const chapter of [...tree.volumes.flatMap((volume) => volume.chapters), ...tree.orphanChapters]) {
    if (chapter.kind !== "chapter") continue;
    beats.push({
      chapterNumber: chapter.chapterNumber,
      title: chapter.title || `第${chapter.chapterNumber}章`,
      summary: chapter.summary || "",
    });
  }
  if (beats.length > 0) return beats.sort((a, b) => a.chapterNumber - b.chapterNumber);
  const fallback: WeaveChapterBeat[] = [];
  const heading = /(?:^|\n)##\s*第\s*(\d+)\s*章\s*([^\n]*)\n?([\s\S]*?)(?=\n##\s*第|\n##\s*Volume|$)/g;
  let match = heading.exec(markdown);
  while (match) {
    fallback.push({
      chapterNumber: Number(match[1]),
      title: (match[2] ?? "").trim() || `第${match[1]}章`,
      summary: (match[3] ?? "").trim(),
    });
    match = heading.exec(markdown);
  }
  return fallback.sort((a, b) => a.chapterNumber - b.chapterNumber);
}

function stripVolumeOrdinalPrefix(title: string): string {
  let next = title.trim();
  for (;;) {
    const stripped = next
      .replace(/^(?:第\s*[一二三四五六七八九十百千万零〇两\d]+\s*卷|Volume\s+\d+)\s*/i, "")
      .trim();
    if (stripped === next) break;
    next = stripped;
  }
  return next || title.trim();
}

export function bookOutlineFromMarkdown(markdown: string): string {
  return volumeMapPreamble(markdown);
}

export function volumesFromOutline(markdown: string): AssembledVolume[] {
  if (!markdown.trim()) return [];
  const tree = parseVolumeMapTree(markdown);
  return tree.volumes.map((volume, index) => ({
    volumeNumber: volume.volumeNumber ?? index + 1,
    title: stripVolumeOrdinalPrefix(volume.title),
    startChapter: volume.startChapter ?? volume.chapters[0]?.chapterNumber ?? 1,
    endChapter: volume.endChapter ?? volume.chapters.at(-1)?.chapterNumber ?? 1,
    body: volume.body,
    chapters: volume.chapters.filter((chapter) => chapter.kind === "chapter").map((chapter) => ({
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      summary: chapter.summary,
    })),
  }));
}

function lastPlannedVolume<T extends { readonly volumeNumber?: number | null }>(volumes: readonly T[]): T | undefined {
  return [...volumes].sort((left, right) => (right.volumeNumber ?? 0) - (left.volumeNumber ?? 0))[0];
}

function assembleVolumes(
  beats: readonly WeaveChapterBeat[],
  volumes: readonly AssembledVolume[],
  bookOutline: string,
): { volumes: AssembledVolume[]; preamble: string } {
  const maxChapter = beats.reduce((max, beat) => Math.max(max, beat.chapterNumber), 0);
  const plan = volumes.length > 0
    ? volumes.map((volume) => ({ ...volume, chapters: [] as AssembledVolume["chapters"] }))
    : [{
      volumeNumber: 1,
      title: maxChapter <= 12 ? "第一卷" : "上卷",
      startChapter: 1,
      endChapter: maxChapter,
      body: bookOutline || `全书 ${maxChapter} 章。`,
      chapters: [],
    }];
  if (plan.length === 1 && maxChapter > 24 && !volumes.length) {
    const mid = Math.ceil(maxChapter / 2);
    plan.splice(0, 1, {
      volumeNumber: 1,
      title: "第一卷",
      startChapter: 1,
      endChapter: mid,
      body: bookOutline || `第 1-${mid} 章。`,
      chapters: [],
    }, {
      volumeNumber: 2,
      title: "第二卷",
      startChapter: mid + 1,
      endChapter: maxChapter,
      body: `第 ${mid + 1}-${maxChapter} 章。`,
      chapters: [],
    });
  }
  for (const beat of beats) {
    const home = plan.find((volume) => beat.chapterNumber >= volume.startChapter && beat.chapterNumber <= volume.endChapter)
      ?? lastPlannedVolume(plan)!;
    home.chapters = [...home.chapters, {
      chapterNumber: beat.chapterNumber,
      title: beat.title,
      summary: beat.summary,
    }];
    home.startChapter = Math.min(home.startChapter, beat.chapterNumber);
    home.endChapter = Math.max(home.endChapter, beat.chapterNumber);
  }
  return { volumes: plan, preamble: bookOutline };
}

function mergeBeats(
  existing: ReadonlyMap<number, WeaveChapterBeat>,
  generated: readonly WeaveChapterBeat[],
  start: number,
  end: number,
): WeaveChapterBeat[] {
  const collected = new Map(existing);
  for (const beat of generated) collected.set(beat.chapterNumber, beat);
  const numbers = new Set<number>([...collected.keys()]);
  for (let n = start; n <= end; n += 1) numbers.add(n);
  return [...numbers].sort((a, b) => a - b).map((n) => collected.get(n) ?? {
    chapterNumber: n,
    title: `第${n}章`,
    summary: n >= start && n <= end ? "（待补概要）" : "",
  }).filter((beat) => beat.summary || (beat.chapterNumber >= start && beat.chapterNumber <= end));
}

function extendVolumeHeadingRange(markdown: string, volumeLineStart: number, startChapter: number, endChapter: number): string {
  const lines = markdown.split("\n");
  const old = lines[volumeLineStart] ?? "";
  const replacements: Array<[RegExp, string]> = [
    [/[（(]\s*(?:第|[Cc]hapters?\s+)?\d+\s*[-–~～—]\s*\d+\s*(?:章)?\s*[）)]/, `（${startChapter}-${endChapter}章）`],
    [/第\s*\d+\s*[-–~～—]\s*\d+\s*章/, `第${startChapter}-${endChapter}章`],
    [/Chapters?\s+\d+\s*[-–~～—]\s*\d+/i, `Chapters ${startChapter}-${endChapter}`],
  ];
  let next = old;
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(old)) {
      next = old.replace(pattern, replacement);
      break;
    }
  }
  if (next === old) return markdown;
  lines[volumeLineStart] = next;
  return lines.join("\n");
}

function firstOutlineStructureLine(markdown: string): number {
  const tree = parseVolumeMapTree(markdown);
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const starts = [
    ...tree.volumes.map((volume) => volume.lineStart),
    ...tree.orphanChapters.map((chapter) => chapter.lineStart),
    ...tree.orphanNotes.map((note) => note.lineStart),
  ];
  return starts.length > 0 ? Math.min(...starts) : lines.length;
}

function insertGeneratedBookOutline(markdown: string, generatedOutline: string): string {
  const generated = generatedOutline.trim();
  if (!generated || markdown.includes(generated)) return markdown;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const first = firstOutlineStructureLine(markdown);
  const head = lines.slice(0, first).join("\n").replace(/[ \t]+$/g, "").replace(/\n+$/g, "");
  const tail = lines.slice(first).join("\n").replace(/^\n+/, "");
  return [head, generated, tail].filter((part) => part.length > 0).join("\n\n") + (markdown.endsWith("\n") ? "\n" : "");
}

function dropVolumeHeadings(markdown: string): string {
  const tree = parseVolumeMapTree(markdown);
  if (tree.volumeCount === 0) return markdown;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const headings = new Set(tree.volumes.map((volume) => volume.lineStart));
  return lines.filter((_, index) => !headings.has(index)).join("\n");
}

function noteLikeVolumeBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  const heading = trimmed.search(/^###\s+/m);
  if (heading >= 0) return trimmed.slice(heading).trim();
  if (/备注|注记|作者/.test(trimmed)) return trimmed;
  return "";
}

function collectAuthorNotes(markdown: string): string {
  if (!markdown.trim()) return "";
  const tree = parseVolumeMapTree(markdown);
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const chunks: string[] = [];
  const leading = volumeMapLeadingNotesMarkdown(markdown);
  if (leading) chunks.push(leading);
  for (const volume of tree.volumes) {
    for (const note of volume.notes) {
      const heading = (lines[note.lineStart] ?? "").trim() || `## ${note.title}`;
      chunks.push([heading, note.body].filter((part) => part.trim()).join("\n"));
    }
    const extra = noteLikeVolumeBody(volume.body);
    if (extra) chunks.push(extra);
  }
  return chunks.join("\n\n");
}

function applyVolumeExtras(
  volumes: readonly AssembledVolume[],
  source: string,
): { volumes: AssembledVolume[]; leftover: string } {
  if (!source.trim()) return { volumes: [...volumes], leftover: "" };
  const tree = parseVolumeMapTree(source);
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const extras = tree.volumes.map((volume) => {
    const parts: string[] = [];
    for (const note of volume.notes) {
      const heading = (lines[note.lineStart] ?? "").trim() || `## ${note.title}`;
      parts.push([heading, note.body].filter((part) => part.trim()).join("\n"));
    }
    const extra = noteLikeVolumeBody(volume.body);
    if (extra) parts.push(extra);
    return {
      volumeNumber: volume.volumeNumber,
      startChapter: volume.startChapter,
      endChapter: volume.endChapter,
      extras: parts.join("\n\n"),
    };
  }).filter((item) => item.extras);
  const used = new Set<number>();
  const next = volumes.map((volume) => {
    let index = extras.findIndex((item, extraIndex) => !used.has(extraIndex) && item.volumeNumber === volume.volumeNumber);
    if (index < 0) {
      index = extras.findIndex((item, extraIndex) => (
        !used.has(extraIndex)
        && item.startChapter != null
        && item.endChapter != null
        && volume.startChapter <= item.endChapter
        && volume.endChapter >= item.startChapter
      ));
    }
    if (index < 0) return volume;
    used.add(index);
    return {
      ...volume,
      body: [volume.body.trim(), extras[index]!.extras].filter(Boolean).join("\n\n"),
    };
  });
  const leftover = extras.filter((_, index) => !used.has(index)).map((item) => item.extras).join("\n\n");
  return { volumes: next, leftover };
}

async function writeWeaveDiagnostics(root: AuthoringStoreRoot, runId: string, raw: string): Promise<void> {
  if (!raw) return;
  const dir = join(authoringRootDir(root), "diagnostics");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${runId}.txt`), raw, "utf-8");
}

function volumeHeadingBlock(volume: AssembledVolume): string {
  const heading = `## 第${volume.volumeNumber}卷 ${volume.title}（${volume.startChapter}-${volume.endChapter}章）`;
  return [heading, volume.body.trim()].filter(Boolean).join("\n");
}

function attachVolumesToFlatOutline(
  base: string,
  volumes: readonly AssembledVolume[],
  generatedOutline: string,
): string {
  let markdown = insertGeneratedBookOutline(base.replace(/\r\n/g, "\n"), generatedOutline);
  if (!markdown.endsWith("\n")) markdown += "\n";
  const tree = parseVolumeMapTree(markdown);
  const planned = [...volumes]
    .sort((left, right) => left.startChapter - right.startChapter)
    .filter((volume) => !tree.volumes.some((item) => item.volumeNumber === volume.volumeNumber));
  if (planned.length === 0) return markdown;
  const chapters = [...tree.volumes.flatMap((item) => item.chapters), ...tree.orphanChapters]
    .sort((left, right) => left.lineStart - right.lineStart);
  const lineCount = markdown.split("\n").length;
  const grouped = new Map<number, AssembledVolume[]>();
  for (const volume of planned) {
    const inRange = chapters.find((node) => (
      node.chapterNumber >= volume.startChapter && node.chapterNumber <= volume.endChapter
    ));
    const later = chapters.find((node) => node.chapterNumber > volume.endChapter);
    const insertAt = inRange?.lineStart ?? later?.lineStart ?? lineCount;
    const list = grouped.get(insertAt) ?? [];
    list.push(volume);
    grouped.set(insertAt, list);
  }
  for (const insertAt of [...grouped.keys()].sort((left, right) => right - left)) {
    const block = grouped.get(insertAt)!.map(volumeHeadingBlock).join("\n\n");
    const lines = markdown.split("\n");
    markdown = [...lines.slice(0, insertAt), block, "", ...lines.slice(insertAt)].join("\n");
  }
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

function mergeBeatsIntoOutline(base: string, beats: readonly WeaveChapterBeat[]): string {
  let markdown = base.replace(/\r\n/g, "\n");
  for (const beat of beats) {
    if (!isFilledBeat(beat)) continue;
    const tree = parseVolumeMapTree(markdown);
    const exact = findExactChapterNode(tree, beat.chapterNumber);
    if (exact) {
      markdown = applyVolumeMapNodeEdit(markdown, exact.id, {
        title: beat.title,
        summary: beat.summary,
      });
      continue;
    }
    const volume = findMatchingVolumeForChapter(tree, beat.chapterNumber)
      ?? lastPlannedVolume(tree.volumes);
    if (volume?.startChapter != null && volume.endChapter != null && beat.chapterNumber > volume.endChapter) {
      markdown = extendVolumeHeadingRange(markdown, volume.lineStart, volume.startChapter, beat.chapterNumber);
    }
    const block = `## 第 ${beat.chapterNumber} 章 ${beat.title}\n${beat.summary}`;
    const lines = markdown.split("\n");
    const later = volume?.chapters.find((chapter) => chapter.chapterNumber > beat.chapterNumber);
    const insertAt = later
      ? later.lineStart
      : volume
        ? volume.lineEnd + 1
        : lines.length;
    markdown = [...lines.slice(0, insertAt), "", block, "", ...lines.slice(insertAt)].join("\n");
  }
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

function composeAuthoringPreamble(base: string | undefined, generated: string): string {
  const author = base?.trim() ? bookOutlineFromMarkdown(base) : "";
  return [...new Set([author, generated].filter(Boolean))].join("\n\n");
}

async function persistWeaveCandidate(input: {
  readonly root: AuthoringStoreRoot;
  readonly beats: readonly WeaveChapterBeat[];
  readonly volumes: readonly AssembledVolume[];
  readonly bookOutline: string;
  readonly leadingNotes?: string;
  readonly baseMarkdown?: string;
  readonly sourceMarkdown?: string;
  readonly start: number;
  readonly end: number;
  readonly targetChapters?: number;
  readonly runId: string;
  readonly parent?: { artifactId: string; version: number };
  readonly source?: "generate" | "revise" | "hand";
  readonly inputRefs?: readonly InputRef[];
  readonly scope?: string;
}): Promise<string> {
  const assembled = assembleVolumes(input.beats, input.volumes, input.bookOutline);
  const source = input.sourceMarkdown ?? input.baseMarkdown ?? "";
  const base = input.baseMarkdown ?? "";
  const baseTree = parseVolumeMapTree(base);
  const extras = applyVolumeExtras(assembled.volumes, source);
  const leadingNotes = [
    input.leadingNotes?.trim() || volumeMapLeadingNotesMarkdown(source),
    extras.leftover ? `## 待核对\n${extras.leftover}` : "",
  ].filter(Boolean).join("\n\n");
  const markdown = input.scope === "structure"
    ? mergeBeatsIntoOutline(renderVolumeMapMarkdown(extras.volumes, {
      preamble: composeAuthoringPreamble(source, assembled.preamble),
      leadingNotes,
    }), input.beats)
    : baseTree.volumeCount > 0
      ? mergeBeatsIntoOutline(base, input.beats)
      : baseTree.chapterCount > 0
        ? mergeBeatsIntoOutline(attachVolumesToFlatOutline(base, assembled.volumes, assembled.preamble), input.beats)
        : renderVolumeMapMarkdown(assembled.volumes, {
          preamble: composeAuthoringPreamble(source, assembled.preamble),
          leadingNotes,
        });
  const artifactId = newArtifactId("weave", `${input.start}-${input.end}`);
  await saveArtifact(input.root, {
    artifactId,
    stage: "weave",
    scope: input.scope ?? `chapters:${input.start}-${input.end}`,
    version: (input.parent?.version ?? 0) + 1,
    parentVersion: input.parent?.version,
    parentArtifactId: input.parent?.artifactId,
    source: input.source ?? "generate",
    status: "candidate",
    bodyPath: "story/outline/volume_map.md",
    inputRefs: input.inputRefs?.length ? [...input.inputRefs] : [{ kind: "canon", id: "canon" }],
    createdAt: new Date().toISOString(),
    runId: input.runId,
    label: input.scope === "structure" ? "分卷规划" : `规划 ${input.start}-${input.end}`,
  }, markdown);
  await writeFile(join(authoringRootDir(input.root), "artifacts", artifactId, "beats.json"), `${JSON.stringify({
    beats: input.beats,
    volumes: assembled.volumes,
    bookOutline: assembled.preamble,
    leadingNotes: input.leadingNotes ?? "",
  }, null, 2)}\n`, "utf-8");
  const generatedCount = input.beats.filter((beat) => beat.summary && beat.summary !== "（待补概要）").length;
  const manifest = await loadManifest(input.root);
  await saveManifest(input.root, {
    ...manifest,
    candidates: { ...manifest.candidates, weave: artifactId },
    coverage: {
      ...manifest.coverage,
      chaptersGenerated: generatedCount,
      chaptersTarget: Math.max(manifest.coverage.chaptersTarget ?? 0, input.targetChapters ?? 0, input.end),
    },
    lastRunId: input.runId,
  });
  return artifactId;
}

function rangeFilled(beats: readonly WeaveChapterBeat[], start: number, end: number): number[] {
  return beats
    .filter((beat) => beat.chapterNumber >= start && beat.chapterNumber <= end && isFilledBeat(beat))
    .map((beat) => beat.chapterNumber);
}

function holesInRange(collected: ReadonlyMap<number, WeaveChapterBeat>, start: number, end: number): number[] {
  const missing: number[] = [];
  for (let n = start; n <= end; n += 1) {
    if (!isFilledBeat(collected.get(n))) missing.push(n);
  }
  return missing;
}

export const WEAVE_LENGTH_REQUIRED = "WEAVE_LENGTH_REQUIRED";

export async function resolveWeaveTargetChapters(root: { projectRoot: string; bookId?: string }): Promise<number> {
  const { canon } = await loadCanonDocument(root);
  if (canon.targetChapters && canon.targetChapters > 0) return canon.targetChapters;
  if (root.bookId) {
    try {
      const raw = JSON.parse(await readFile(join(root.projectRoot, "books", root.bookId, "book.json"), "utf-8")) as { targetChapters?: unknown };
      const fromBook = asNumber(raw.targetChapters);
      if (fromBook && fromBook > 0) return fromBook;
    } catch {
      /* missing */
    }
  }
  const error = new Error("请先在问心正典里确认全书篇幅。");
  (error as Error & { code: string }).code = WEAVE_LENGTH_REQUIRED;
  throw error;
}

export async function generateWeaveStructure(input: WeaveRuntime & {
  readonly requirements?: string;
  readonly runId?: string;
}): Promise<{ artifactId: string; runId: string; volumes: AssembledVolume[]; bookOutline: string }> {
  if (!input.root.bookId) throw new Error("织卷需要已建的书。");
  const target = await resolveWeaveTargetChapters(input.root);
  const resolved = await resolve(input.project, "weave.main", input.root.projectRoot);
  const { canon } = await loadCanonDocument(input.root);
  const expectedCount = inferredVolumeCount(canon);
  const existingOutline = await loadOutlineText(input.root);
  const manifest = await loadManifest(input.root);
  const previous = manifest.candidates.weave
    ? await loadArtifact(input.root, manifest.candidates.weave)
    : manifest.adopted.weave
      ? await loadArtifact(input.root, manifest.adopted.weave)
      : undefined;
  const seedMarkdown = previous?.body || existingOutline;
  const existingBeats = beatsFromOutline(seedMarkdown).filter((beat) => isFilledBeat(beat));
  const ctx = await assembleAuthoringContext(input.root, {
    stage: "weave",
    outlineOverride: seedMarkdown.trim() ? seedMarkdown : undefined,
  });
  const runId = input.runId ?? newRunId();
  const startedAt = new Date().toISOString();
  await saveRun(input.root, {
    runId,
    stage: "weave",
    operation: "generate",
    roleId: "weave.main",
    status: "running",
    bookId: input.root.bookId,
    progressDone: 0,
    progressTotal: expectedCount ?? 1,
    progressLabel: "分卷规划",
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [],
    checkpoint: { targetChapters: target, producedScope: "structure" },
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  let raw = "";
  try {
    raw = await completeRole(resolved, [
      `规划全书分卷结构。全书目标 ${target} 章。`,
      expectedCount ? `必须正好 ${expectedCount} 卷，保持已确认的卷序。` : "",
      "只输出 JSON：{ bookOutline: string, volumes: [{ volumeNumber, title, startChapter, endChapter, body }] }。",
      "不要输出 chapters。volumes 必须从第1章连续覆盖到全书目标，卷号从1起且不重复，范围无重叠、无空洞。",
      "不要用一卷或两卷硬凑。",
      input.requirements ? `作者要求：\n${input.requirements}` : "",
      serializeCanonBrief(canon),
      ctx.text,
    ].filter(Boolean).join("\n"), input.llm);
    const volumes = parseVolumes(raw, target);
    const bookOutline = parseBookOutline(raw);
    validateVolumePlan(volumes, target, expectedCount);
    const artifactId = await persistWeaveCandidate({
      root: input.root,
      beats: existingBeats,
      volumes,
      bookOutline,
      leadingNotes: volumeMapLeadingNotesMarkdown(seedMarkdown),
      sourceMarkdown: seedMarkdown,
      baseMarkdown: seedMarkdown.trim() ? dropVolumeHeadings(seedMarkdown) : undefined,
      start: 1,
      end: target,
      targetChapters: target,
      runId,
      parent: previous ? { artifactId: previous.meta.artifactId, version: previous.meta.version } : undefined,
      source: "generate",
      inputRefs: ctx.refs,
      scope: "structure",
    });
    await saveRun(input.root, {
      runId,
      stage: "weave",
      operation: "generate",
      roleId: "weave.main",
      status: "completed",
      bookId: input.root.bookId,
      progressDone: volumes.length,
      progressTotal: volumes.length,
      progressLabel: `分卷 ${volumes.length}`,
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [artifactId],
      checkpoint: { targetChapters: target, producedScope: "structure" },
      createdAt: startedAt,
      updatedAt: new Date().toISOString(),
    });
    return { artifactId, runId, volumes, bookOutline };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveRun(input.root, {
      runId,
      stage: "weave",
      operation: "generate",
      roleId: "weave.main",
      status: "failed",
      bookId: input.root.bookId,
      progressDone: 0,
      progressTotal: expectedCount ?? 1,
      progressLabel: "分卷规划失败",
      error: message,
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [],
      checkpoint: { targetChapters: target, producedScope: "structure" },
      createdAt: startedAt,
      updatedAt: new Date().toISOString(),
    });
    await writeWeaveDiagnostics(input.root, runId, raw);
    throw error;
  }
}

export async function generateWeaveRange(input: WeaveRuntime & {
  readonly requirements?: string;
  readonly startChapter: number;
  readonly endChapter: number;
  readonly targetChapters?: number;
  readonly existing?: ReadonlyArray<WeaveChapterBeat>;
  readonly keepExisting?: boolean;
  readonly resumeRunId?: string;
  readonly runId?: string;
  readonly missingChapters?: readonly number[];
}): Promise<{
  beats: WeaveChapterBeat[];
  runId: string;
  artifactId: string;
  status: AuthoringRunRecord["status"];
}> {
  if (!input.root.bookId) throw new Error("织卷需要已建的书。");
  const start = Math.max(1, input.startChapter);
  const end = Math.max(start, input.endChapter);
  const bookTarget = await resolveWeaveTargetChapters(input.root);
  if (end > bookTarget) throw new Error(`本次结束章 ${end} 超出全书目标 ${bookTarget} 章。`);
  const bookDir = join(input.root.projectRoot, "books", input.root.bookId);
  const existingOutline = await loadOutlineText(input.root);
  const manifest = await loadManifest(input.root);
  const resolved = await resolve(input.project, "weave.main", input.root.projectRoot);
  const { canon } = await loadCanonDocument(input.root);
  const candidateLoaded = manifest.candidates.weave
    ? await loadArtifact(input.root, manifest.candidates.weave)
    : undefined;
  let seedMarkdown = candidateLoaded?.body || existingOutline;
  if (!input.resumeRunId && await isLightweightAuthoringBook(bookDir)) {
    const volumes = volumesFromOutline(seedMarkdown);
    if (!volumes.length) {
      throw new Error("请先生成分卷结构，再生成章概要。");
    }
    validateVolumePlan(volumes, bookTarget);
  }
  const ctx = await assembleAuthoringContext(input.root, {
    stage: "weave",
    outlineOverride: seedMarkdown.trim() ? seedMarkdown : undefined,
  });
  const adoptedBeats = beatsFromOutline(seedMarkdown);
  const existingMap = new Map<number, WeaveChapterBeat>();
  for (const beat of adoptedBeats) existingMap.set(beat.chapterNumber, beat);
  for (const beat of input.existing ?? []) existingMap.set(beat.chapterNumber, beat);
  let bookOutline = bookOutlineFromMarkdown(seedMarkdown);
  const lockFromCurrent = Boolean(candidateLoaded?.body != null) || Boolean(existingOutline.trim());
  let leadingNotes = volumeMapLeadingNotesMarkdown(seedMarkdown);
  let volumes = volumesFromOutline(seedMarkdown).map((volume) => ({
    ...volume,
    title: stripVolumeOrdinalPrefix(volume.title),
  }));
  const resume = input.resumeRunId ? await loadRun(input.root, input.resumeRunId) : undefined;
  const requirements = input.requirements ?? resume?.checkpoint?.requirements;
  const fillHolesFrom = (beats: readonly WeaveChapterBeat[], nextOutline?: string, nextVolumes?: AssembledVolume[]) => {
    for (const beat of beats) {
      if (!isFilledBeat(beat) || isFilledBeat(existingMap.get(beat.chapterNumber))) continue;
      existingMap.set(beat.chapterNumber, beat);
    }
    if (!lockFromCurrent && !bookOutline && nextOutline) bookOutline = nextOutline;
    if (!volumes.length && nextVolumes?.length) {
      volumes = nextVolumes.map((volume) => ({ ...volume, title: stripVolumeOrdinalPrefix(volume.title) }));
    }
  };
  const overlayFromArtifact = async (artifactId: string) => {
    try {
      const raw = JSON.parse(await readFile(
        join(authoringRootDir(input.root), "artifacts", artifactId, "beats.json"),
        "utf-8",
      )) as { beats?: WeaveChapterBeat[]; volumes?: AssembledVolume[]; bookOutline?: string; leadingNotes?: string };
      fillHolesFrom(raw.beats ?? [], raw.bookOutline, raw.volumes);
      if (!lockFromCurrent && !leadingNotes && raw.leadingNotes) leadingNotes = raw.leadingNotes;
    } catch {
      const previous = await loadArtifact(input.root, artifactId);
      if (previous) {
        if (!lockFromCurrent && !leadingNotes) leadingNotes = volumeMapLeadingNotesMarkdown(previous.body);
        fillHolesFrom(
          beatsFromOutline(previous.body),
          bookOutlineFromMarkdown(previous.body),
          volumesFromOutline(previous.body),
        );
      }
    }
  };
  if (candidateLoaded?.meta.artifactId) {
    await overlayFromArtifact(candidateLoaded.meta.artifactId);
  }
  const checkpointId = resume?.producedArtifactIds.at(-1);
  if (checkpointId && checkpointId !== candidateLoaded?.meta.artifactId) {
    await overlayFromArtifact(checkpointId);
  }
  const runId = input.runId ?? resume?.runId ?? newRunId();
  if (input.resumeRunId) await saveRunControl(input.root, runId, "none");
  const requestedStart = resume?.checkpoint?.requestedStart ?? start;
  const requestedEnd = resume?.checkpoint?.requestedEnd ?? end;
  let missing: number[] = [];
  if (input.missingChapters?.length) {
    missing = input.missingChapters.filter((n) => !isFilledBeat(existingMap.get(n)));
  } else if (resume?.checkpoint?.missingChapters?.length) {
    missing = resume.checkpoint.missingChapters.filter((n) => !isFilledBeat(existingMap.get(n)));
  } else {
    for (let n = requestedStart; n <= requestedEnd; n += 1) {
      const good = isFilledBeat(existingMap.get(n));
      if (!input.resumeRunId && input.keepExisting && good) continue;
      if (input.resumeRunId && good) continue;
      missing.push(n);
    }
  }
  const batches: number[][] = [];
  for (let i = 0; i < missing.length; i += 4) {
    batches.push(missing.slice(i, i + 4));
  }
  const collected = new Map(existingMap);
  const createdAt = resume?.createdAt ?? new Date().toISOString();
  let artifactId = resume?.producedArtifactIds.at(-1) ?? "";
  await saveRun(input.root, {
    runId,
    stage: "weave",
    operation: "generate",
    roleId: "weave.main",
    status: "running",
    bookId: input.root.bookId,
    progressDone: holesInRange(collected, requestedStart, requestedEnd).length === 0
      ? requestedEnd - requestedStart + 1
      : rangeFilled([...collected.values()], requestedStart, requestedEnd).length,
    progressTotal: requestedEnd - requestedStart + 1,
    progressLabel: `本次 ${rangeFilled([...collected.values()], requestedStart, requestedEnd).length}/${requestedEnd - requestedStart + 1}`,
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: artifactId ? [artifactId] : [],
    checkpoint: {
      requirements,
      requestedStart,
      requestedEnd,
      missingChapters: missing,
      completedChapters: rangeFilled([...collected.values()], requestedStart, requestedEnd),
      remainingStart: missing[0],
      remainingEnd: missing.at(-1),
      producedScope: `chapters:${requestedStart}-${requestedEnd}`,
      targetChapters: bookTarget,
    },
    createdAt,
    updatedAt: new Date().toISOString(),
  });

  const priorBeatsText = (beforeChapter: number) => [...collected.values()]
    .filter((beat) => beat.chapterNumber < beforeChapter && isFilledBeat(beat))
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
    .slice(-8)
    .map((beat) => `第${beat.chapterNumber}章 ${beat.title}：${beat.summary}`)
    .join("\n");

  const writeCheckpoint = (status: AuthoringRunRecord["status"], extra?: { error?: string; remaining?: number[] }) => {
    const remaining = extra?.remaining ?? holesInRange(collected, requestedStart, requestedEnd);
    const completed = rangeFilled([...collected.values()], requestedStart, requestedEnd);
    return {
      runId,
      stage: "weave" as const,
      operation: "generate" as const,
      roleId: "weave.main" as const,
      status,
      bookId: input.root.bookId,
      progressDone: completed.length,
      progressTotal: requestedEnd - requestedStart + 1,
      progressLabel: `本次 ${completed.length}/${requestedEnd - requestedStart + 1}`,
      error: extra?.error,
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: artifactId ? [artifactId] : [],
      checkpoint: {
        requirements,
        requestedStart,
        requestedEnd,
        missingChapters: remaining,
        completedChapters: completed,
        remainingStart: remaining[0],
        remainingEnd: remaining.at(-1),
        producedScope: `chapters:${requestedStart}-${requestedEnd}`,
        completedThrough: completed.at(-1),
        targetChapters: bookTarget,
      },
      createdAt,
      updatedAt: new Date().toISOString(),
    };
  };

  const writeCandidate = async (beats: WeaveChapterBeat[]): Promise<string> => {
    const parentMeta = candidateLoaded?.meta;
    const id = await persistWeaveCandidate({
      root: input.root,
      beats,
      volumes,
      bookOutline,
      leadingNotes,
      baseMarkdown: seedMarkdown,
      start: requestedStart,
      end: requestedEnd,
      targetChapters: bookTarget,
      runId,
      parent: parentMeta ? { artifactId: parentMeta.artifactId, version: parentMeta.version } : undefined,
      inputRefs: ctx.refs,
    });
    const saved = await loadArtifact(input.root, id);
    if (saved?.body) seedMarkdown = saved.body;
    return id;
  };

  let raw = "";
  try {
    for (const batch of batches) {
      const batchStart = batch[0]!;
      const batchEnd = batch[batch.length - 1]!;
      const control = await loadRunControl(input.root, runId);
      if (control === "pause") {
        const beats = mergeBeats(collected, [], requestedStart, requestedEnd);
        artifactId = await writeCandidate(beats);
        await saveRun(input.root, writeCheckpoint("paused"));
        return { beats, runId, artifactId, status: "paused" };
      }
      if (control === "cancel") {
        const beats = mergeBeats(collected, [], requestedStart, requestedEnd);
        await saveRun(input.root, writeCheckpoint("cancelled"));
        return { beats, runId, artifactId, status: "cancelled" };
      }
      const contiguous = batch.every((num, index) => index === 0 || num === batch[index - 1]! + 1);
      const rangeLabel = contiguous ? `${batchStart}-${batchEnd}` : batch.join("、");
      raw = await completeRole(resolved, [
        `规划第 ${rangeLabel} 章概要。全书目标 ${bookTarget} 章。本次只细化该范围，不要把本次章数当成全书篇幅。`,
        contiguous ? "" : "只改列出的章号，不要改未列出的章。",
        volumes.length
          ? "只输出 JSON：{ chapters: [{ chapterNumber, title, summary }] }。不要改已有分卷。"
          : "只输出 JSON：{ bookOutline, volumes: [{ volumeNumber, title, startChapter, endChapter, body }], chapters: [{ chapterNumber, title, summary }] }。",
        volumes.length ? "chapters 只含本批章。" : "chapters 只含本批章。volumes 覆盖全书。",
        "summary 须含视角、地点、目标、冲突、转折、结尾衔接、伏笔。",
        "正文中的引语优先用中文引号「」；若用英文双引号，必须按 JSON 规则转义。",
        requirements ? `作者本次要求：\n${requirements}` : "",
        requirements && seedMarkdown ? `当前规划（请按要求保留或调整本次范围）：\n${seedMarkdown}` : "",
        serializeCanonBrief(canon),
        ctx.text,
        leadingNotes && `当前作者备注：\n${leadingNotes}`,
        bookOutline && `已有全书大纲：\n${bookOutline}`,
        volumes.length ? `已有分卷：\n${volumes.map((volume) => `第${volume.volumeNumber}卷 ${volume.title}（${volume.startChapter}-${volume.endChapter}） ${volume.body}`).join("\n")}` : "",
        priorBeatsText(batchStart) && `已生成章概要：\n${priorBeatsText(batchStart)}`,
      ].filter(Boolean).join("\n"), input.llm);
      const allowStructure = requestedStart === 1 && batchStart === 1 && !input.resumeRunId && !volumes.length;
      const nextBook = parseBookOutline(raw);
      if (nextBook && (allowStructure || !bookOutline)) bookOutline = nextBook;
      const nextVolumes = parseVolumes(raw, bookTarget);
      if (nextVolumes.length && (allowStructure || !volumes.length)) volumes = nextVolumes;
      for (const beat of parseRequestedBeats(raw, batch)) {
        const previous = collected.get(beat.chapterNumber);
        if (!isFilledBeat(beat) && isFilledBeat(previous)) continue;
        collected.set(beat.chapterNumber, beat);
      }
      const beats = mergeBeats(collected, [], requestedStart, requestedEnd);
      artifactId = await writeCandidate(beats);
      const remaining = holesInRange(collected, requestedStart, requestedEnd);
      await saveRun(input.root, writeCheckpoint(remaining.length === 0 ? "completed" : "running", { remaining }));
    }
  } catch (error) {
    const beats = mergeBeats(collected, [], requestedStart, requestedEnd);
    if (beats.some((beat) => isFilledBeat(beat))) {
      artifactId = await writeCandidate(beats);
    }
    const remaining = holesInRange(collected, requestedStart, requestedEnd);
    await saveRun(input.root, writeCheckpoint(remaining.length && rangeFilled(beats, requestedStart, requestedEnd).length ? "partial" : remaining.length ? "failed" : "completed", {
      error: error instanceof Error ? error.message : String(error),
      remaining,
    }));
    await writeWeaveDiagnostics(input.root, runId, raw);
    if (rangeFilled(beats, requestedStart, requestedEnd).length === 0) throw error;
    return { beats, runId, artifactId, status: "partial" };
  }

  const beats = mergeBeats(collected, [], requestedStart, requestedEnd);
  if (!artifactId) {
    artifactId = await writeCandidate(beats);
  }
  const remaining = holesInRange(collected, requestedStart, requestedEnd);
  const complete = remaining.length === 0;
  await saveRun(input.root, writeCheckpoint(complete ? "completed" : "partial", { remaining }));
  return { beats, runId, artifactId, status: complete ? "completed" : "partial" };
}

export async function reviewWeave(input: WeaveRuntime & {
  readonly artifactId: string;
  readonly coverage: string;
  readonly runId?: string;
}): Promise<AuthoringReviewReport> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  if (!loaded) throw new Error("找不到规划成果。");
  const resolved = await resolve(input.project, "weave.review", input.root.projectRoot);
  const runId = input.runId ?? newRunId();
  const startedAt = new Date().toISOString();
  await saveRun(input.root, {
    runId,
    stage: "weave",
    operation: "review",
    roleId: "weave.review",
    status: "running",
    bookId: input.root.bookId,
    progressLabel: "正在审查规划",
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [],
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  try {
    const ctx = await assembleAuthoringContext(input.root, { stage: "weave" });
    const text = await completeRole(
      resolved,
      reviewPrompt("weave", input.coverage, loaded.body, ctx.text),
      input.llm,
    );
    const report = parseReviewPayload(text, {
      stage: "weave",
      targetRefs: [loaded.meta.artifactId],
      coverage: input.coverage,
      model: resolved.modelId,
      runId,
      inputRefs: [{ kind: "artifact", id: loaded.meta.artifactId, version: loaded.meta.version }, ...ctx.refs],
    });
    await saveReport(input.root, report);
    await saveRun(input.root, {
      runId,
      stage: "weave",
      operation: "review",
      roleId: "weave.review",
      status: "completed",
      bookId: input.root.bookId,
      reportId: report.reportId,
      progressDone: 1,
      progressTotal: 1,
      progressLabel: "审查完成",
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [],
      createdAt: startedAt,
      updatedAt: new Date().toISOString(),
    });
    return report;
  } catch (error) {
    await saveRun(input.root, {
      runId,
      stage: "weave",
      operation: "review",
      roleId: "weave.review",
      status: "failed",
      bookId: input.root.bookId,
      error: error instanceof Error ? error.message : String(error),
      progressLabel: "审查失败",
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [],
      createdAt: startedAt,
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }
}

export async function adoptWeave(input: WeaveRuntime & { readonly artifactId: string }): Promise<void> {
  if (!input.root.bookId) throw new Error("织卷采用需要已建的书。");
  const loaded = await loadArtifact(input.root, input.artifactId);
  if (!loaded) throw new Error("找不到可采用的规划。");
  const volumes = volumesFromOutline(loaded.body);
  const beats = beatsFromOutline(loaded.body);
  const filledBeats = beats.filter((beat) => beat.summary && beat.summary !== "（待补概要）");
  if (input.root.bookId && await isLightweightAuthoringBook(join(input.root.projectRoot, "books", input.root.bookId))) {
    const target = await resolveWeaveTargetChapters(input.root);
    const { canon } = await loadCanonDocument(input.root);
    validateVolumePlan(volumes, target, inferredVolumeCount(canon));
  }
  const filled = filledBeats.length;
  const manifest = await loadManifest(input.root);
  const nextManifest = WorkflowManifestSchema.parse({
    ...manifest,
    adopted: { ...manifest.adopted, weave: loaded.meta.artifactId },
    coverage: {
      ...manifest.coverage,
      chaptersAdopted: filled,
      chaptersGenerated: Math.max(manifest.coverage.chaptersGenerated ?? 0, filled),
    },
    updatedAt: new Date().toISOString(),
  });
  const adoptedMeta = { ...loaded.meta, status: "adopted" as const };
  const body = loaded.body.endsWith("\n") ? loaded.body : `${loaded.body}\n`;
  const bookDir = join(input.root.projectRoot, "books", input.root.bookId);
  await commitAtomicFileSet({
    rootDir: bookDir,
    writes: [
      { relativePath: "story/outline/volume_map.md", content: body },
      { relativePath: `story/workflow/artifacts/${loaded.meta.artifactId}/body.md`, content: body },
      { relativePath: `story/workflow/artifacts/${loaded.meta.artifactId}/meta.json`, content: `${JSON.stringify(adoptedMeta, null, 2)}\n` },
      { relativePath: "story/workflow/manifest.json", content: `${JSON.stringify(nextManifest, null, 2)}\n` },
    ],
  });
  await closeImpactItemsAfterAdopt(input.root, { weaveBody: body, weaveArtifactId: loaded.meta.artifactId });
}

async function reviseWeaveChapters(
  input: Parameters<typeof reviseWeave>[0],
  original: NonNullable<Awaited<ReturnType<typeof loadArtifact>>>,
  report: AuthoringReviewReport,
  resolved: Awaited<ReturnType<typeof resolve>>,
  ctx: Awaited<ReturnType<typeof assembleAuthoringContext>>,
  resume?: AuthoringRunRecord,
): Promise<string> {
  if (!Number.isInteger(input.startChapter) || !Number.isInteger(input.endChapter)
    || input.startChapter < 1 || input.endChapter < input.startChapter) {
    throw new Error("请输入有效的修订章范围。");
  }
  const requested = [...new Set(beatsFromOutline(original.body)
    .filter((beat) => isFilledBeat(beat) && beat.chapterNumber >= input.startChapter && beat.chapterNumber <= input.endChapter)
    .map((beat) => beat.chapterNumber))].sort((a, b) => a - b);
  if (!requested.length) throw new Error("该范围还没有章概要，请先生成概要再按意见修订。");
  const start = requested[0]!;
  const end = requested.at(-1)!;
  const selected = report.issues.filter((issue) => input.selectedIssueIds.includes(issue.issueId));
  const runId = input.runId ?? newRunId();
  const createdAt = resume?.createdAt ?? new Date().toISOString();
  const completed = new Set((resume?.checkpoint?.completedChapters ?? []).filter((n) => requested.includes(n)));
  const resumedId = resume?.producedArtifactIds.at(-1);
  let latest = resumedId ? await loadArtifact(input.root, resumedId) : original;
  if (!latest) throw new Error("找不到已保存的修订稿，原规划仍保留。");
  if (resume) {
    const manifest = await loadManifest(input.root);
    if (manifest.candidates.weave && manifest.candidates.weave !== latest.meta.artifactId) {
      throw new Error("规划已有后续修改，请对当前稿件重新审查并发起修订，以保留你的修改。");
    }
    await saveRunControl(input.root, runId, "none");
  }
  let markdown = latest.body;
  let artifactId = resumedId ?? "";
  const saveProgress = async (status: AuthoringRunRecord["status"], error?: string) => {
    const missing = requested.filter((n) => !completed.has(n));
    await saveRun(input.root, {
      runId, stage: "weave", operation: "revise", roleId: "weave.main", status,
      bookId: input.root.bookId, scope: `chapters:${start}-${end}`,
      progressDone: completed.size, progressTotal: requested.length,
      progressLabel: `修订 ${completed.size}/${requested.length} 章`, error,
      modelSnapshot: resolved.snapshot, producedArtifactIds: artifactId ? [artifactId] : [],
      reportId: report.reportId,
      checkpoint: {
        requirements: input.requirements,
        requestedStart: start, requestedEnd: end,
        completedChapters: [...completed].sort((a, b) => a - b), missingChapters: missing,
        remainingStart: missing[0], remainingEnd: missing.at(-1),
        producedScope: `chapters:${start}-${end}`,
        revisionArtifactId: original.meta.artifactId,
        revisionIssueIds: [...input.selectedIssueIds], revisionReuseStale: input.reuseStale,
      },
      createdAt, updatedAt: new Date().toISOString(),
    });
  };
  await saveProgress("running");
  const missing = requested.filter((n) => !completed.has(n));
  let text = "";
  let batchLabel = "";
  try {
    for (let offset = 0; offset < missing.length; offset += 4) {
      const batch = missing.slice(offset, offset + 4);
      const control = await loadRunControl(input.root, runId);
      if (control === "pause" || control === "cancel") {
        await saveProgress(control === "pause" ? "paused" : "cancelled");
        return artifactId || original.meta.artifactId;
      }
      const contiguous = batch.every((n, i) => i === 0 || n === batch[i - 1]! + 1);
      batchLabel = contiguous ? `${batch[0]}-${batch.at(-1)}` : batch.join("、");
      text = "";
      text = await completeRole(resolved, [
        `只改第 ${batchLabel} 章概要。输出 JSON：{ chapters: [{ chapterNumber, title, summary }] }。`,
        `本次修订范围第 ${start}-${end} 章；当前批次只输出这些章号：${batch.join("、")}。`,
        "不要改范围外的章节，不要补写尚未生成的章。未涉及意见的章节保留原文；本批无须改动的章节可照原文返回，不要返回空 chapters。",
        "保留概要必要信息，勿扩写成正文；只输出本批最多四章的完整 JSON。",
        "正文中的引语优先用中文引号「」；若用英文双引号，必须按 JSON 规则转义。",
        ...selected.map((issue) => `- ${issue.title}: ${issue.suggestion ?? ""}`),
        input.requirements ? `作者本次要求：\n${input.requirements}` : "",
        ctx.text,
        `当前规划（含已经完成的修订，范围外仅供参考）：\n${markdown}`,
      ].filter(Boolean).join("\n"), input.llm);
      const updated = parseReturnedBeats(text).filter((beat) => batch.includes(beat.chapterNumber));
      if (!updated.length) throw new Error("模型没有返回本批可用的章概要。");
      let nextMarkdown = markdown;
      let applied = 0;
      for (const beat of updated) {
        const node = findExactChapterNode(parseVolumeMapTree(nextMarkdown), beat.chapterNumber);
        if (!node) continue;
        nextMarkdown = applyVolumeMapNodeEdit(nextMarkdown, node.id, { title: beat.title, summary: beat.summary });
        applied += 1;
      }
      if (!applied) throw new Error("找不到可更新的精确章节。");
      const nextId = newArtifactId("weave", `${start}-${end}`);
      const nextMeta: AuthoringArtifactMeta = {
        artifactId: nextId, stage: "weave" as const, scope: `chapters:${start}-${end}`,
        version: latest.meta.version + 1, parentVersion: latest.meta.version,
        parentArtifactId: latest.meta.artifactId, source: "revise" as const,
        status: "candidate" as const, bodyPath: "story/outline/volume_map.md",
        inputRefs: [
          { kind: "report", id: report.reportId },
          { kind: "artifact", id: original.meta.artifactId, version: original.meta.version },
          ...ctx.refs,
        ],
        createdAt: new Date().toISOString(), runId,
      };
      await saveArtifact(input.root, nextMeta, nextMarkdown);
      const manifest = await loadManifest(input.root);
      await saveManifest(input.root, { ...manifest, candidates: { ...manifest.candidates, weave: nextId } });
      latest = { meta: nextMeta, body: nextMarkdown };
      markdown = nextMarkdown;
      artifactId = nextId;
      batch.forEach((n) => completed.add(n));
      await saveProgress(completed.size === requested.length ? "completed" : "running");
    }
    await saveProgress("completed");
    return artifactId || original.meta.artifactId;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const message = `第 ${batchLabel} 章修订失败：${cause}。已保留原规划${completed.size ? "和已完成的修订，可继续剩余修订" : "，请重试修订"}。`;
    await saveProgress(completed.size ? "partial" : "failed", message);
    await writeWeaveDiagnostics(input.root, runId, text);
    if (completed.size) return artifactId || original.meta.artifactId;
    throw new Error(message, { cause: error });
  }
}

export async function reviseWeave(input: WeaveRuntime & {
  readonly requirements?: string;
  readonly artifactId: string;
  readonly reportId: string;
  readonly selectedIssueIds: readonly string[];
  readonly startChapter: number;
  readonly endChapter: number;
  readonly reuseStale?: boolean;
  readonly reviseStructure?: boolean;
  readonly runId?: string;
  readonly resumeRunId?: string;
}): Promise<string> {
  const resume = input.resumeRunId ? await loadRun(input.root, input.resumeRunId) : undefined;
  if (input.resumeRunId) {
    const checkpoint = resume?.checkpoint;
    if (resume?.operation !== "revise" || !resume.reportId || !checkpoint?.revisionArtifactId
      || !checkpoint.revisionIssueIds || !checkpoint.requestedStart || !checkpoint.requestedEnd) {
      throw new Error("这次旧修订没有可恢复的记录，请回到审查意见重新发起修订；已有规划已保留。");
    }
    input = {
      ...input,
      artifactId: checkpoint.revisionArtifactId,
      reportId: resume.reportId,
      selectedIssueIds: checkpoint.revisionIssueIds,
      requirements: checkpoint.requirements,
      reuseStale: checkpoint.revisionReuseStale,
      startChapter: checkpoint.requestedStart,
      endChapter: checkpoint.requestedEnd,
      reviseStructure: false,
      runId: resume.runId,
    };
  }
  const loaded = await loadArtifact(input.root, input.artifactId);
  const report = await loadReport(input.root, input.reportId);
  if (!loaded || !report) throw new Error("修订规划需要成果和报告。");
  assertReportReusable(report, loaded.meta.artifactId, input.reuseStale);
  const selected = report.issues.filter((issue) => input.selectedIssueIds.includes(issue.issueId));
  const resolved = await resolve(input.project, "weave.main", input.root.projectRoot);
  const ctx = await assembleAuthoringContext(input.root, { stage: "weave", outlineOverride: loaded.body });
  const filledBeats = beatsFromOutline(loaded.body).filter((beat) => isFilledBeat(beat));
  const reviseStructure = input.reviseStructure === true
    || (input.reviseStructure !== false && filledBeats.length === 0 && volumesFromOutline(loaded.body).length > 0);
  if (!reviseStructure) return reviseWeaveChapters(input, loaded, report, resolved, ctx, resume);
  const runId = input.runId ?? newRunId();
  const startedAt = new Date().toISOString();
  await saveRun(input.root, {
    runId,
    stage: "weave",
    operation: "revise",
    roleId: "weave.main",
    status: "running",
    bookId: input.root.bookId,
    scope: reviseStructure ? "structure" : `chapters:${input.startChapter}-${input.endChapter}`,
    progressDone: 0,
    progressTotal: 1,
    progressLabel: reviseStructure ? "结构修订" : `修订第 ${input.startChapter}-${input.endChapter} 章`,
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [],
    reportId: report.reportId,
    checkpoint: { producedScope: reviseStructure ? "structure" : `chapters:${input.startChapter}-${input.endChapter}` },
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  let text = "";
  try {
  text = await completeRole(resolved, [
      "按选中意见修改分卷结构。输出 JSON：{ bookOutline, volumes: [{ volumeNumber, title, startChapter, endChapter, body }] }。",
      "不要删除已有章概要。volumes 必须连续覆盖全书目标，无重叠无空洞。",
      ...selected.map((issue) => `- ${issue.title}: ${issue.suggestion ?? ""}`),
      input.requirements ? `作者本次要求：\n${input.requirements}` : "",
      ctx.text,
      loaded.body,
    ].join("\n"), input.llm);
    const target = await resolveWeaveTargetChapters(input.root);
    const { canon } = await loadCanonDocument(input.root);
    const volumes = parseVolumes(text, target);
    validateVolumePlan(volumes, target, inferredVolumeCount(canon));
    const bookOutline = parseBookOutline(text) || bookOutlineFromMarkdown(loaded.body);
    const beats = filledBeats;
    const artifactId = await persistWeaveCandidate({
      root: input.root,
      beats,
      volumes,
      bookOutline,
      leadingNotes: volumeMapLeadingNotesMarkdown(loaded.body),
      sourceMarkdown: loaded.body,
      baseMarkdown: dropVolumeHeadings(loaded.body),
      start: 1,
      end: target,
      targetChapters: target,
      runId,
      parent: { artifactId: loaded.meta.artifactId, version: loaded.meta.version },
      source: "revise",
      inputRefs: [
        { kind: "report", id: report.reportId },
        { kind: "artifact", id: loaded.meta.artifactId, version: loaded.meta.version },
        ...ctx.refs,
      ],
      scope: "structure",
    });
    await saveRun(input.root, {
      runId,
      stage: "weave",
      operation: "revise",
      roleId: "weave.main",
      status: "completed",
      bookId: input.root.bookId,
      scope: "structure",
      progressDone: 1,
      progressTotal: 1,
      progressLabel: "结构修订",
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [artifactId],
      reportId: report.reportId,
      checkpoint: { producedScope: "structure" },
      createdAt: startedAt,
      updatedAt: new Date().toISOString(),
    });
    return artifactId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveRun(input.root, {
      runId,
      stage: "weave",
      operation: "revise",
      roleId: "weave.main",
      status: "failed",
      bookId: input.root.bookId,
      scope: reviseStructure ? "structure" : `chapters:${input.startChapter}-${input.endChapter}`,
      progressDone: 0,
      progressTotal: 1,
      progressLabel: "修订失败",
      error: message,
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [],
      reportId: report.reportId,
      checkpoint: { producedScope: reviseStructure ? "structure" : `chapters:${input.startChapter}-${input.endChapter}` },
      createdAt: startedAt,
      updatedAt: new Date().toISOString(),
    });
    await writeWeaveDiagnostics(input.root, runId, text);
    throw error;
  }
}
