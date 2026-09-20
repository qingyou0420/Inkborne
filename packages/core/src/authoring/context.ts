/**
 * Assemble authoring context from adopted files, with old-book fallbacks.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { access, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { findChapterNode, findVolumeOwningNode, parseVolumeMapTree, volumeMapLeadingNotesMarkdown } from "../utils/volume-map-tree.js";
import { parseCanon, canonFromCompat, serializeCanon } from "./canon.js";
import { loadArtifact, loadManifest, loadSettingsCatalog, type AuthoringStoreRoot } from "./store.js";
import type { AuthoringStage, CanonDocument, InputRef } from "./types.js";

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function isBookPresent(bookDir: string): Promise<boolean> {
  return exists(join(bookDir, "book.json"));
}

export async function isLightweightAuthoringBook(bookDir: string): Promise<boolean> {
  if (!(await exists(join(bookDir, "book.json")))) return false;
  if (await exists(join(bookDir, "story", "canon.md"))) return true;
  try {
    const raw = JSON.parse(await readFile(join(bookDir, "story", "workflow", "manifest.json"), "utf-8")) as {
      adopted?: { ask?: unknown };
      candidates?: { ask?: unknown };
    };
    return Boolean(raw.adopted?.ask || raw.candidates?.ask);
  } catch {
    return false;
  }
}

/** New Ask books cannot use their source conversation as an adopted canon. */
export async function assertAdoptedCanonReady(root: AuthoringStoreRoot): Promise<void> {
  if (!root.bookId) return;
  const manifest = await loadManifest(root);
  if (!manifest.candidates.ask || manifest.adopted.ask) return;
  // Existing canon files predate manifest adoption tracking in some books.
  if (await exists(join(root.projectRoot, "books", root.bookId, "story", "canon.md"))) return;
  throw new Error("请先在问心中采用正典，再进入设定、大纲与正文创作。");
}

export async function loadBookJson(bookDir: string): Promise<{ title: string; genre?: string; targetChapters?: number; chapterWordCount?: number; language?: string }> {
  const raw = JSON.parse(await readFile(join(bookDir, "book.json"), "utf-8")) as Record<string, unknown>;
  return {
    title: typeof raw.title === "string" ? raw.title : "未命名",
    genre: typeof raw.genre === "string" ? raw.genre : undefined,
    targetChapters: typeof raw.targetChapters === "number" ? raw.targetChapters : undefined,
    chapterWordCount: typeof raw.chapterWordCount === "number" ? raw.chapterWordCount : undefined,
    language: typeof raw.language === "string" ? raw.language : undefined,
  };
}

export async function loadCanonDocument(root: AuthoringStoreRoot): Promise<{ canon: CanonDocument; source: "canon" | "compat"; path?: string }> {
  if (root.bookId) {
    const bookDir = join(root.projectRoot, "books", root.bookId);
    const canonPath = join(bookDir, "story", "canon.md");
    if (await exists(canonPath)) {
      return { canon: parseCanon(await readFile(canonPath, "utf-8")), source: "canon", path: canonPath };
    }
    const book = await loadBookJson(bookDir);
    const storyCard = await readOptional(join(bookDir, "story", "story_card.md"));
    const intent = await readOptional(join(bookDir, "story", "author_intent.md"));
    const frame = await readOptional(join(bookDir, "story", "outline", "story_frame.md"));
    const bible = await readOptional(join(bookDir, "story", "story_bible.md"));
    return {
      canon: canonFromCompat({
        title: book.title,
        genre: book.genre,
        targetChapters: book.targetChapters,
        chapterWordCount: book.chapterWordCount,
        storyCard,
        authorIntent: intent,
        storyFrame: frame,
        storyBible: bible,
      }),
      source: "compat",
    };
  }
  const draftDir = join(root.projectRoot, ".inkos", "authoring-drafts", root.draftId ?? "untitled");
  const canonPath = join(draftDir, "canon.md");
  if (await exists(canonPath)) {
    return { canon: parseCanon(await readFile(canonPath, "utf-8")), source: "canon", path: canonPath };
  }
  return {
    canon: canonFromCompat({ title: "未命名构思" }),
    source: "compat",
  };
}

export interface AdoptedSettingEntry {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly artifactId: string;
  readonly body: string;
}

