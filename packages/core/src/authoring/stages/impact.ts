/**
 * Canon-impact triage: field diff → LLM / heuristic mapping → close rules.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseVolumeMapTree } from "../../utils/volume-map-tree.js";
import { CANON_IMPACT_FIELDS, canonFieldDiff, parseCanon, type CanonFieldChange } from "../canon.js";
import {
  isConstraintSetting,
  nameHitsNeedle,
  settingAliases,
  significantTokens,
} from "../context.js";
import { asString, asStringArray, extractJsonObject } from "../json.js";
import { completeRole } from "../llm.js";
import { fillMissingAuthoringRoles, loadRoleApiKeys, resolveAuthoringRole } from "../model-config.js";
import {
  AuthoringRunCancelledError,
  listArtifacts,
  loadArtifact,
  loadCurrentImpact,
  loadManifest,
  loadRun,
  loadRunControl,
  loadSettingsCatalog,
  newRunId,
  saveImpactReport,
  saveManifest,
  saveReport,
  saveRun,
  type AuthoringStoreRoot,
} from "../store.js";
import {
  AuthoringRunRecordSchema,
  ImpactItemSchema,
  ImpactReportSchema,
  type AuthoringArtifactMeta,
  type AuthoringLlmFn,
  type AuthoringReviewReport,
  type AuthoringRunRecord,
  type DependencyWatch,
  type ImpactGlobalNote,
  type ImpactItem,
  type ImpactReport,
  type SettingsCatalogEntry,
  type WorkflowManifest,
} from "../types.js";
import type { ProjectConfig } from "../../models/project.js";
import type { z } from "zod";

const GROUND_BATCH = 60;
const WEAVE_BATCH = 50;
const WEAVE_VOLUME_THRESHOLD = 120;
const CLIP_CHANGE = 600;
const CLIP_ENTRY = 120;
const CLIP_SUMMARY = 200;
const REALITY_GENRE = /现实|都市|历史|职场|军旅|年代/;
const FANTASY_GENRE = /幻想|玄幻|奇幻|仙侠|科幻|魔幻|修仙/;
const MAPPABLE_FIELDS = new Set(["oneLine", "proposition", "protagonist", "conflict", "boundaries", "direction", "genre", "targetChapters"]);

export interface ImpactRuntime {
  readonly root: AuthoringStoreRoot;
  readonly project: ProjectConfig;
  readonly llm?: AuthoringLlmFn;
  readonly runId?: string;
  readonly fromArtifactId?: string;
  readonly toArtifactId?: string;
  readonly onProgress?: (run: AuthoringRunRecord) => void;
}

export interface ImpactWorkspaceSummary {
  readonly impactId: string;
  readonly from: ImpactReport["from"];
  readonly to: ImpactReport["to"];
  readonly openCount: { readonly ground: number; readonly weave: number };
  readonly items: ImpactItem[];
  readonly globals: ImpactGlobalNote[];
  readonly method: ImpactReport["method"];
  readonly degraded?: ImpactReport["degraded"];
  readonly partial?: boolean;
  readonly runId?: string;
  readonly groundReportId?: string;
  readonly weaveReportId?: string;
}

interface IndexedEntry {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly body: string;
  readonly snapshot?: string;
}

interface IndexedChapter {
  readonly chapterNumber: number;
  readonly nodeId: string;
  readonly title: string;
  readonly summary: string;
  readonly volumeNumber?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

export function impactContentHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function genreFlipped(before: string, after: string): boolean {
  return (REALITY_GENRE.test(before) && FANTASY_GENRE.test(after))
    || (FANTASY_GENRE.test(before) && REALITY_GENRE.test(after));
}

function verdictRank(verdict: ImpactItem["verdict"]): number {
  return verdict === "affected" ? 2 : 1;
}

function newImpactId(): string {
  return `impact-${randomUUID()}`;
}

function chapterKey(chapterNumber: number): string {
  return `weave:chapter:${chapterNumber}`;
}

function chapterNumberFromKey(key: string): number | undefined {
  const match = /^weave:chapter:(\d+)$/.exec(key);
  return match ? Number(match[1]) : undefined;
}

function upsertCanonWatches(manifest: WorkflowManifest, input: {
  readonly fromArtifactId: string;
  readonly toArtifactId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly impactReportId?: string;
}): DependencyWatch[] {
  const keep = manifest.watches.filter((watch) => watch.sourceKind !== "canon" || watch.acknowledged);
  const pending = manifest.watches.filter((watch) => watch.sourceKind === "canon" && !watch.acknowledged);
  const ground = pending.find((watch) => watch.stage === "ground");
  const weave = pending.find((watch) => watch.stage === "weave");
  const stamp = Date.now();
  const shared = {
    sourceKind: "canon",
    sourceId: input.toArtifactId,
    fromArtifactId: input.fromArtifactId,
    toArtifactId: input.toArtifactId,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    impactReportId: input.impactReportId ?? "pending",
    acknowledged: false,
  } as const;
  return [
    ...keep,
    {
      id: ground?.id ?? `ask-${stamp}`,
      stage: "ground",
      label: ground?.label ?? "正典已采用新版本，设定可能需要核对",
      openCount: ground?.openCount,
      ...shared,
    },
    {
      id: weave?.id ?? `ask-weave-${stamp}`,
      stage: "weave",
      label: weave?.label ?? "正典已采用新版本，大纲可能需要核对",
      openCount: weave?.openCount,
      ...shared,
    },
  ];
}

async function firstAdoptedAskId(root: AuthoringStoreRoot, manifest: WorkflowManifest): Promise<string | undefined> {
  if (manifest.impactBaseline?.ask) return manifest.impactBaseline.ask;
  const artifacts = (await listArtifacts(root, "ask"))
    .filter((item) => item.status === "adopted" || item.artifactId === manifest.adopted.ask)
    .sort((left, right) => left.version - right.version || left.createdAt.localeCompare(right.createdAt));
  return artifacts[0]?.artifactId ?? manifest.adopted.ask;
}

export async function nextCanonImpactState(
  root: AuthoringStoreRoot,
  manifest: WorkflowManifest,
  previousArtifactId: string | undefined,
  next: AuthoringArtifactMeta,
): Promise<{
  watches: DependencyWatch[];
  impactBaseline?: WorkflowManifest["impactBaseline"];
  impactPending: boolean;
}> {
  if (!previousArtifactId) {
    return {
      watches: manifest.watches,
      impactBaseline: manifest.impactBaseline ?? { ask: next.artifactId },
      impactPending: false,
    };
  }
  if (previousArtifactId === next.artifactId) {
    return {
      watches: manifest.watches,
      impactBaseline: manifest.impactBaseline ?? { ask: previousArtifactId },
      impactPending: false,
    };
  }
  const previous = await loadArtifact(root, previousArtifactId);
  const adopted = await loadArtifact(root, next.artifactId);
  const previousCanon = previous ? parseCanon(previous.body) : undefined;
  const nextCanon = adopted ? parseCanon(adopted.body) : undefined;
  const triggerChanges = previousCanon && nextCanon ? canonFieldDiff(previousCanon, nextCanon) : [{ field: "oneLine" }];
  const baselineId = manifest.impactBaseline?.ask ?? previousArtifactId;
  const baseline = baselineId === previousArtifactId ? previous : await loadArtifact(root, baselineId);
  const impactBaseline = manifest.impactBaseline ?? { ask: previousArtifactId };
  if (triggerChanges.length === 0) {
    return { watches: manifest.watches, impactBaseline, impactPending: false };
  }
  return {
    watches: upsertCanonWatches(manifest, {
      fromArtifactId: baselineId,
      toArtifactId: next.artifactId,
      fromVersion: baseline?.meta.version ?? previous?.meta.version ?? 1,
      toVersion: next.version,
    }),
    impactBaseline,
    impactPending: true,
  };
}

function openCounts(items: readonly ImpactItem[]): { ground: number; weave: number } {
  return {
    ground: items.filter((item) => item.stage === "ground" && item.status === "open").length,
    weave: items.filter((item) => item.stage === "weave" && item.status === "open").length,
  };
}

export function impactWorkspaceSummary(report: ImpactReport): ImpactWorkspaceSummary {
  return {
    impactId: report.impactId,
    from: report.from,
    to: report.to,
    openCount: openCounts(report.items),
    items: report.items,
    globals: report.globals,
    method: report.method,
    degraded: report.degraded,
    partial: report.partial,
    runId: report.runId,
    groundReportId: report.groundReportId,
    weaveReportId: report.weaveReportId,
  };
}

function watchLabel(stage: "ground" | "weave", report: ImpactReport, counts: { ground: number; weave: number }): string {
  const span = `正典 v${report.from.version}→v${report.to.version}`;
  if (report.degraded) {
    return `${span} 已采用，影响分辨失败：${report.degraded.reason}，可重算`;
  }
  if (stage === "ground") return `${span}：设定 ${counts.ground} 条需核对`;
  return `${span}：章概要 ${counts.weave} 章需核对`;
}

/** A degraded report with no items is itself the one coarse "open" reminder until the author acks it. */
function degradedUnresolved(report: ImpactReport): boolean {
  return Boolean(report.degraded) && report.items.length === 0;
}

