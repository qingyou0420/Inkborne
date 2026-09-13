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
  return exists(join(bookDir, "story", "canon.md"))
    || exists(join(bookDir, "story", "workflow", "manifest.json"));
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
    const frame = await readOptional(join(bookDir, "story", "outline", "story_frame.md"))
      || await readOptional(join(bookDir, "story", "story_bible.md"));
    return {
      canon: canonFromCompat({
        title: book.title,
        genre: book.genre,
        storyCard,
        authorIntent: intent,
        storyFrame: frame,
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

export async function loadAdoptedSettingsText(root: AuthoringStoreRoot): Promise<string> {
  if (!root.bookId) return "";
  const bookDir = join(root.projectRoot, "books", root.bookId);
  const catalog = await loadSettingsCatalog(root);
  const chunks: string[] = [];
  for (const entry of catalog.entries) {
    if (entry.archived) continue;
    const body = await readOptional(join(bookDir, entry.file));
    if (body.trim()) chunks.push(`### ${entry.name}\n${body.trim()}`);
  }
  if (chunks.length > 0) return chunks.join("\n\n");
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

function pickRelevantSettings(settings: string, needle: string, budget = 8000): string {
  const chunks = settings.split(/\n(?=### )/);
  if (settings.length <= budget) return settings;
  const lowered = needle.toLowerCase();
  const matched = chunks.filter((chunk) => chunk.toLowerCase().split(/\s+/).some((token) => token && lowered.includes(token.slice(0, 12))));
  const preferred = matched.length > 0 ? matched : chunks.slice(0, Math.max(1, Math.ceil(chunks.length / 3)));
  let acc = "";
  for (const chunk of preferred) {
    if (acc.length + chunk.length > budget) break;
    acc += (acc ? "\n" : "") + chunk;
  }
  return acc || settings.slice(0, budget);
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
  const { canon, source } = await loadCanonDocument(root);
  const settings = await loadAdoptedSettingsText(root);
  const outline = options?.outlineOverride ?? await loadOutlineText(root);
  const manifest = await loadManifest(root);
  const refs: InputRef[] = [];
  if (manifest.adopted.ask) refs.push({ kind: "canon", id: manifest.adopted.ask });
  for (const id of manifest.adopted.ground) refs.push({ kind: "setting", id });
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
    settings && `【设定】\n${pickRelevantSettings(settings, needle)}`,
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