export async function loadAdoptedSettingEntries(root: AuthoringStoreRoot): Promise<AdoptedSettingEntry[]> {
  if (!root.bookId) return [];
  const bookDir = join(root.projectRoot, "books", root.bookId);
  const catalog = await loadSettingsCatalog(root);
  if (catalog.entries.length === 0) return [];
  const entries: AdoptedSettingEntry[] = [];
  for (const entry of catalog.entries) {
    if (entry.archived || !entry.adoptedArtifactId) continue;
    const body = await readOptional(join(bookDir, entry.file));
    if (!body.trim()) continue;
    entries.push({
      id: entry.id,
      name: entry.name,
      category: entry.category,
      artifactId: entry.adoptedArtifactId,
      body: body.trim(),
    });
  }
  return entries;
}

export async function loadAdoptedSettingsText(root: AuthoringStoreRoot): Promise<string> {
  if (!root.bookId) return "";
  const bookDir = join(root.projectRoot, "books", root.bookId);
  const adopted = await loadAdoptedSettingEntries(root);
  if (adopted.length > 0) {
    return adopted.map((entry) => `### ${entry.name}\n${entry.body}`).join("\n\n");
  }
  const catalog = await loadSettingsCatalog(root);
  if (catalog.entries.length > 0) return "";
  const rules = await readOptional(join(bookDir, "story", "book_rules.md"));
  const rolesDir = join(bookDir, "story", "roles");
  const roleBits: string[] = [];
  for (const tier of ["主要角色", "major", "次要角色", "minor"]) {
    const dir = join(rolesDir, tier);
    try {
      const files = await readdir(dir);
      for (const file of files.filter((name) => name.endsWith(".md"))) {
        roleBits.push(await readFile(join(dir, file), "utf-8"));
      }
    } catch {
      /* missing */
    }
  }
  return [rules, ...roleBits].filter((text) => text.trim()).join("\n\n");
}

export async function loadOutlineText(root: AuthoringStoreRoot): Promise<string> {
  if (!root.bookId) return "";
  const bookDir = join(root.projectRoot, "books", root.bookId);
  return (await readOptional(join(bookDir, "story", "outline", "volume_map.md")))
    || (await readOptional(join(bookDir, "story", "volume_outline.md")));
}

export async function loadChapterText(root: AuthoringStoreRoot, chapterNumber: number): Promise<string> {
  if (!root.bookId) return "";
  const chaptersDir = join(root.projectRoot, "books", root.bookId, "chapters");
  try {
    const files = await readdir(chaptersDir);
    const padded = String(chapterNumber).padStart(4, "0");
    const match = files.find((file) => file.startsWith(padded) && file.endsWith(".md"));
    if (!match) return "";
    return await readFile(join(chaptersDir, match), "utf-8");
  } catch {
    return "";
  }
}

export function serializeCanonBrief(canon: CanonDocument): string {
  return [
    `书名：${canon.title}`,
    canon.genre && `类型：${canon.genre}`,
    canon.targetChapters && `目标章数：${canon.targetChapters}`,
    canon.oneLine && `一句话：${canon.oneLine}`,
    canon.proposition && `命题：${canon.proposition}`,
    canon.protagonist && `主角：${canon.protagonist}`,
    canon.conflict && `冲突：${canon.conflict}`,
    canon.voice && `文风：${canon.voice}`,
    canon.boundaries && `故事边界：${canon.boundaries}`,
    canon.direction && `初始方向：${canon.direction}`,
    canon.openQuestions.length ? `待定项：${canon.openQuestions.join("；")}` : "",
  ].filter(Boolean).join("\n");
}

function significantTokens(text: string): string[] {
  return text
    .split(/[\s,，。；;、:：\/\\|()（）\[\]【】]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !/^\d+$/.test(token));
}

function settingAliases(entry: AdoptedSettingEntry): string[] {
  const aliases: string[] = [];
  for (const match of entry.body.matchAll(/\*{0,2}别名\*{0,2}\s*[：:]\s*([^\n]+)/g)) {
    for (const part of (match[1] ?? "").split(/[、,，；;\/／]/)) {
      const alias = part.replace(/[\*。.\s]+$/g, "").replace(/^\*+/, "").trim();
      if (alias.length >= 2) aliases.push(alias);
    }
  }
  return aliases;
}