async function syncImpactWatches(
  root: AuthoringStoreRoot,
  report: ImpactReport,
  options?: { readonly acknowledgeDegraded?: boolean },
): Promise<void> {
  const manifest = await loadManifest(root);
  const counts = openCounts(report.items);
  const holdDegraded = degradedUnresolved(report) && !options?.acknowledgeDegraded;
  const watches = upsertCanonWatches(manifest, {
    fromArtifactId: report.from.artifactId,
    toArtifactId: report.to.artifactId,
    fromVersion: report.from.version,
    toVersion: report.to.version,
    impactReportId: report.impactId,
  }).map((watch) => {
    if (watch.sourceKind !== "canon") return watch;
    const count = watch.stage === "ground" ? counts.ground : watch.stage === "weave" ? counts.weave : 0;
    const acknowledged = count === 0 && !holdDegraded;
    return {
      ...watch,
      openCount: count,
      acknowledged,
      label: watch.stage === "ground" || watch.stage === "weave"
        ? watchLabel(watch.stage, report, counts)
        : watch.label,
    };
  });
  const allClosed = counts.ground === 0 && counts.weave === 0 && !holdDegraded;
  await saveManifest(root, {
    ...manifest,
    watches,
    impactBaseline: allClosed
      ? { ask: report.to.artifactId }
      : (manifest.impactBaseline ?? { ask: report.from.artifactId }),
  });
}

async function persistImpactRun(
  root: AuthoringStoreRoot,
  run: Omit<z.input<typeof AuthoringRunRecordSchema>, "updatedAt"> & { updatedAt?: string },
  onProgress?: (run: AuthoringRunRecord) => void,
): Promise<void> {
  await saveRun(root, { ...run, updatedAt: run.updatedAt ?? nowIso() });
  const saved = await loadRun(root, run.runId);
  if (saved) onProgress?.(saved);
}

async function loadEntryBody(root: AuthoringStoreRoot, entry: SettingsCatalogEntry): Promise<string> {
  const artifactId = entry.candidateArtifactId ?? entry.adoptedArtifactId;
  if (artifactId) {
    const loaded = await loadArtifact(root, artifactId);
    if (loaded?.body.trim()) return loaded.body;
  }
  if (!root.bookId || !entry.file) return "";
  try {
    return await readFile(join(root.projectRoot, "books", root.bookId, entry.file), "utf-8");
  } catch {
    return "";
  }
}

