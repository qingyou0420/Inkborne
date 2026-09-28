import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ChapterVersionSource =
  | "manual"
  | "agent"
  | "revision"
  | "regeneration"
  | "restore"
  | "autosave";

export interface ChapterVersion {
  readonly id: string;
  readonly chapterNumber: number;
  readonly source: ChapterVersionSource;
  readonly createdAt: string;
  readonly characterCount: number;
}

const VERSION_ID_PATTERN = /^(\d{13})_(manual|agent|revision|regeneration|restore|autosave)_([0-9a-f-]{36})$/;

export async function readChapterUserBrief(
  bookDir: string,
  chapterNumber: number,
): Promise<string> {
  try {
    return (await readFile(userBriefPath(bookDir, chapterNumber), "utf-8")).trim();
  } catch (error) {
    if (isMissingFile(error)) return "";
    throw error;
  }
}

export async function saveChapterUserBrief(
  bookDir: string,
  chapterNumber: number,
  brief: string,
): Promise<void> {
  const path = userBriefPath(bookDir, chapterNumber);
  const normalized = brief.trim();
  if (!normalized) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(join(bookDir, "story", "runtime"), { recursive: true });
  await writeFile(path, `${normalized}\n`, "utf-8");
}

export async function readChapterPlanDocument(
  bookDir: string,
  chapterNumber: number,
): Promise<string | null> {
  try {
    return await readFile(planPath(bookDir, chapterNumber), "utf-8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

/** Rolling autosaves beyond this count are deleted. Manual baselines and other snapshots stay. */
export const CHAPTER_VERSION_KEEP = 20;

export async function archiveChapterVersion(
  bookDir: string,
  chapterNumber: number,
  content: string,
  source: ChapterVersionSource,
  now = new Date(),
): Promise<ChapterVersion> {
  assertChapterNumber(chapterNumber);
  const id = `${now.getTime()}_${source}_${randomUUID()}`;
  const dir = versionsDir(bookDir, chapterNumber);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.md`), content, "utf-8");
  const entry: ChapterVersion = {
    id,
    chapterNumber,
    source,
    createdAt: now.toISOString(),
    characterCount: content.length,
  };
  await syncChapterVersions(bookDir, chapterNumber, entry);
  return entry;
}

/** Rolling autosaves share one file until this window closes or a new edit session starts. */
export const AUTOSAVE_MERGE_MS = 10 * 60 * 1000;

/**
 * Keep the on-disk chapter recoverable, then store the new text as a rolling autosave.
 * The first save (or any save whose disk text differs from the newest version) archives
 * the disk bytes as a manual baseline before touching the autosave file.
 */
export async function storeAutosaveVersion(
  bookDir: string,
  chapterNumber: number,
  content: string,
  now = new Date(),
  options?: { readonly fresh?: boolean; readonly diskContent?: string },
): Promise<ChapterVersion> {
  assertChapterNumber(chapterNumber);
  const versions = await listChapterVersions(bookDir, chapterNumber);
  const latest = versions[0];
  let archivedBaseline = false;
  if (options?.diskContent !== undefined) {
    const latestBody = latest
      ? await readChapterVersion(bookDir, chapterNumber, latest.id).catch(() => undefined)
      : undefined;
    if (latestBody !== options.diskContent) {
      await archiveChapterVersion(
        bookDir,
        chapterNumber,
        options.diskContent,
        "manual",
        new Date(now.getTime() - 1),
      );
      archivedBaseline = true;
    }
  }
  const age = latest ? now.getTime() - Date.parse(latest.createdAt) : Number.POSITIVE_INFINITY;
  const canMerge = !archivedBaseline
    && options?.fresh !== true
    && latest?.source === "autosave"
    && age >= 0
    && age <= AUTOSAVE_MERGE_MS;
  if (canMerge && latest) {
    const dir = versionsDir(bookDir, chapterNumber);
    await writeFile(join(dir, `${latest.id}.md`), content, "utf-8");
    const merged = { ...latest, characterCount: content.length };
    await syncChapterVersions(bookDir, chapterNumber, merged);
    return merged;
  }
  return archiveChapterVersion(bookDir, chapterNumber, content, "autosave", now);
}

export async function listChapterVersions(
  bookDir: string,
  chapterNumber: number,
): Promise<ReadonlyArray<ChapterVersion>> {
  assertChapterNumber(chapterNumber);
  return syncChapterVersions(bookDir, chapterNumber);
}

async function syncChapterVersions(
  bookDir: string,
  chapterNumber: number,
  known?: ChapterVersion,
): Promise<ChapterVersion[]> {
  const dir = versionsDir(bookDir, chapterNumber);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const ids = files.flatMap((file) => {
    if (!file.endsWith(".md")) return [];
    const id = file.slice(0, -3);
    return parseVersionId(id) ? [id] : [];
  });
  const catalog = await readVersionCatalog(dir);
  const byId = new Map(catalog.map((entry) => [entry.id, { ...entry, chapterNumber }]));
  if (known && known.chapterNumber === chapterNumber && parseVersionId(known.id)) {
    byId.set(known.id, known);
  }
  let changed = Boolean(known) || catalog.length !== ids.length;
  for (const id of ids) {
    if (byId.has(id)) continue;
    const content = await readFile(join(dir, `${id}.md`), "utf-8");
    const parsed = parseVersionId(id);
    if (!parsed) continue;
    byId.set(id, {
      id,
      chapterNumber,
      source: parsed.source,
      createdAt: new Date(parsed.timestamp).toISOString(),
      characterCount: content.length,
    });
    changed = true;
  }
  for (const id of [...byId.keys()]) {
    if (!ids.includes(id)) {
      byId.delete(id);
      changed = true;
    }
  }
  const pruned = pruneChapterVersions([...byId.values()]);
  if (pruned.dropped.length > 0) changed = true;
  if (changed) {
    await Promise.all(pruned.dropped.map((entry) => rm(join(dir, `${entry.id}.md`), { force: true })));
    await writeFile(
      join(dir, VERSION_CATALOG),
      `${JSON.stringify(pruned.kept.map(catalogEntry))}\n`,
      "utf-8",
    );
  }
  return pruned.kept.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function catalogEntry(version: ChapterVersion): {
  id: string;
  source: ChapterVersionSource;
  createdAt: string;
  characterCount: number;
} {
  return {
    id: version.id,
    source: version.source,
    createdAt: version.createdAt,
    characterCount: version.characterCount,
  };
}

async function readVersionCatalog(dir: string): Promise<ChapterVersion[]> {
  try {
    const raw = await readFile(join(dir, VERSION_CATALOG), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as { id?: unknown; source?: unknown; createdAt?: unknown; characterCount?: unknown };
      if (typeof record.id !== "string" || !parseVersionId(record.id)) return [];
      const parsedId = parseVersionId(record.id);
      if (!parsedId || record.source !== parsedId.source) return [];
      if (typeof record.characterCount !== "number" || !Number.isFinite(record.characterCount)) return [];
      return [{
        id: record.id,
        chapterNumber: 0,
        source: parsedId.source,
        createdAt: new Date(parsedId.timestamp).toISOString(),
        characterCount: record.characterCount,
      }];
    });
  } catch (error) {
    if (isMissingFile(error)) return [];
    return [];
  }
}

function pruneChapterVersions(versions: readonly ChapterVersion[]): {
  kept: ChapterVersion[];
  dropped: ChapterVersion[];
} {
  const pinned = new Set<string>();
  const nonAutosave = versions.filter((version) => version.source !== "autosave");
  for (const version of nonAutosave) pinned.add(version.id);
  if (nonAutosave.length === 0 && versions.length > 0) {
    const oldest = [...versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (oldest) pinned.add(oldest.id);
  }
  const autosaves = [...versions]
    .filter((version) => version.source === "autosave" && !pinned.has(version.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const version of autosaves.slice(0, CHAPTER_VERSION_KEEP)) pinned.add(version.id);
  const kept = versions.filter((version) => pinned.has(version.id));
  const dropped = versions.filter((version) => !pinned.has(version.id));
  return { kept, dropped };
}

const VERSION_CATALOG = "catalog.json";

export async function readChapterVersion(
  bookDir: string,
  chapterNumber: number,
  versionId: string,
): Promise<string> {
  assertChapterNumber(chapterNumber);
  if (!parseVersionId(versionId)) {
    throw new Error(`Invalid chapter version id: ${versionId}`);
  }
  return readFile(join(versionsDir(bookDir, chapterNumber), `${versionId}.md`), "utf-8");
}

function userBriefPath(bookDir: string, chapterNumber: number): string {
  assertChapterNumber(chapterNumber);
  return join(bookDir, "story", "runtime", `chapter-${padChapter(chapterNumber)}.user-brief.md`);
}

function planPath(bookDir: string, chapterNumber: number): string {
  assertChapterNumber(chapterNumber);
  return join(bookDir, "story", "runtime", `chapter-${padChapter(chapterNumber)}.plan.md`);
}

function versionsDir(bookDir: string, chapterNumber: number): string {
  return join(bookDir, "chapters", ".versions", padChapter(chapterNumber));
}

function padChapter(chapterNumber: number): string {
  return String(chapterNumber).padStart(4, "0");
}

function assertChapterNumber(chapterNumber: number): void {
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error(`Invalid chapter number: ${chapterNumber}`);
  }
}

function parseVersionId(
  versionId: string,
): { readonly timestamp: number; readonly source: ChapterVersionSource } | null {
  const match = versionId.match(VERSION_ID_PATTERN);
  if (!match) return null;
  const timestamp = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(timestamp)) return null;
  return {
    timestamp,
    source: match[2] as ChapterVersionSource,
  };
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
