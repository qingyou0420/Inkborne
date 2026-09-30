import { access, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { StudioShortContentKind, StudioShortDetail, StudioShortStatus, StudioShortSummary } from "../shared/short-works.js";
import { fanqieDownloadName, fanqieOptionsFromQuery, renderFanqieManuscript, zipFanqieFiles, type FanqieExportOptions } from "@actalk/inkos-core";
import { isSafeBookId } from "./safety.js";

export type { StudioShortContentKind, StudioShortDetail, StudioShortStatus, StudioShortSummary };

const MANUSCRIPT_CANDIDATES = [
  { relative: "final/full.md", kind: "manuscript" as const },
  { relative: "drafts/v002/full.md", kind: "draft" as const },
  { relative: "drafts/v001/full.md", kind: "draft" as const },
  { relative: "drafts/v001-partial/full.md", kind: "draft" as const },
  { relative: "outline/v002.md", kind: "outline" as const },
  { relative: "outline/v001.md", kind: "outline" as const },
] as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function resolveManuscript(
  root: string,
  storyId: string,
): Promise<{ readonly path: string; readonly kind: StudioShortContentKind } | undefined> {
  for (const candidate of MANUSCRIPT_CANDIDATES) {
    if (await fileExists(join(root, "shorts", storyId, candidate.relative))) {
      return { path: `shorts/${storyId}/${candidate.relative}`, kind: candidate.kind };
    }
  }
  return undefined;
}

function deriveStatus(
  snapshot: Record<string, unknown> | undefined,
  manuscriptKind: StudioShortContentKind | undefined,
): StudioShortStatus {
  if (stringField(snapshot, "status") === "failed") return "failed";
  if (manuscriptKind === "manuscript") return "completed";
  if (manuscriptKind === "draft") return "drafting";
  return "outlining";
}

async function loadShortSummary(root: string, storyId: string): Promise<StudioShortSummary | undefined> {
  if (!isSafeBookId(storyId)) return undefined;
  const baseDir = join(root, "shorts", storyId);
  const brief = await readJson(join(baseDir, "brief.json"));
  const snapshot = await readJson(join(baseDir, "status.json"));
  const manuscript = await resolveManuscript(root, storyId);
  if (!brief && !snapshot && !manuscript) return undefined;

  const coverRelative = "final/cover.png";
  const coverImagePath = await fileExists(join(baseDir, coverRelative))
    ? `shorts/${storyId}/${coverRelative}`
    : undefined;
  const createdAt = await resolveShortCreatedAt(brief, snapshot, baseDir);

  return {
    id: storyId,
    title: stringField(brief, "title") ?? stringField(snapshot, "id") ?? storyId,
    status: deriveStatus(snapshot, manuscript?.kind),
    stage: stringField(snapshot, "stage"),
    chapterCount: numberField(brief, "chapterCount"),
    ...(stringField(brief, "direction") ? { direction: stringField(brief, "direction") } : {}),
    manuscriptPath: manuscript?.path ?? `shorts/${storyId}`,
    ...(coverImagePath ? { coverImagePath } : {}),
    ...(createdAt ? { createdAt } : {}),
    kind: "short",
  };
}

async function resolveShortCreatedAt(
  brief: Record<string, unknown> | undefined,
  snapshot: Record<string, unknown> | undefined,
  baseDir: string,
): Promise<string | undefined> {
  const fromBrief = stringField(brief, "createdAt");
  if (fromBrief) return fromBrief;
  const fromSnapshot = stringField(snapshot, "startedAt");
  if (fromSnapshot) return fromSnapshot;
  try {
    const info = await stat(baseDir);
    const stamp = info.birthtimeMs > 0 ? info.birthtime : info.mtime;
    return stamp.toISOString();
  } catch {
    return undefined;
  }
}

/** Disk-only: shorts/<id>/ directories. Session/task artifacts are not a source. */
export async function listStudioShorts(root: string): Promise<StudioShortSummary[]> {
  let entries: string[] = [];
  try {
    const dirents = await readdir(join(root, "shorts"), { withFileTypes: true });
    entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }

  const shorts: StudioShortSummary[] = [];
  for (const storyId of entries) {
    const summary = await loadShortSummary(root, storyId);
    if (summary) shorts.push(summary);
  }
  shorts.sort((left, right) => left.title.localeCompare(right.title, "zh"));
  return shorts;
}

export async function loadStudioShort(root: string, storyId: string): Promise<StudioShortDetail | undefined> {
  const summary = await loadShortSummary(root, storyId);
  if (!summary) return undefined;
  const manuscript = await resolveManuscript(root, storyId);
  const content = manuscript
    ? await readFile(join(root, manuscript.path), "utf-8")
    : "";
  return {
    ...summary,
    content,
    contentKind: manuscript?.kind ?? "outline",
  };
}

function resolveShortDir(root: string, storyId: string): string {
  const shortsRoot = resolve(root, "shorts");
  const target = resolve(shortsRoot, storyId);
  const rel = relative(shortsRoot, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Refusing path outside shorts/: ${storyId}`);
  }
  return target;
}

/** Decode a shorts/:id path segment once (or twice if a client double-encoded Chinese ids). */
export function decodeStoryId(raw: string | undefined): string {
  const value = String(raw ?? "");
  try {
    const once = decodeURIComponent(value);
    if (once !== value && /%[0-9A-Fa-f]{2}/.test(once)) {
      try {
        return decodeURIComponent(once);
      } catch {
        return once;
      }
    }
    return once;
  } catch {
    return value;
  }
}

export async function deleteStudioShort(root: string, storyId: string): Promise<boolean> {
  if (!isSafeBookId(storyId)) return false;
  // Idempotent: a second delete (or a ghost whose folder is already gone) still succeeds.
  await rm(resolveShortDir(root, storyId), { recursive: true, force: true });
  return true;
}

export interface StudioShortUpdates {
  readonly title?: string;
  readonly chapterCount?: number;
  readonly direction?: string;
}

export async function updateStudioShort(
  root: string,
  storyId: string,
  updates: StudioShortUpdates,
): Promise<StudioShortSummary | undefined> {
  if (!isSafeBookId(storyId)) return undefined;
  const summary = await loadShortSummary(root, storyId);
  if (!summary) return undefined;

  const briefPath = join(resolveShortDir(root, storyId), "brief.json");
  const existing = await readJson(briefPath) ?? { storyId };
  const next: Record<string, unknown> = { ...existing, storyId };

  if (updates.title !== undefined) {
    const title = updates.title.trim();
    if (!title) throw new Error("title is required");
    next.title = title;
  }
  if (updates.chapterCount !== undefined) {
    if (!Number.isFinite(updates.chapterCount) || updates.chapterCount < 1) {
      throw new Error("chapterCount must be a positive number");
    }
    next.chapterCount = Math.round(updates.chapterCount);
  }
  if (updates.direction !== undefined) {
    next.direction = updates.direction.trim();
  }

  await writeFile(briefPath, JSON.stringify(next, null, 2), "utf-8");
  return loadShortSummary(root, storyId);
}

export interface StudioShortExportArtifact {
  readonly fileName: string;
  readonly contentType: string;
  readonly payload: string | Buffer;
  readonly contentKind: StudioShortContentKind;
}

export async function exportStudioShortManuscript(
  root: string,
  storyId: string,
  format: "txt" | "md",
  fanqie?: FanqieExportOptions,
): Promise<StudioShortExportArtifact | undefined> {
  const detail = await loadStudioShort(root, storyId);
  if (!detail) return undefined;
  if (!detail.content.trim()) {
    throw new Error("No manuscript to export");
  }
  if (format === "txt") {
    const options = fanqie ?? fanqieOptionsFromQuery({});
    const manuscript = renderFanqieManuscript({
      title: detail.title,
      markdown: detail.content,
      style: options,
      fromChapter: options.fromChapter,
      toChapter: options.toChapter,
    });
    if (options.layout === "per-chapter" && manuscript.numbered && manuscript.files.length > 1) {
      return {
        fileName: fanqieDownloadName(detail.title, "per-chapter"),
        contentType: "application/zip",
        payload: await zipFanqieFiles(manuscript.files),
        contentKind: detail.contentKind,
      };
    }
    const only = manuscript.files.length === 1 ? manuscript.files[0] : undefined;
    return {
      fileName: options.layout === "per-chapter" && only ? only.fileName : fanqieDownloadName(detail.title, "combined"),
      contentType: "text/plain; charset=utf-8",
      payload: options.layout === "per-chapter" && only ? only.text : manuscript.combined,
      contentKind: detail.contentKind,
    };
  }
  return {
    fileName: `${storyId}.md`,
    contentType: "text/markdown; charset=utf-8",
    payload: detail.content,
    contentKind: detail.contentKind,
  };
}

export interface StudioShortAnalytics {
  readonly bookId: string;
  readonly kind: "short";
  readonly totalChapters: number;
  readonly totalWords: number;
  readonly avgWordsPerChapter: number;
  readonly statusDistribution: Record<string, number>;
  readonly contentKind: StudioShortContentKind;
}

function countShortWords(content: string, language: string | undefined): number {
  const normalized = content.replace(/^#{1,6}\s+.+$/gm, "").trim();
  if (language === "en") {
    return normalized.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g)?.length ?? 0;
  }
  return normalized.replace(/\s+/g, "").length;
}

export async function computeStudioShortAnalytics(
  root: string,
  storyId: string,
): Promise<StudioShortAnalytics | undefined> {
  const detail = await loadStudioShort(root, storyId);
  if (!detail) return undefined;
  const brief = await readJson(join(root, "shorts", storyId, "brief.json"));
  const totalWords = countShortWords(detail.content, stringField(brief, "language"));
  const totalChapters = detail.chapterCount ?? 0;
  return {
    bookId: storyId,
    kind: "short",
    totalChapters,
    totalWords,
    avgWordsPerChapter: totalChapters > 0 ? Math.round(totalWords / totalChapters) : totalWords,
    statusDistribution: { [detail.status]: 1 },
    contentKind: detail.contentKind,
  };
}