async function indexGroundEntries(root: AuthoringStoreRoot): Promise<IndexedEntry[]> {
  const catalog = await loadSettingsCatalog(root);
  const indexed: IndexedEntry[] = [];
  for (const entry of catalog.entries) {
    if (entry.archived) continue;
    indexed.push({
      id: entry.id,
      name: entry.name,
      category: entry.category,
      body: (await loadEntryBody(root, entry)).trim(),
      snapshot: entry.candidateArtifactId ?? entry.adoptedArtifactId,
    });
  }
  return indexed;
}

function indexChapters(outline: string): IndexedChapter[] {
  if (!outline.trim()) return [];
  const tree = parseVolumeMapTree(outline);
  const chapters: IndexedChapter[] = [];
  for (const volume of tree.volumes) {
    for (const chapter of volume.chapters) {
      if (chapter.kind !== "chapter") continue;
      chapters.push({
        chapterNumber: chapter.chapterNumber,
        nodeId: chapter.id,
        title: chapter.title || `第${chapter.chapterNumber}章`,
        summary: chapter.summary || "",
        volumeNumber: volume.volumeNumber ?? undefined,
      });
    }
  }
  for (const chapter of tree.orphanChapters) {
    if (chapter.kind !== "chapter") continue;
    chapters.push({
      chapterNumber: chapter.chapterNumber,
      nodeId: chapter.id,
      title: chapter.title || `第${chapter.chapterNumber}章`,
      summary: chapter.summary || "",
    });
  }
  if (chapters.length > 0) {
    return chapters.sort((left, right) => left.chapterNumber - right.chapterNumber);
  }
  const fallback: IndexedChapter[] = [];
  const heading = /(?:^|\n)##\s*第\s*(\d+)\s*章\s*([^\n]*)\n?([\s\S]*?)(?=\n##\s*第|\n##\s*Volume|$)/g;
  let match = heading.exec(outline);
  while (match) {
    const chapterNumber = Number(match[1]);
    fallback.push({
      chapterNumber,
      nodeId: `chapter:${chapterNumber}`,
      title: (match[2] ?? "").trim() || `第${chapterNumber}章`,
      summary: (match[3] ?? "").trim(),
    });
    match = heading.exec(outline);
  }
  return fallback.sort((left, right) => left.chapterNumber - right.chapterNumber);
}

function mergeItems(items: ImpactItem[]): ImpactItem[] {
  const merged = new Map<string, ImpactItem>();
  for (const item of items) {
    const current = merged.get(item.key);
    if (!current) {
      merged.set(item.key, item);
      continue;
    }
    const fields = [...new Set([...current.fields, ...item.fields])];
    const reason = current.reason.includes(item.reason)
      ? current.reason
      : `${current.reason}；${item.reason}`;
    merged.set(item.key, {
      ...current,
      fields,
      reason,
      hint: [current.hint, item.hint].filter(Boolean).join("；") || undefined,
      verdict: verdictRank(item.verdict) > verdictRank(current.verdict) ? item.verdict : current.verdict,
      method: current.method === item.method ? current.method : current.method === "rule" ? item.method : "llm",
    });
  }
  return [...merged.values()];
}

function mentionedEntries(entries: readonly IndexedEntry[], changes: readonly CanonFieldChange[]): IndexedEntry[] {
  return entries.filter((entry) => changes.some((change) => (
    nameHitsNeedle({ name: entry.name, body: entry.body }, change.before)
    || nameHitsNeedle({ name: entry.name, body: entry.body }, change.after)
  )));
}

function newTokensFromChanges(changes: readonly CanonFieldChange[]): string[] {
  const before = new Set(changes.flatMap((change) => significantTokens(change.before)));
  return [...new Set(changes.flatMap((change) => significantTokens(change.after)).filter((token) => !before.has(token)))];
}

function hardRuleItems(
  changes: readonly CanonFieldChange[],
  chapters: readonly IndexedChapter[],
): { items: ImpactItem[]; globals: ImpactGlobalNote[] } {
  const items: ImpactItem[] = [];
  const globals: ImpactGlobalNote[] = [];
  for (const change of changes) {
    if (change.field === "voice" || change.field === "chapterWordCount") {
      globals.push({
        field: change.field,
        note: change.field === "voice"
          ? `叙事视角与文风由「${clip(change.before, 40)}」改为「${clip(change.after, 40)}」，影响落笔文风，不需逐条改设定`
          : `每章字数由 ${change.before || "未设"} 改为 ${change.after}，落笔时生效`,
      });
      continue;
    }
    if (change.field === "title") {
      globals.push({ field: "title", note: `书名由「${change.before}」改为「${change.after}」` });
      continue;
    }
    if (change.field === "genre") {
      globals.push({ field: "genre", note: `类型由「${change.before}」改为「${change.after}」` });
      if (genreFlipped(change.before, change.after)) {
        items.push({
          key: "ground:catalog",
          stage: "ground",
          targetId: "catalog",
          label: "设定目录",
          verdict: "maybe",
          fields: ["genre"],
          reason: `题材由「${change.before}」改为「${change.after}」，设定目录可能需要重新拟定`,
          hint: "重新拟定设定目录后再按新题材生成条目",
          method: "rule",
          snapshot: "catalog",
          status: "open",
        });
      }
      continue;
    }
    if (change.field === "targetChapters") {
      const nextTarget = Number(change.after);
      items.push({
        key: "weave:structure",
        stage: "weave",
        targetId: "structure",
        label: "分卷结构",
        verdict: "affected",
        fields: ["targetChapters"],
        reason: `全书篇幅由 ${change.before || "未设"} 改为 ${change.after} 章，分卷必须覆盖到第 ${change.after} 章（validateVolumePlan 会拒绝旧结构）`,
        hint: "重新规划分卷后再采用",
        method: "rule",
        snapshot: "structure",
        status: "open",
      });
      if (Number.isInteger(nextTarget) && nextTarget > 0) {
        for (const chapter of chapters.filter((item) => item.chapterNumber > nextTarget)) {
          items.push({
            key: chapterKey(chapter.chapterNumber),
            stage: "weave",
            targetId: chapter.nodeId,
            label: `第 ${chapter.chapterNumber} 章 ${chapter.title}`.trim(),
            verdict: "affected",
            fields: ["targetChapters"],
            reason: `目标章数改为 ${nextTarget}，本章（第 ${chapter.chapterNumber} 章）已超出新篇幅`,
            hint: "从规划中移除或重排本章",
            method: "rule",
            snapshot: impactContentHash(`${chapter.title}\n${chapter.summary}`),
            status: "open",
          });
        }
      }
    }
  }
  return { items, globals };
}

