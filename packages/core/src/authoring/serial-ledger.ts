/**
 * Rolling memory for 落笔: character status, open hooks, recent summaries.
 * Old books keep story/state/hooks.json and chapter_summaries.json; this file
 * only records chapters adopted through the new path.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ChapterSummariesStateSchema,
  HooksStateSchema,
} from "../models/runtime-state.js";
import { asNumber, asString, asStringArray, extractJsonObject } from "./json.js";
import { loadManifest, type AuthoringStoreRoot } from "./store.js";

const SUMMARY_KEEP = 5;
const SUMMARY_CLIP = 400;

const LedgerHookSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  targetChapter: z.number().int().min(1).optional(),
  note: z.string().default(""),
});

const LedgerChapterSchema = z.object({
  chapter: z.number().int().min(1),
  artifactId: z.string().min(1),
  title: z.string().default(""),
  summary: z.string().default(""),
  characters: z.array(z.object({
    name: z.string().min(1),
    status: z.string().default(""),
  })).default([]),
  openHooks: z.array(LedgerHookSchema).default([]),
  advanceHookIds: z.array(z.string()).default([]),
  resolveHookIds: z.array(z.string()).default([]),
});

export const SerialLedgerSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().default(""),
  chapters: z.array(LedgerChapterSchema).default([]),
});

export type SerialLedger = z.infer<typeof SerialLedgerSchema>;
export type LedgerChapter = z.infer<typeof LedgerChapterSchema>;

export interface SettleNote {
  readonly summary: string;
  readonly characters: ReadonlyArray<{ readonly name: string; readonly status: string }>;
  readonly openHooks: ReadonlyArray<{ readonly id: string; readonly label: string; readonly targetChapter?: number; readonly note: string }>;
  readonly advanceHookIds: readonly string[];
  readonly resolveHookIds: readonly string[];
}

export interface FoldedHook {
  readonly id: string;
  readonly label: string;
  readonly originChapter: number;
  readonly targetChapter?: number;
  readonly status: "open" | "progressing" | "resolved";
  readonly note: string;
}

export interface FoldedMemory {
  readonly characters: ReadonlyArray<{ readonly name: string; readonly status: string; readonly chapter: number }>;
  readonly hooks: readonly FoldedHook[];
  readonly summaries: ReadonlyArray<{ readonly chapter: number; readonly title: string; readonly summary: string }>;
}

export interface AuthoringOpenHook {
  readonly hookId: string;
  readonly label: string;
  readonly startChapter: number;
  readonly type: string;
  readonly status: string;
  readonly lastAdvancedChapter: number;
  readonly expectedPayoff: string;
  readonly notes: string;
  readonly targetChapter?: number;
}

export function emptySerialLedger(): SerialLedger {
  return { version: 1, updatedAt: new Date().toISOString(), chapters: [] };
}

export function countChapterChars(body: string): number {
  return body.replace(/\s+/g, "").length;
}

export function chapterLengthNote(actual: number, target: number | undefined): string | undefined {
  if (!target || target < 100) return undefined;
  if (Math.abs(actual - target) / target <= 0.3) return undefined;
  return `这一章大约 ${actual} 字，和目标 ${target} 字差得比较多，可以再改一改。`;
}

export function parseSettleNote(text: string): SettleNote {
  const fallback = text.trim();
  try {
    const raw = extractJsonObject(text);
    const characters = Array.isArray(raw.characters)
      ? raw.characters.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as { name?: unknown; status?: unknown };
        const name = asString(record.name);
        if (!name) return [];
        return [{ name, status: asString(record.status) }];
      })
      : [];
    const openHooks = Array.isArray(raw.openHooks)
      ? raw.openHooks.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as { id?: unknown; label?: unknown; targetChapter?: unknown; note?: unknown };
        const label = asString(record.label) || asString(record.id);
        if (!label) return [];
        const id = asString(record.id) || label;
        const targetChapter = asNumber(record.targetChapter);
        return [{
          id,
          label,
          note: asString(record.note),
          ...(targetChapter && targetChapter >= 1 ? { targetChapter: Math.trunc(targetChapter) } : {}),
        }];
      })
      : [];
    return {
      summary: asString(raw.summary) || fallback,
      characters,
      openHooks,
      advanceHookIds: asStringArray(raw.advanceHooks),
      resolveHookIds: asStringArray(raw.resolveHooks),
    };
  } catch {
    return {
      summary: fallback,
      characters: [],
      openHooks: [],
      advanceHookIds: [],
      resolveHookIds: [],
    };
  }
}

export function ledgerPath(bookDir: string): string {
  return join(bookDir, "story", "state", "serial-ledger.json");
}

export class SerialLedgerCorruptError extends Error {
  override readonly name = "SerialLedgerCorruptError";
  readonly path: string;
  constructor(path: string, cause?: unknown) {
    super(
      `连载账本损坏，已保留原文件：${path}。请从 story/snapshots 里对应章的状态快照恢复后再整理。`,
    );
    this.path = path;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export async function loadSerialLedger(bookDir: string): Promise<SerialLedger | undefined> {
  const path = ledgerPath(bookDir);
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SerialLedgerCorruptError(path, error);
  }
  try {
    const parsed = SerialLedgerSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) throw new SerialLedgerCorruptError(path, parsed.error);
    return parsed.data;
  } catch (error) {
    if (error instanceof SerialLedgerCorruptError) throw error;
    throw new SerialLedgerCorruptError(path, error);
  }
}

export function applyChapterMemory(ledger: SerialLedger | undefined, chapter: LedgerChapter): SerialLedger {
  const base = ledger ?? emptySerialLedger();
  const chapters = base.chapters.filter((item) => item.chapter !== chapter.chapter);
  chapters.push(chapter);
  chapters.sort((a, b) => a.chapter - b.chapter);
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    chapters,
  };
}

export function chapterMemoryFromSettle(input: {
  readonly chapter: number;
  readonly artifactId: string;
  readonly title: string;
  readonly note: SettleNote;
}): LedgerChapter {
  return {
    chapter: input.chapter,
    artifactId: input.artifactId,
    title: input.title,
    summary: input.note.summary,
    characters: input.note.characters.map((item) => ({ name: item.name, status: item.status })),
    openHooks: input.note.openHooks.map((hook) => ({
      id: hook.id,
      label: hook.label,
      note: hook.note,
      ...(hook.targetChapter ? { targetChapter: hook.targetChapter } : {}),
    })),
    advanceHookIds: [...input.note.advanceHookIds],
    resolveHookIds: [...input.note.resolveHookIds],
  };
}

function adoptedArtifactId(
  adopted: Readonly<Record<string, string>> | undefined,
  chapter: number,
): string | undefined {
  return adopted?.[String(chapter)];
}

export function foldSerialLedger(
  ledger: SerialLedger | undefined,
  adoptedWrite: Readonly<Record<string, string>> | undefined,
  beforeChapter?: number,
): FoldedMemory {
  const characters = new Map<string, { name: string; status: string; chapter: number }>();
  const hooks = new Map<string, FoldedHook>();
  const summaries: Array<{ chapter: number; title: string; summary: string }> = [];
  const chapters = [...(ledger?.chapters ?? [])].sort((a, b) => a.chapter - b.chapter);
  for (const entry of chapters) {
    if (beforeChapter !== undefined && entry.chapter >= beforeChapter) continue;
    const adoptedId = adoptedArtifactId(adoptedWrite, entry.chapter);
    if (adoptedId && adoptedId !== entry.artifactId) continue;
    for (const character of entry.characters) {
      characters.set(character.name, { name: character.name, status: character.status, chapter: entry.chapter });
    }
    for (const hook of entry.openHooks) {
      hooks.set(hook.id, {
        id: hook.id,
        label: hook.label,
        originChapter: entry.chapter,
        status: "open",
        note: hook.note,
        ...(hook.targetChapter ? { targetChapter: hook.targetChapter } : {}),
      });
    }
    for (const id of entry.advanceHookIds) {
      const existing = hooks.get(id);
      if (!existing || existing.status === "resolved") continue;
      hooks.set(id, { ...existing, status: "progressing", note: existing.note || "本章又推进了一步" });
    }
    for (const id of entry.resolveHookIds) {
      const existing = hooks.get(id);
      if (!existing) continue;
      hooks.set(id, { ...existing, status: "resolved" });
    }
    if (entry.summary.trim()) {
      summaries.push({ chapter: entry.chapter, title: entry.title, summary: entry.summary.trim() });
    }
  }
  return {
    characters: [...characters.values()],
    hooks: [...hooks.values()],
    summaries,
  };
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

export function formatSettlePriorMemory(memory: FoldedMemory): string {
  const characters = memory.characters
    .filter((item) => item.name.trim())
    .map((item) => `${item.name}：${item.status || "情况未变"}（第 ${item.chapter} 章）`);
  const hooks = memory.hooks.map((hook) => {
    const when = hook.targetChapter ? `，打算第 ${hook.targetChapter} 章收回` : "";
    const note = hook.note ? `：${hook.note}` : "";
    return `${hook.id}\t${hook.label}\t${hook.status}${when}${note}`;
  });
  return [
    characters.length ? `【已有人物】\n${characters.join("\n")}` : "",
    hooks.length ? `【已有伏笔】id、标签、状态（推进或收回时必须沿用原 id）\n${hooks.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

export function formatSettleIdentity(chapter: LedgerChapter | undefined): string {
  if (!chapter) return "";
  const seen = new Set<string>();
  const lines: string[] = [];
  const remember = (id: string, label = "") => {
    if (!id.trim() || seen.has(id)) return;
    seen.add(id);
    lines.push(label.trim() ? `${id}\t${label.trim()}` : id);
  };
  for (const hook of chapter.openHooks) remember(hook.id, hook.label);
  for (const id of chapter.advanceHookIds) remember(id);
  for (const id of chapter.resolveHookIds) remember(id);
  if (lines.length === 0) return "";
  return [
    "【本章上次伏笔身份】只用于沿用 id，不是当前事实。正文里还在的线必须用原 id；正文已不再埋的线不要写入 openHooks，也不要为同一条线新建 id。",
    ...lines,
  ].join("\n");
}

export function remapSettleNoteToIdentity(note: SettleNote, chapter: LedgerChapter | undefined): SettleNote {
  if (!chapter) return note;
  const knownIds = new Set([
    ...chapter.openHooks.map((hook) => hook.id),
    ...chapter.advanceHookIds,
    ...chapter.resolveHookIds,
  ]);
  const byLabel = new Map<string, string>();
  for (const hook of chapter.openHooks) {
    const label = hook.label.trim();
    if (label && !byLabel.has(label)) byLabel.set(label, hook.id);
  }
  const remap = (id: string, label?: string) => {
    if (knownIds.has(id)) return id;
    const fromLabel = label?.trim() ? byLabel.get(label.trim()) : undefined;
    return fromLabel ?? id;
  };
  const openHooks = new Map<string, SettleNote["openHooks"][number]>();
  for (const hook of note.openHooks) {
    const remapped = { ...hook, id: remap(hook.id, hook.label) };
    openHooks.set(remapped.id, remapped);
  }
  return {
    summary: note.summary,
    characters: note.characters,
    openHooks: [...openHooks.values()],
    advanceHookIds: [...new Set(note.advanceHookIds.map((id) => remap(id)))],
    resolveHookIds: [...new Set(note.resolveHookIds.map((id) => remap(id)))],
  };
}

export function formatFoldedMemory(memory: FoldedMemory): string {
  const characters = memory.characters
    .filter((item) => item.name.trim())
    .map((item) => `${item.name}：${item.status || "情况未变"}`)
    .join("\n");
  const hooks = memory.hooks
    .filter((hook) => hook.status !== "resolved")
    .map((hook) => {
      const when = hook.targetChapter ? `，打算第 ${hook.targetChapter} 章收回` : "";
      const note = hook.note ? `：${hook.note}` : "";
      return `${hook.label}（第 ${hook.originChapter} 章埋下${when}）${note}`;
    })
    .join("\n");
  const summaries = memory.summaries
    .slice(-SUMMARY_KEEP)
    .map((item) => `第 ${item.chapter} 章${item.title ? ` ${item.title}` : ""}：${clip(item.summary, SUMMARY_CLIP)}`)
    .join("\n");
  return [
    characters && `【人物现状】\n${characters}`,
    hooks && `【待收伏笔】\n${hooks}`,
    summaries && `【近章摘要】\n${summaries}`,
  ].filter(Boolean).join("\n\n");
}

interface LegacySlices {
  readonly state: string;
  readonly hooks: ReadonlyArray<{ readonly startChapter: number; readonly line: string }>;
  readonly summaries: ReadonlyArray<{ readonly chapter: number; readonly title: string; readonly summary: string }>;
}

async function readLegacySlices(bookDir: string, beforeChapter?: number): Promise<LegacySlices> {
  let state = "";
  try {
    state = clip(await readFile(join(bookDir, "story", "current_state.md"), "utf-8"), 3000);
  } catch {
    /* old books may not have this file */
  }
  const hooks: Array<{ startChapter: number; line: string }> = [];
  try {
    const raw = JSON.parse(await readFile(join(bookDir, "story", "state", "hooks.json"), "utf-8")) as unknown;
    const parsed = HooksStateSchema.safeParse(raw);
    if (parsed.success) {
      for (const hook of parsed.data.hooks) {
        if (hook.status === "resolved") continue;
        if (beforeChapter !== undefined && hook.startChapter >= beforeChapter) continue;
        const label = hook.expectedPayoff || hook.notes || hook.hookId;
        const when = hook.targetChapter ? `，打算第 ${hook.targetChapter} 章收回` : "";
        hooks.push({
          startChapter: hook.startChapter,
          line: `${label}（第 ${hook.startChapter} 章埋下${when}）`,
        });
      }
    }
  } catch {
    /* ignore unreadable legacy hooks */
  }
  const summaries: Array<{ chapter: number; title: string; summary: string }> = [];
  try {
    const raw = JSON.parse(await readFile(join(bookDir, "story", "state", "chapter_summaries.json"), "utf-8")) as unknown;
    const parsed = ChapterSummariesStateSchema.safeParse(raw);
    if (parsed.success) {
      for (const row of parsed.data.rows) {
        if (beforeChapter !== undefined && row.chapter >= beforeChapter) continue;
        const summary = row.events || row.stateChanges || row.hookActivity;
        if (!summary.trim()) continue;
        summaries.push({ chapter: row.chapter, title: row.title, summary });
      }
    }
  } catch {
    /* ignore unreadable legacy summaries */
  }
  return { state, hooks, summaries };
}