function nameHitsNeedle(entry: AdoptedSettingEntry | string, needle: string): boolean {
  if (typeof entry === "string") return Boolean(entry) && entry.length >= 2 && needle.includes(entry);
  if (entry.name && entry.name.length >= 2 && needle.includes(entry.name)) return true;
  return settingAliases(entry).some((alias) => needle.includes(alias));
}

const CONSTRAINT_HEADING = /#{2,3}[^\n]*(?:核心约束|行为底线|年代定位|禁忌|铁律|硬规则|年表|约束)/;

function isConstraintSetting(entry: AdoptedSettingEntry): boolean {
  return /时间|规则|世界|制度|年表|铁律|约束/.test(`${entry.category}${entry.name}`);
}

function scoreSettingEntry(entry: AdoptedSettingEntry, needle: string, tokens: readonly string[]): number {
  const haystack = `${entry.category} ${entry.name} ${entry.body}`;
  let score = 0;
  if (nameHitsNeedle(entry, needle)) score += 80;
  for (const token of tokens) {
    if (haystack.includes(token) || entry.name.includes(token)) score += token.length >= 4 ? 4 : 2;
  }
  if (isConstraintSetting(entry)) score += 12;
  else if (CONSTRAINT_HEADING.test(entry.body)) score += 8;
  else if (/人物|角色|关系/.test(`${entry.category}${entry.name}`)) score += 3;
  return score;
}