function heuristicGroundItems(
  entries: readonly IndexedEntry[],
  changes: readonly CanonFieldChange[],
  tokens: readonly string[],
): ImpactItem[] {
  const items: ImpactItem[] = [];
  const boundariesChanged = changes.some((change) => change.field === "boundaries");
  for (const entry of entries) {
    const nameHit = changes.find((change) => (
      nameHitsNeedle({ name: entry.name, body: entry.body }, change.before)
      || nameHitsNeedle({ name: entry.name, body: entry.body }, change.after)
    ));
    const tokenHit = tokens.find((token) => token.length >= 4 && entry.body.includes(token));
    const constraintHit = boundariesChanged && isConstraintSetting(entry);
    if (!nameHit && !tokenHit && !constraintHit) continue;
    const field = nameHit?.field ?? (constraintHit ? "boundaries" : changes[0]?.field ?? "protagonist");
    const reason = nameHit
      ? `启发式：『${nameHit.label}』改动提到『${entry.name}』，本条名称命中`
      : tokenHit
        ? `启发式：本条正文含新增词『${tokenHit}』`
        : `启发式：『故事边界』改动，本条属约束类设定`;
    items.push({
      key: `ground:${entry.id}`,
      stage: "ground",
      targetId: entry.id,
      label: entry.name,
      verdict: "maybe",
      fields: [field],
      reason,
      method: "heuristic",
      snapshot: entry.snapshot,
      status: "open",
    });
  }
  return items;
}

function heuristicWeaveItems(
  chapters: readonly IndexedChapter[],
  mentioned: readonly IndexedEntry[],
  changes: readonly CanonFieldChange[],
  tokens: readonly string[],
): ImpactItem[] {
  const items: ImpactItem[] = [];
  for (const chapter of chapters) {
    const haystack = `${chapter.title}\n${chapter.summary}`;
    const named = mentioned.find((entry) => (
      nameHitsNeedle({ name: entry.name, body: entry.body }, haystack)
    ));
    const tokenHit = tokens.find((token) => token.length >= 4 && chapter.summary.includes(token));
    if (!named && !tokenHit) continue;
    const field = named
      ? (changes.find((change) => nameHitsNeedle({ name: named.name, body: named.body }, change.after))?.field ?? changes[0]?.field)
      : changes.find((change) => tokenHit && change.after.includes(tokenHit))?.field ?? changes[0]?.field;
    const label = CANON_IMPACT_FIELDS.find((item) => item.field === field)?.label ?? field ?? "正典";
    const reason = named
      ? `启发式：第 ${chapter.chapterNumber} 章概要含『${named.name}』，该词出现在改动后的『${label}』`
      : `启发式：第 ${chapter.chapterNumber} 章概要含『${tokenHit}』，该词出现在改动后的『${label}』`;
    items.push({
      key: chapterKey(chapter.chapterNumber),
      stage: "weave",
      targetId: chapter.nodeId,
      label: `第 ${chapter.chapterNumber} 章 ${chapter.title}`.trim(),
      verdict: "maybe",
      fields: field ? [field] : [],
      reason,
      method: "heuristic",
      snapshot: impactContentHash(`${chapter.title}\n${chapter.summary}`),
      status: "open",
    });
  }
  return items;
}

function chunkBySize<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function groundBatches(entries: readonly IndexedEntry[]): IndexedEntry[][] {
  const byCategory = new Map<string, IndexedEntry[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }
  const batches: IndexedEntry[][] = [];
  for (const group of byCategory.values()) {
    batches.push(...chunkBySize(group, GROUND_BATCH));
  }
  return batches;
}

function weaveBatches(chapters: readonly IndexedChapter[]): IndexedChapter[][] {
  if (chapters.length <= WEAVE_BATCH) return chapters.length ? [ [...chapters] ] : [];
  if (chapters.length <= WEAVE_VOLUME_THRESHOLD) return chunkBySize(chapters, WEAVE_BATCH);
  const byVolume = new Map<number | "orphan", IndexedChapter[]>();
  for (const chapter of chapters) {
    const key = chapter.volumeNumber ?? "orphan";
    const list = byVolume.get(key) ?? [];
    list.push(chapter);
    byVolume.set(key, list);
  }
  const batches: IndexedChapter[][] = [];
  for (const group of byVolume.values()) {
    batches.push(...chunkBySize(group, WEAVE_BATCH));
  }
  return batches;
}

function unchangedFieldLabels(changes: readonly CanonFieldChange[]): string[] {
  const changed = new Set(changes.map((change) => change.field));
  return CANON_IMPACT_FIELDS.filter((field) => !changed.has(field.field)).map((field) => field.label);
}