export function coveredLedgerChapters(
  ledger: SerialLedger | undefined,
  adoptedWrite: Readonly<Record<string, string>> | undefined,
  beforeChapter?: number,
): Set<number> {
  const covered = new Set<number>();
  for (const entry of ledger?.chapters ?? []) {
    if (beforeChapter !== undefined && entry.chapter >= beforeChapter) continue;
    const adoptedId = adoptedWrite?.[String(entry.chapter)];
    if (adoptedId && adoptedId !== entry.artifactId) continue;
    covered.add(entry.chapter);
  }
  return covered;
}

function ledgerCoversEarlierChapters(covered: ReadonlySet<number>, beforeChapter?: number): boolean {
  if (beforeChapter === undefined || beforeChapter <= 1) return false;
  for (let chapter = 1; chapter < beforeChapter; chapter += 1) {
    if (!covered.has(chapter)) return false;
  }
  return true;
}

function formatMergedMemory(
  folded: FoldedMemory,
  legacy: LegacySlices,
  covered: ReadonlySet<number>,
  beforeChapter?: number,
): string {
  const includeLegacyState = Boolean(legacy.state) && !ledgerCoversEarlierChapters(covered, beforeChapter);
  const characters = folded.characters
    .filter((item) => item.name.trim())
    .map((item) => `${item.name}：${item.status || "情况未变"}`);
  if (includeLegacyState) characters.push(legacy.state);
  const hooks = [
    ...folded.hooks
      .filter((hook) => hook.status !== "resolved")
      .map((hook) => {
        const when = hook.targetChapter ? `，打算第 ${hook.targetChapter} 章收回` : "";
        const note = hook.note ? `：${hook.note}` : "";
        return `${hook.label}（第 ${hook.originChapter} 章埋下${when}）${note}`;
      }),
    ...legacy.hooks.filter((hook) => !covered.has(hook.startChapter)).map((hook) => hook.line),
  ];
  const summaries = [
    ...folded.summaries,
    ...legacy.summaries.filter((row) => !covered.has(row.chapter)),
  ]
    .sort((a, b) => a.chapter - b.chapter)
    .slice(-SUMMARY_KEEP)
    .map((item) => `第 ${item.chapter} 章${item.title ? ` ${item.title}` : ""}：${clip(item.summary, SUMMARY_CLIP)}`);
  return [
    characters.length ? `【人物现状】\n${characters.join("\n")}` : "",
    hooks.length ? `【待收伏笔】\n${hooks.join("\n")}` : "",
    summaries.length ? `【近章摘要】\n${summaries.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

export async function loadWriteMemory(root: AuthoringStoreRoot, chapterNumber?: number): Promise<string> {
  if (!root.bookId) return "";
  const bookDir = join(root.projectRoot, "books", root.bookId);
  const manifest = await loadManifest(root).catch(() => undefined);
  const ledger = await loadSerialLedger(bookDir);
  const covered = coveredLedgerChapters(ledger, manifest?.adopted.write, chapterNumber);
  const folded = foldSerialLedger(ledger, manifest?.adopted.write, chapterNumber);
  const legacy = await readLegacySlices(bookDir, chapterNumber);
  if (covered.size === 0 && !legacy.state && legacy.hooks.length === 0 && legacy.summaries.length === 0) {
    return "";
  }
  return formatMergedMemory(folded, legacy, covered, chapterNumber);
}

export async function readAuthoringOpenHooks(projectRoot: string, bookId: string): Promise<AuthoringOpenHook[]> {
  const bookDir = join(projectRoot, "books", bookId);
  const manifest = await loadManifest({ projectRoot, bookId }).catch(() => undefined);
  const ledger = await loadSerialLedger(bookDir);
  const folded = foldSerialLedger(ledger, manifest?.adopted.write);
  // 书房「待收伏笔」只看账本。旧书 hooks.json 仍由 hooks/due 自己读，
  // 落笔提示词的跨章记忆继续走 loadWriteMemory，那里会合并旧伏笔。
  return folded.hooks
    .filter((hook) => hook.status !== "resolved")
    .map((hook) => ({
      hookId: hook.id,
      label: hook.label,
      startChapter: hook.originChapter,
      type: "伏笔",
      status: hook.status === "progressing" ? "progressing" : "open",
      lastAdvancedChapter: hook.originChapter,
      expectedPayoff: hook.label,
      notes: hook.note,
      ...(hook.targetChapter ? { targetChapter: hook.targetChapter } : {}),
    }));
}

function settingNameKeys(title: string): string[] {
  const keys = new Set<string>();
  const trimmed = title.trim();
  if (trimmed.length >= 2) keys.add(trimmed);
  const stripped = trimmed.replace(/[（(][^）)]*[）)]/g, "").replace(/\s+/g, " ").trim();
  if (stripped.length >= 2) keys.add(stripped);
  for (const match of trimmed.matchAll(/[（(]([^）)]+)[）)]/g)) {
    const inner = match[1]?.trim() ?? "";
    if (inner.length >= 2) keys.add(inner);
  }
  return [...keys];
}

function splitSettingChunks(settings: string): string[] {
  const titled = settings.split(/\n(?=### )/).map((chunk) => chunk.trim()).filter(Boolean);
  if (titled.some((chunk) => chunk.startsWith("### "))) return titled;
  const headed = settings.split(/\n(?=#{1,3} )/).map((chunk) => chunk.trim()).filter(Boolean);
  return headed.length > 1 ? headed : titled;
}

export function pickSettingsByMention(
  settings: string,
  hints: { readonly texts: readonly string[] },
  budget = 8000,
): string {
  if (!settings.trim()) return "";
  if (settings.length <= budget) return settings;
  const haystack = hints.texts.filter(Boolean).join("\n");
  const chunks = splitSettingChunks(settings);
  const titled = chunks.map((chunk) => {
    const title = /^(?:###|##|#)\s+(.+)$/m.exec(chunk)?.[1]?.trim() ?? "";
    const hit = settingNameKeys(title).some((key) => haystack.includes(key));
    return { chunk, hit };
  });
  const ordered = [
    ...titled.filter((item) => item.hit),
    ...titled.filter((item) => !item.hit),
  ];
  let acc = "";
  for (const item of ordered) {
    const sep = acc ? "\n\n" : "";
    if (acc.length + sep.length + item.chunk.length <= budget) {
      acc += sep + item.chunk;
      continue;
    }
    if (!item.hit) continue;
    const room = budget - acc.length - sep.length;
    if (room > 24) acc += sep + item.chunk.slice(0, room);
  }
  if (acc) return acc;
  return (ordered[0]?.chunk ?? settings).slice(0, budget);
}