function excerptSettingBody(entry: AdoptedSettingEntry, needle: string): string {
  const body = entry.body;
  if (body.length <= 900) return body;
  const constraint = /(?:^|\n)(#{2,3}[^\n]*(?:核心约束|行为底线|年代定位|禁忌|铁律|硬规则|年表|约束)[^\n]*\n[\s\S]*?)(?=\n#{2,3}(?:\s|$)|$)/.exec(`\n${body}`);
  if (constraint?.[1]) {
    const block = constraint[1].trim();
    if (block.length <= 900) return block;
    const nl = block.indexOf("\n");
    const heading = nl >= 0 ? block.slice(0, nl) : block;
    const rest = nl >= 0 ? block.slice(nl + 1) : "";
    if (rest.length <= 860) return `${block.slice(0, 899)}…`;
    return `${heading}\n${rest.slice(0, 400)}\n…\n${rest.slice(-400)}`;
  }
  const keys = [...settingAliases(entry), ...significantTokens(needle)].filter((key) => key.length >= 2 && key !== entry.name);
  let best = -1;
  let bestIdx = 0;
  for (const key of keys) {
    const idx = body.indexOf(key);
    if (idx < 0) continue;
    if (key.length > best) {
      best = key.length;
      bestIdx = idx;
    }
  }
  if (best < 0) {
    const named = body.indexOf(entry.name);
    bestIdx = named > 0 ? named : 0;
  }
  const start = Math.max(0, bestIdx - 80);
  return `${start > 0 ? "…" : ""}${body.slice(start, start + 900)}${start + 900 < body.length ? "…" : ""}`;
}

function formatSettingEntry(entry: AdoptedSettingEntry, needle: string, excerpt = false): string {
  const body = excerpt ? excerptSettingBody(entry, needle) : entry.body;
  return `### ${entry.name}〔${entry.category}/${entry.id}〕\n${body}`;
}

export function pickRelevantSettings(settings: string, needle: string, budget = 8000): string {
  const chunks = settings.split(/\n(?=### )/).filter((chunk) => chunk.trim());
  if (settings.length <= budget) return settings;
  const tokens = significantTokens(needle);
  const ranked = chunks
    .map((chunk) => {
      const score = tokens.reduce((sum, token) => sum + (chunk.includes(token) ? token.length : 0), 0);
      return { chunk, score };
    })
    .sort((left, right) => right.score - left.score);
  let acc = "";
  for (const item of ranked) {
    const next = acc ? `${acc}\n\n${item.chunk}` : item.chunk;
    if (next.length > budget) {
      if (!acc) return item.chunk.slice(0, budget);
      continue;
    }
    acc = next;
  }
  return acc || settings.slice(0, budget);
}

function packAdoptedSettings(
  entries: readonly AdoptedSettingEntry[],
  needle: string,
  budget: number,
  includeIndex: boolean,
  options?: { readonly coverConstraints?: boolean },
): {
  text: string;
  selected: AdoptedSettingEntry[];
  picks: ReadonlyArray<{ entry: AdoptedSettingEntry; usage: "full" | "excerpt"; reason: string; snippet: string }>;
} {
  if (entries.length === 0) return { text: "", selected: [], picks: [] };
  const tokens = significantTokens(needle);
  const index = includeIndex
    ? `【已采用设定索引 ${entries.length} 项】\n${entries.map((entry) => `- ${entry.category}/${entry.name} (${entry.id})`).join("\n")}`
    : "";
  const fullTexts = entries.map((entry) => formatSettingEntry(entry, needle, false));
  const fullSize = fullTexts.reduce((sum, text) => sum + text.length + 2, 0) + (index ? index.length + 2 : 0);
  if (fullSize <= budget) {
    const parts = index ? [index, ...fullTexts] : fullTexts;
    return {
      text: parts.join("\n\n"),
      selected: [...entries],
      picks: entries.map((entry) => ({
        entry,
        usage: "full" as const,
        reason: "预算可容纳全文",
        snippet: formatSettingEntry(entry, needle, false).slice(0, 240),
      })),
    };
  }
  let used = index.length;
  const parts: string[] = [];
  const picks: Array<{ entry: AdoptedSettingEntry; usage: "full" | "excerpt"; reason: string; text: string }> = [];
  if (index) parts.push(index);
  const take = (entry: AdoptedSettingEntry, excerpt: boolean, reason: string): boolean => {
    if (picks.some((item) => item.entry.id === entry.id)) return false;
    const text = formatSettingEntry(entry, needle, excerpt);
    if (used + (parts.length ? 2 : 0) + text.length > budget) return false;
    parts.push(text);
    used += (parts.length > 1 ? 2 : 0) + text.length;
    picks.push({ entry, usage: excerpt ? "excerpt" : "full", reason, text });
    return true;
  };
  if (options?.coverConstraints) {
    for (const entry of entries.filter(isConstraintSetting)) take(entry, true, "关键约束覆盖");
  }
  for (const entry of entries.filter((item) => nameHitsNeedle(item, needle))) take(entry, true, "当前章点名或别名");
  const ranked = [...entries].sort((left, right) => scoreSettingEntry(right, needle, tokens) - scoreSettingEntry(left, needle, tokens));
  for (const entry of ranked) take(entry, true, "相关度补入");
  for (const pick of picks) {
    if (pick.usage !== "excerpt") continue;
    const full = formatSettingEntry(pick.entry, needle, false);
    const extra = full.length - pick.text.length;
    if (extra <= 0 || used + extra > budget) continue;
    const at = parts.indexOf(pick.text);
    if (at < 0) continue;
    parts[at] = full;
    used += extra;
    pick.usage = "full";
    pick.reason = `${pick.reason}；余量回填全文`;
    pick.text = full;
  }
  return {
    text: parts.join("\n\n"),
    selected: picks.map((item) => item.entry),
    picks: picks.map(({ entry, usage, reason, text }) => ({
      entry,
      usage,
      reason,
      snippet: text.slice(0, 240),
    })),
  };
}

function clipOutlineChunk(text: string, max: number): string {
  if (max <= 0 || !text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function packOutlineChunks(chunks: readonly string[], budget: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    if (!chunk) continue;
    const sep = kept.length > 0 ? 2 : 0;
    if (used + sep + chunk.length <= budget) {
      used += sep + chunk.length;
      kept.push(chunk);
      continue;
    }
    const room = budget - used - sep;
    if (room > 1) kept.push(clipOutlineChunk(chunk, room));
    break;
  }
  return kept.join("\n\n");
}

function chapterOutlineLabel(node: { readonly kind: string; readonly chapterNumber: number; readonly endChapter?: number; readonly title: string }, fallbackNumber: number): string {
  if (node.kind === "range" && node.endChapter) {
    return `【第${node.chapterNumber}-${node.endChapter}章 ${node.title}】`;
  }
  return `【第${fallbackNumber}章 ${node.title}】`;
}

function outlineForChapter(outline: string, chapterNumber?: number, budget = 8000): string {
  if (!outline.trim()) return "";
  if (!chapterNumber) {
    return outline.length <= budget ? outline : `${outline.slice(0, budget)}\n…`;
  }
  const tree = parseVolumeMapTree(outline);
  const node = findChapterNode(tree, chapterNumber);
  const volume = node
    ? findVolumeOwningNode(tree, node.id)
    : tree.volumes.find((item) => item.chapters.some((chapter) => {
      if (chapter.kind === "range" && chapter.endChapter) {
        return chapterNumber >= chapter.chapterNumber && chapterNumber <= chapter.endChapter;
      }
      return chapter.chapterNumber === chapterNumber;
    }));
  const seen = new Set<string>();
  const take = (num: number): string => {
    const beat = findChapterNode(tree, num);
    if (!beat || seen.has(beat.id)) return "";
    seen.add(beat.id);
    return `${chapterOutlineLabel(beat, num)}\n${beat.summary}`;
  };
  const current = take(chapterNumber);
  const volumeText = volume ? `【本卷】第${volume.volumeNumber ?? "?"}卷 ${volume.title}\n${volume.body}` : "";
  const adjacent = [chapterNumber - 1, chapterNumber + 1].map((num) => take(num)).filter(Boolean).join("\n\n");
  const leadingNotes = volumeMapLeadingNotesMarkdown(outline);
  const notesText = leadingNotes ? `【作者备注】\n${leadingNotes}` : "";
  const currentKeep = current.length <= budget ? current : clipOutlineChunk(current, budget);
  const prefixBudget = currentKeep ? Math.max(0, budget - currentKeep.length - 2) : budget;
  const prefix = packOutlineChunks([notesText, volumeText, adjacent], prefixBudget);
  const packed = [prefix, currentKeep].filter(Boolean).join("\n\n");
  if (packed.trim()) return packed;
  return outline.length <= budget ? outline : outline.slice(Math.max(0, outline.length - budget));
}

function chapterStatePaths(root: AuthoringStoreRoot, chapterNumber: number): { dir: string; body: string; ref: string } | undefined {
  if (!root.bookId) return undefined;
  const dir = join(root.projectRoot, "books", root.bookId, "story", "state");
  return {
    dir,
    body: join(dir, `chapter-${chapterNumber}.md`),
    ref: join(dir, `chapter-${chapterNumber}.ref.json`),
  };
}

async function readStateRef(path: string): Promise<string> {
  const raw = await readOptional(path);
  if (!raw.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as { artifactId?: unknown };
    return typeof parsed.artifactId === "string" ? parsed.artifactId : "";
  } catch {
    return "";
  }
}

export async function writeChapterState(
  root: AuthoringStoreRoot,
  chapterNumber: number,
  artifactId: string,
  body: string,
): Promise<void> {
  const paths = chapterStatePaths(root, chapterNumber);
  if (!paths) return;
  await mkdir(paths.dir, { recursive: true });
  const note = body.endsWith("\n") ? body : `${body}\n`;
  await writeFile(paths.body, note, "utf-8");
  await writeFile(paths.ref, `${JSON.stringify({ artifactId, chapterNumber }, null, 2)}\n`, "utf-8");
}

export async function invalidateChapterState(root: AuthoringStoreRoot, chapterNumber: number): Promise<void> {
  const paths = chapterStatePaths(root, chapterNumber);
  if (!paths) return;
  await rm(paths.body, { force: true });
  await rm(paths.ref, { force: true });
}

export async function loadChapterState(root: AuthoringStoreRoot, chapterNumber: number): Promise<string> {
  if (!root.bookId) return "";
  const bookDir = join(root.projectRoot, "books", root.bookId);
  const paths = chapterStatePaths(root, chapterNumber);
  const body = paths ? await readOptional(paths.body) : "";
  const manifest = await loadManifest(root);
  const adoptedId = manifest.adopted.write[String(chapterNumber)];
  if (adoptedId) {
    const refId = paths ? await readStateRef(paths.ref) : "";
    if (!refId || refId !== adoptedId) return "";
    return body;
  }
  return body || (await readOptional(join(bookDir, "story", "current_state.md")));
}

export async function resolvePlannedChapterTitle(
  root: AuthoringStoreRoot,
  chapterNumber: number,
): Promise<string | undefined> {
  const outline = await loadOutlineText(root);
  if (!outline.trim()) return undefined;
  const node = findChapterNode(parseVolumeMapTree(outline), chapterNumber);
  const title = node?.title?.trim();
  if (!title) return undefined;
  if (title === `第${chapterNumber}章` || title === `第 ${chapterNumber} 章`) return undefined;
  return title;
}

export interface AuthoringContext {
  readonly text: string;
  readonly refs: InputRef[];
}

export async function assembleAuthoringContext(
  root: AuthoringStoreRoot,
  options?: {
    readonly stage?: AuthoringStage;
    readonly chapterNumber?: number;
    readonly extra?: string;
    readonly outlineOverride?: string;
  },
): Promise<AuthoringContext> {
  if (options?.stage !== "ask") await assertAdoptedCanonReady(root);
  const { canon, source } = await loadCanonDocument(root);
  const outline = options?.outlineOverride ?? await loadOutlineText(root);
  const adoptedEntries = await loadAdoptedSettingEntries(root);
  const settingsNeedle = [
    options?.chapterNumber ? `第${options.chapterNumber}章` : "",
    canon.protagonist,
    outlineForChapter(outline, options?.chapterNumber, 1800),
  ].join(" ");
  const packedSettings = adoptedEntries.length > 0
    ? packAdoptedSettings(
      adoptedEntries,
      settingsNeedle,
      options?.stage === "weave" && !options.chapterNumber ? 12000 : 8000,
      options?.stage === "weave" && !options.chapterNumber,
      { coverConstraints: options?.stage === "weave" && !options.chapterNumber },
    )
    : { text: await loadAdoptedSettingsText(root), selected: [] as AdoptedSettingEntry[], picks: [] };
  const settings = packedSettings.text;
  const manifest = await loadManifest(root);
  const refs: InputRef[] = [];
  if (manifest.adopted.ask) refs.push({ kind: "canon", id: manifest.adopted.ask });
  if (options?.stage === "weave" && !options.chapterNumber && packedSettings.picks.length) {
    refs.push({ kind: "setting-index", id: "catalog", usage: "index", reason: "已采用设定目录" });
  }
  for (const pick of packedSettings.picks) {
    refs.push({
      kind: "setting",
      id: pick.entry.artifactId,
      usage: pick.usage,
      reason: pick.reason,
      snippet: pick.snippet,
    });
  }
  if (adoptedEntries.length > packedSettings.selected.length) {
    refs.push({
      kind: "setting-omit",
      id: "catalog",
      usage: "index",
      reason: `预算不足未纳入 ${adoptedEntries.length - packedSettings.selected.length} 项`,
    });
  }
  if (manifest.adopted.weave) refs.push({ kind: "outline", id: manifest.adopted.weave });
  if (options?.chapterNumber && manifest.adopted.write[String(options.chapterNumber - 1)]) {
    refs.push({ kind: "chapter", id: manifest.adopted.write[String(options.chapterNumber - 1)]! });
  }
  const needle = [
    options?.chapterNumber ? `第${options.chapterNumber}章` : "",
    canon.protagonist,
    outlineForChapter(outline, options?.chapterNumber, 1200),
  ].join(" ");
  const previous = options?.chapterNumber && options.chapterNumber > 1
    ? await loadChapterText(root, options.chapterNumber - 1)
    : "";
  const previousState = options?.chapterNumber && options.chapterNumber > 1
    ? await loadChapterState(root, options.chapterNumber - 1)
    : "";
  const text = [
    source === "compat" ? "【兼容正典视图，尚未经问心采用】" : "【已采用正典】",
    serializeCanonBrief(canon),
    "",
    serializeCanon(canon),
    settings && `【设定】\n${adoptedEntries.length > 0 ? settings : pickRelevantSettings(settings, needle)}`,
    outline && `【规划】\n${outlineForChapter(outline, options?.chapterNumber)}`,
    previous && `【上一章结尾】\n${previous.slice(-2000)}`,
    previousState && `【上一章状态】\n${previousState.slice(0, 3000)}`,
    options?.extra,
    manifest.watches.filter((watch) => !watch.acknowledged).length
      ? `待核对：${manifest.watches.filter((watch) => !watch.acknowledged).map((watch) => watch.label).join("；")}`
      : "",
  ].filter(Boolean).join("\n");
  return { text, refs };
}

export async function assembleStageContext(root: AuthoringStoreRoot, chapterNumber?: number): Promise<string> {
  return (await assembleAuthoringContext(root, { chapterNumber })).text;
}

export async function loadCandidateOrAdoptedBody(
  root: AuthoringStoreRoot,
  artifactId: string | undefined,
): Promise<string> {
  if (!artifactId) return "";
  const loaded = await loadArtifact(root, artifactId);
  return loaded?.body ?? "";
}