function triagePrompt(input: {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changes: readonly CanonFieldChange[];
  readonly names: readonly string[];
  readonly indexTitle: string;
  readonly indexLines: readonly string[];
}): string {
  return [
    `【正典改动 v${input.fromVersion} → v${input.toVersion}】`,
    ...input.changes.map((change) => `- ${change.label}：\n  旧：${clip(change.before, CLIP_CHANGE) || "（空）"}\n  新：${clip(change.after, CLIP_CHANGE) || "（空）"}`),
    unchangedFieldLabels(input.changes).length
      ? `未改动字段：${unchangedFieldLabels(input.changes).join("、")}`
      : "",
    input.names.length ? `【可能相关的名字】${input.names.join("、")}` : "",
    `【${input.indexTitle}】`,
    ...input.indexLines,
    "",
    "只输出 JSON：{ items: [{ target, verdict, fields, reason, hint }], globals: [{ field, note }] }。",
    "硬规则：",
    "- 只列受影响的项；不确定给 maybe；不要为了保险把所有条目列出。",
    "- reason 必须同时点到「哪个正典字段怎么改了」和「这一条 / 这一章的哪一点与之冲突或过时」；不超过 80 字。",
    "- target 必须是索引里给出的 id / 章号；不在索引里的不要输出。",
    "- 文风、篇幅、书名类改动放 globals，不映射到条目。",
  ].filter(Boolean).join("\n");
}

function parseTriageJson(raw: string): { items: Array<Record<string, unknown>>; globals: Array<Record<string, unknown>> } | undefined {
  try {
    const json = extractJsonObject(raw);
    if (!Array.isArray(json.items)) return undefined;
    return {
      items: json.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object"),
      globals: Array.isArray(json.globals)
        ? json.globals.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        : [],
    };
  } catch {
    return undefined;
  }
}

function normalizeTarget(raw: string): string {
  return raw.replace(/^(ground:|weave:chapter:|chapter:)/, "").trim();
}

function attachSnapshots(
  items: ImpactItem[],
  entries: readonly IndexedEntry[],
  chapters: readonly IndexedChapter[],
): ImpactItem[] {
  return items.map((item) => {
    if (item.snapshot) return item;
    if (item.stage === "ground") {
      const entry = entries.find((row) => row.id === item.targetId);
      return { ...item, snapshot: entry?.snapshot };
    }
    const chapterNumber = chapterNumberFromKey(item.key);
    const chapter = chapters.find((row) => row.chapterNumber === chapterNumber);
    if (!chapter) return item;
    return { ...item, snapshot: impactContentHash(`${chapter.title}\n${chapter.summary}`) };
  });
}

function migrateClosedStatuses(
  previous: ImpactReport | undefined,
  nextItems: ImpactItem[],
  oldTo: ReturnType<typeof parseCanon> | undefined,
  newTo: ReturnType<typeof parseCanon>,
): ImpactItem[] {
  if (!previous || !oldTo) return nextItems;
  const drift = new Set<string>(canonFieldDiff(oldTo, newTo).map((change) => change.field));
  return nextItems.map((item) => {
    const prior = previous.items.find((row) => row.key === item.key);
    if (!prior || prior.status === "open") return item;
    if (prior.fields.some((field) => drift.has(field))) return item;
    return {
      ...item,
      status: prior.status,
      resolvedAt: prior.resolvedAt,
      resolvedArtifactId: prior.resolvedArtifactId,
    };
  });
}

function evidenceFor(item: ImpactItem, changes: readonly { field: string; label: string; before: string; after: string }[]): string {
  const matched = changes.filter((change) => item.fields.includes(change.field));
  const rows = (matched.length ? matched : changes).slice(0, 2);
  return rows
    .map((change) => `${change.label}：${clip(change.before, 80)} → ${clip(change.after, 80)}`)
    .join("；");
}

function reviewIssues(items: readonly ImpactItem[], changes: readonly { field: string; label: string; before: string; after: string }[]): AuthoringReviewReport["issues"] {
  return items.map((item, index) => {
    const chapterNumber = chapterNumberFromKey(item.key);
    const target = item.key === "ground:catalog"
      ? "catalog"
      : item.key === "weave:structure"
        ? "structure"
        : item.stage === "weave" && chapterNumber
          ? String(chapterNumber)
          : item.targetId;
    return {
      issueId: `impact-${item.key}-${index + 1}`,
      title: item.label,
      severity: item.verdict === "affected" ? "priority" as const : "improve" as const,
      target,
      evidence: evidenceFor(item, changes),
      sources: item.fields,
      reason: item.reason,
      suggestion: item.hint,
    };
  });
}

async function writeStageReports(input: {
  readonly root: AuthoringStoreRoot;
  readonly report: ImpactReport;
  readonly items: readonly ImpactItem[];
  readonly model: string;
  readonly runId?: string;
}): Promise<{ groundReportId?: string; weaveReportId?: string }> {
  const manifest = await loadManifest(input.root);
  const catalog = await loadSettingsCatalog(input.root);
  const groundItems = input.items.filter((item) => item.stage === "ground");
  const weaveItems = input.items.filter((item) => item.stage === "weave");
  const coverage = `正典 v${input.report.from.version}→v${input.report.to.version} 影响分辨`;
  const inputRefs = [
    { kind: "canon", id: input.report.from.artifactId, version: input.report.from.version },
    { kind: "canon", id: input.report.to.artifactId, version: input.report.to.version },
  ];
  let groundReportId: string | undefined;
  let weaveReportId: string | undefined;
  if (groundItems.length) {
    const targetRefs = [...new Set(groundItems.flatMap((item) => {
      if (item.key === "ground:catalog") return ["catalog"];
      const entry = catalog.entries.find((row) => row.id === item.targetId);
      const artifactId = entry?.candidateArtifactId ?? entry?.adoptedArtifactId;
      return artifactId ? [artifactId] : [];
    }))];
    if (targetRefs.length === 0) targetRefs.push(input.report.to.artifactId);
    const report: AuthoringReviewReport = {
      reportId: randomUUID(),
      stage: "ground",
      targetRefs,
      coverage,
      inputRefs,
      actualReviewModel: input.model,
      createdAt: nowIso(),
      summary: input.report.degraded
        ? `影响分辨降级：${input.report.degraded.reason}`
        : `设定 ${groundItems.length} 条需对照新正典核对。`,
      issues: reviewIssues(groundItems, input.report.changes),
      stale: false,
      incomplete: false,
      runId: input.runId,
    };
    await saveReport(input.root, report);
    groundReportId = report.reportId;
  }
  if (weaveItems.length) {
    const targetRefs = [manifest.candidates.weave, manifest.adopted.weave].filter((id): id is string => Boolean(id));
    if (targetRefs.length === 0) targetRefs.push("weave:structure");
    const report: AuthoringReviewReport = {
      reportId: randomUUID(),
      stage: "weave",
      targetRefs,
      coverage,
      inputRefs,
      actualReviewModel: input.model,
      createdAt: nowIso(),
      summary: input.report.degraded
        ? `影响分辨降级：${input.report.degraded.reason}`
        : `章概要 ${weaveItems.filter((item) => item.key !== "weave:structure").length} 章需对照新正典核对。`,
      issues: reviewIssues(weaveItems, input.report.changes),
      stale: false,
      incomplete: false,
      runId: input.runId,
    };
    await saveReport(input.root, report);
    weaveReportId = report.reportId;
  }
  return { groundReportId, weaveReportId };
}

function reportMethod(items: readonly ImpactItem[]): ImpactReport["method"] {
  const methods = new Set(items.map((item) => item.method));
  const hasLlm = methods.has("llm");
  const hasHeuristic = methods.has("heuristic");
  if (hasLlm && hasHeuristic) return "mixed";
  if (hasLlm) return "llm";
  return "heuristic";
}

function needsMapping(changes: readonly CanonFieldChange[]): boolean {
  return changes.some((change) => MAPPABLE_FIELDS.has(change.field));
}

export async function triageCanonImpact(input: ImpactRuntime): Promise<{
  impactId?: string;
  unchanged?: boolean;
  report?: ImpactReport;
}> {
  const manifest = await loadManifest(input.root);
  const toId = input.toArtifactId ?? manifest.adopted.ask;
  if (!toId) throw new Error("还没有已采用的正典，无法分辨影响。");
  const fromId = input.fromArtifactId ?? await firstAdoptedAskId(input.root, manifest);
  if (!fromId) throw new Error("找不到影响基线正典。");
  const fromArt = await loadArtifact(input.root, fromId);
  const toArt = await loadArtifact(input.root, toId);
  if (!fromArt || !toArt) throw new Error("找不到用于影响分辨的正典版本。");
  const fromCanon = parseCanon(fromArt.body);
  const toCanon = parseCanon(toArt.body);
  const changes = canonFieldDiff(fromCanon, toCanon);
  const runId = input.runId ?? newRunId();
  const createdAt = (await loadRun(input.root, runId))?.createdAt ?? nowIso();
  const scope = `impact:${fromId}..${toId}`;
  const baseRun = {
    runId,
    stage: "ask" as const,
    operation: "review" as const,
    roleId: "ask.review" as const,
    bookId: input.root.bookId,
    draftId: input.root.draftId,
    scope,
    modelSnapshot: {},
    producedArtifactIds: [] as string[],
    createdAt,
  };
  if (changes.length === 0) {
    await persistImpactRun(input.root, {
      ...baseRun,
      status: "completed",
      progressDone: 1,
      progressTotal: 1,
      progressLabel: "正典内容未变，无需分辨影响",
    }, input.onProgress);
    return { unchanged: true };
  }

  const previous = await loadCurrentImpact(input.root);
  const outline = input.root.bookId
    ? await readFile(join(input.root.projectRoot, "books", input.root.bookId, "story", "outline", "volume_map.md"), "utf-8").catch(() => "")
    : "";
  const entries = await indexGroundEntries(input.root);
  const chapters = indexChapters(outline);
  const mentioned = mentionedEntries(entries, changes);
  const newTokens = newTokensFromChanges(changes);
  const names = [...new Set([
    ...mentioned.map((entry) => entry.name),
    ...mentioned.flatMap((entry) => settingAliases(entry)),
    ...newTokens,
  ])].filter((name) => name.length >= 2);
  const rules = hardRuleItems(changes, chapters);
  const groundGroups = needsMapping(changes) ? groundBatches(entries) : [];
  const weaveGroups = needsMapping(changes) ? weaveBatches(chapters) : [];
  const batches: Array<{ kind: "ground" | "weave"; prompt: string; allowed: Set<string>; fallback: () => ImpactItem[] }> = [];
  groundGroups.forEach((group, index) => {
    batches.push({
      kind: "ground",
      allowed: new Set(group.map((entry) => entry.id)),
      fallback: () => heuristicGroundItems(group, changes, newTokens),
      prompt: triagePrompt({
        fromVersion: fromArt.meta.version,
        toVersion: toArt.meta.version,
        changes,
        names,
        indexTitle: `设定目录索引 · 第 ${index + 1}/${groundGroups.length} 批（${group.length} 条）`,
        indexLines: group.map((entry) => `- id: ${entry.id} | ${entry.category} / ${entry.name} | 首 ${CLIP_ENTRY} 字：${clip(entry.body, CLIP_ENTRY) || "（空）"}`),
      }),
    });
  });
  weaveGroups.forEach((group, index) => {
    batches.push({
      kind: "weave",
      allowed: new Set(group.map((chapter) => String(chapter.chapterNumber))),
      fallback: () => heuristicWeaveItems(group, mentioned, changes, newTokens),
      prompt: triagePrompt({
        fromVersion: fromArt.meta.version,
        toVersion: toArt.meta.version,
        changes,
        names,
        indexTitle: `章概要索引 · 第 ${index + 1}/${weaveGroups.length} 批（${group.length} 章）`,
        indexLines: group.map((chapter) => `- 第 ${chapter.chapterNumber} 章 ${chapter.title} | 概要（≤${CLIP_SUMMARY} 字）：${clip(chapter.summary, CLIP_SUMMARY) || "（空）"}`),
      }),
    });
  });

  const resolved = await resolveAuthoringRole({
    roleId: "ask.review",
    baseLlm: input.project.llm,
    roles: fillMissingAuthoringRoles(input.project),
    apiKeys: await loadRoleApiKeys(input.root.projectRoot).catch(() => undefined),
  });
  const collected: ImpactItem[] = [...rules.items];
  const globals: ImpactGlobalNote[] = [...rules.globals];
  const unmapped: Array<{ target: string; reason: string }> = [];
  let usedLlm = false;
  let usedHeuristic = false;
  let partial = false;
  let cancelled = false;
  let llmError: string | undefined;

  await persistImpactRun(input.root, {
    ...baseRun,
    status: "running",
    progressDone: 0,
    progressTotal: Math.max(batches.length, 1),
    progressLabel: batches.length ? `正在分辨正典改动的影响 0/${batches.length}` : "正在应用正典改动硬规则",
    modelSnapshot: resolved.snapshot,
  }, input.onProgress);

  try {
    for (const [index, batch] of batches.entries()) {
      if (await loadRunControl(input.root, runId) === "cancel") {
        cancelled = true;
        partial = true;
        break;
      }
      let parsed = undefined as ReturnType<typeof parseTriageJson>;
      try {
        const raw = await completeRole(resolved, batch.prompt, input.llm);
        parsed = parseTriageJson(raw);
      } catch (error) {
        llmError = error instanceof Error ? error.message : String(error);
      }
      if (!parsed) {
        usedHeuristic = true;
        collected.push(...batch.fallback());
      } else {
        usedLlm = true;
        const accepted: ImpactItem[] = [];
        for (const raw of parsed.items) {
          const target = normalizeTarget(asString(raw.target));
          if (!target) continue;
          if (!batch.allowed.has(target)) {
            unmapped.push({ target, reason: "target 不在本批索引中" });
            continue;
          }
          const verdict = asString(raw.verdict) === "affected" ? "affected" : asString(raw.verdict) === "maybe" ? "maybe" : undefined;
          if (!verdict) {
            unmapped.push({ target, reason: "verdict 无效" });
            continue;
          }
          const fields = asStringArray(raw.fields).filter((field) => changes.some((change) => change.field === field));
          const reason = clip(asString(raw.reason) || "正典改动可能影响此项", 80);
          if (batch.kind === "ground") {
            const entry = entries.find((row) => row.id === target);
            if (!entry) continue;
            accepted.push({
              key: `ground:${entry.id}`,
              stage: "ground",
              targetId: entry.id,
              label: entry.name,
              verdict,
              fields,
              reason,
              hint: asString(raw.hint) || undefined,
              method: "llm",
              snapshot: entry.snapshot,
              status: "open",
            });
          } else {
            const chapter = chapters.find((row) => String(row.chapterNumber) === target);
            if (!chapter) continue;
            accepted.push({
              key: chapterKey(chapter.chapterNumber),
              stage: "weave",
              targetId: chapter.nodeId,
              label: `第 ${chapter.chapterNumber} 章 ${chapter.title}`.trim(),
              verdict,
              fields,
              reason,
              hint: asString(raw.hint) || undefined,
              method: "llm",
              snapshot: impactContentHash(`${chapter.title}\n${chapter.summary}`),
              status: "open",
            });
          }
        }
        const ratio = batch.allowed.size ? accepted.length / batch.allowed.size : 0;
        if (ratio > 0.6) {
          globals.push({
            field: "scope",
            note: "改动可能是全局性的（如主角改名）；建议用「按影响重新生成所选」而不是逐条核对",
          });
        }
        collected.push(...accepted);
        for (const raw of parsed.globals) {
          const field = asString(raw.field);
          const note = asString(raw.note);
          if (field && note && !globals.some((item) => item.field === field && item.note === note)) {
            globals.push({ field, note });
          }
        }
      }
      await persistImpactRun(input.root, {
        ...baseRun,
        status: "running",
        progressDone: index + 1,
        progressTotal: batches.length,
        progressLabel: `正在分辨正典改动的影响 ${index + 1}/${batches.length}`,
        modelSnapshot: resolved.snapshot,
      }, input.onProgress);
    }
  } catch (error) {
    llmError = error instanceof Error ? error.message : String(error);
  }

  let items = attachSnapshots(mergeItems(collected), entries, chapters);
  items = migrateClosedStatuses(previous, items, previous ? parseCanon((await loadArtifact(input.root, previous.to.artifactId))?.body ?? "") : undefined, toCanon);

  const mappable = needsMapping(changes);
  const degraded = items.length === 0 && mappable
    ? { reason: llmError ? clip(llmError, 80) : usedHeuristic || !usedLlm ? "未命中可核对的设定或章概要" : "模型未标出受影响项" }
    : undefined;

  const impactId = newImpactId();
  const persistedChanges = changes.map((change) => ({
    field: change.field,
    label: change.label,
    before: clip(change.before, CLIP_CHANGE),
    after: clip(change.after, CLIP_CHANGE),
  }));
  let report = ImpactReportSchema.parse({
    impactId,
    createdAt: nowIso(),
    runId,
    from: { artifactId: fromArt.meta.artifactId, version: fromArt.meta.version },
    to: { artifactId: toArt.meta.artifactId, version: toArt.meta.version },
    changes: persistedChanges,
    globals,
    items: items.map((item) => ImpactItemSchema.parse(item)),
    unmapped,
    method: reportMethod(items),
    degraded,
    partial: partial || undefined,
  });
  const stageReports = await writeStageReports({
    root: input.root,
    report,
    items: report.items,
    model: resolved.modelId,
    runId,
  });
  report = await saveImpactReport(input.root, {
    ...report,
    groundReportId: stageReports.groundReportId,
    weaveReportId: stageReports.weaveReportId,
  });
  if (previous && previous.impactId !== report.impactId) {
    await saveImpactReport(input.root, { ...previous, supersededBy: report.impactId });
  }
  await syncImpactWatches(input.root, report);
  await persistImpactRun(input.root, {
    ...baseRun,
    status: cancelled ? "cancelled" : partial ? "partial" : "completed",
    progressDone: batches.length,
    progressTotal: Math.max(batches.length, 1),
    progressLabel: cancelled
      ? "已放弃这次影响分辨"
      : degraded
        ? `影响分辨降级：${degraded.reason}`
        : "影响分辨完成",
    reportId: report.impactId,
    modelSnapshot: resolved.snapshot,
  }, input.onProgress);
  if (cancelled) throw new AuthoringRunCancelledError();
  return { impactId: report.impactId, report };
}

async function closeMatchingItems(
  report: ImpactReport,
  mutate: (item: ImpactItem) => ImpactItem | undefined,
): Promise<ImpactReport> {
  const items = report.items.map((item) => mutate(item) ?? item);
  return ImpactReportSchema.parse({ ...report, items });
}

export async function closeImpactItems(
  root: AuthoringStoreRoot,
  input: { readonly ground?: readonly string[]; readonly weaveBody?: string; readonly weaveArtifactId?: string },
): Promise<ImpactReport | undefined> {
  const current = await loadCurrentImpact(root);
  if (!current) return undefined;
  const now = nowIso();
  const catalog = input.ground?.length ? await loadSettingsCatalog(root) : undefined;
  const chapters = input.weaveBody != null ? indexChapters(input.weaveBody) : [];
  let next = current;
  if (input.ground?.length && catalog) {
    const adopted = new Set(input.ground);
    next = await closeMatchingItems(next, (item) => {
      if (item.stage !== "ground" || item.status !== "open") return item;
      const entryId = item.key === "ground:catalog" ? undefined : item.targetId;
      if (!entryId || !adopted.has(entryId)) return item;
      const entry = catalog.entries.find((row) => row.id === entryId);
      const artifactId = entry?.adoptedArtifactId;
      if (!artifactId) return item;
      if (item.snapshot && item.snapshot === artifactId) return item;
      return {
        ...item,
        status: "regenerated",
        resolvedAt: now,
        resolvedArtifactId: artifactId,
      };
    });
  }
  if (input.weaveBody != null) {
    next = await closeMatchingItems(next, (item) => {
      if (item.stage !== "weave" || item.status !== "open") return item;
      if (item.key === "weave:structure") {
        return {
          ...item,
          status: "regenerated",
          resolvedAt: now,
          resolvedArtifactId: input.weaveArtifactId,
        };
      }
      const chapterNumber = chapterNumberFromKey(item.key);
      if (!chapterNumber) return item;
      const chapter = chapters.find((row) => row.chapterNumber === chapterNumber);
      if (!chapter) {
        return {
          ...item,
          status: "regenerated",
          resolvedAt: now,
          resolvedArtifactId: input.weaveArtifactId,
        };
      }
      const snapshot = impactContentHash(`${chapter.title}\n${chapter.summary}`);
      if (item.snapshot && item.snapshot === snapshot) return item;
      return {
        ...item,
        status: "regenerated",
        resolvedAt: now,
        resolvedArtifactId: input.weaveArtifactId,
      };
    });
  }
  if (next === current) {
    const same = next.items.every((item, index) => item === current.items[index]);
    if (same) return current;
  }
  const saved = await saveImpactReport(root, next);
  await syncImpactWatches(root, saved);
  return saved;
}

export async function resolveImpactItems(
  root: AuthoringStoreRoot,
  input: { readonly keys?: readonly string[]; readonly as: "reviewed" | "dismissed" },
): Promise<ImpactReport | undefined> {
  const current = await loadCurrentImpact(root);
  const now = nowIso();
  if (!current) {
    const manifest = await loadManifest(root);
    const watches = manifest.watches.map((watch) => (
      watch.sourceKind === "canon" && !watch.acknowledged
        ? { ...watch, acknowledged: true, openCount: 0 }
        : watch
    ));
    await saveManifest(root, {
      ...manifest,
      watches,
      impactBaseline: { ask: manifest.adopted.ask ?? manifest.impactBaseline?.ask },
    });
    return undefined;
  }
  const keys = new Set(input.keys ?? current.items.filter((item) => item.status === "open").map((item) => item.key));
  const next = await closeMatchingItems(current, (item) => {
    if (item.status !== "open" || !keys.has(item.key)) return item;
    return { ...item, status: input.as, resolvedAt: now };
  });
  const saved = await saveImpactReport(root, next);
  await syncImpactWatches(root, saved, { acknowledgeDegraded: true });
  return saved;
}
