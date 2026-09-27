/**
 * Keep chapters/index.json in sync when 落笔 adopts a chapter.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ChapterMetaSchema, type ChapterMeta, type ChapterStatus } from "../models/chapter.js";
import { archiveChapterVersion } from "../state/chapter-workspace.js";
import { commitAtomicFileSet, type AtomicFileWrite } from "../utils/atomic-file-set.js";

function chapterFileName(chapterNumber: number, title: string): string {
  const safe = title.replace(/[^\w\u4e00-\u9fff]+/g, "-").slice(0, 20) || "chapter";
  return `${String(chapterNumber).padStart(4, "0")}_${safe}.md`;
}

function wordCount(body: string): number {
  return body.replace(/\s+/g, "").length;
}

async function rebuildIndexFromFiles(bookDir: string): Promise<ChapterMeta[]> {
  const chaptersDir = join(bookDir, "chapters");
  let files: string[];
  try {
    files = await readdir(chaptersDir);
  } catch {
    return [];
  }
  const rows = await Promise.all(files.flatMap(async (file) => {
    const match = file.match(/^(\d+)[_-]?(.*?)\.md$/);
    if (!match || file === "index.json") return [];
    const number = parseInt(match[1]!, 10);
    if (!Number.isFinite(number) || number <= 0) return [];
    const filePath = join(chaptersDir, file);
    const [metadata, content] = await Promise.all([
      stat(filePath).catch(() => null),
      readFile(filePath, "utf-8").catch(() => ""),
    ]);
    const timestamp = (metadata?.mtime ?? new Date()).toISOString();
    const rawTitle = match[2]?.replace(/^_+/, "").replace(/_/g, " ").trim();
    return [{
      number,
      title: rawTitle || `第${number}章`,
      status: "ready-for-review" as const,
      wordCount: content.replace(/\s+/g, "").length,
      createdAt: timestamp,
      updatedAt: timestamp,
      auditIssues: [],
      lengthWarnings: [],
    }];
  }));
  const byNumber = new Map<number, ChapterMeta>();
  for (const row of rows.flat()) {
    const existing = byNumber.get(row.number);
    if (!existing || row.updatedAt >= existing.updatedAt) byNumber.set(row.number, row);
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

async function readIndex(bookDir: string): Promise<ChapterMeta[]> {
  try {
    const raw = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8")) as unknown;
    if (Array.isArray(raw) && raw.length > 0) {
      const parsed = raw.flatMap((item) => {
        const result = ChapterMetaSchema.safeParse(item);
        return result.success ? [result.data] : [];
      });
      if (parsed.length > 0) return parsed;
    }
  } catch {
    /* missing or invalid index */
  }
  return rebuildIndexFromFiles(bookDir);
}

export async function persistAdoptedChapter(input: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly body: string;
  readonly relativePath?: string;
  readonly status?: ChapterStatus;
  readonly auditIssues?: readonly string[];
  readonly lengthWarnings?: readonly string[];
  readonly extraWrites?: ReadonlyArray<AtomicFileWrite>;
  readonly renameFile?: (from: string, to: string) => Promise<void>;
}): Promise<{ relativePath: string; index: ReadonlyArray<ChapterMeta> }> {
  const chaptersDir = join(input.bookDir, "chapters");
  await mkdir(chaptersDir, { recursive: true });
  const relativePath = input.relativePath?.startsWith("chapters/")
    ? input.relativePath
    : `chapters/${chapterFileName(input.chapterNumber, input.title)}`;
  const destName = relativePath.slice("chapters/".length);
  const padded = String(input.chapterNumber).padStart(4, "0");
  const files = await readdir(chaptersDir).catch(() => [] as string[]);
  const existingFiles = files.filter((file) => file.startsWith(`${padded}_`) && file.endsWith(".md"));
  const replaced: string[] = [];
  for (const file of existingFiles) {
    let previous: string;
    try {
      previous = await readFile(join(chaptersDir, file), "utf-8");
    } catch (error) {
      throw new Error(`无法读取原章节「${file}」，采用已停止。${error instanceof Error ? error.message : String(error)}`);
    }
    if (!previous.trim()) continue;
    try {
      await archiveChapterVersion(input.bookDir, input.chapterNumber, previous, "revision");
    } catch (error) {
      throw new Error(`无法归档原章节「${file}」，采用已停止。${error instanceof Error ? error.message : String(error)}`);
    }
    replaced.push(file);
  }
  const body = input.body.endsWith("\n") ? input.body : `${input.body}\n`;
  const now = new Date().toISOString();
  const existing = await readIndex(input.bookDir);
  const entry: ChapterMeta = {
    number: input.chapterNumber,
    title: input.title || `第${input.chapterNumber}章`,
    status: input.status ?? "ready-for-review",
    wordCount: wordCount(input.body),
    createdAt: existing.find((item) => item.number === input.chapterNumber)?.createdAt ?? now,
    updatedAt: now,
    auditIssues: [...(input.auditIssues ?? [])],
    lengthWarnings: [...(input.lengthWarnings ?? [])],
  };
  const index = existing.some((item) => item.number === input.chapterNumber)
    ? existing.map((item) => item.number === input.chapterNumber ? { ...entry, createdAt: item.createdAt } : item)
    : [...existing, entry].sort((a, b) => a.number - b.number);
  const writes: AtomicFileWrite[] = [
    { relativePath, content: body },
    { relativePath: "chapters/index.json", content: `${JSON.stringify(index, null, 2)}\n` },
    ...(input.extraWrites ?? []).filter((item) => item.relativePath !== relativePath && item.relativePath !== "chapters/index.json"),
  ];
  await commitAtomicFileSet({
    rootDir: input.bookDir,
    writes,
    ...(input.renameFile ? { renameFile: input.renameFile } : {}),
  });
  for (const file of replaced) {
    if (file === destName) continue;
    await unlink(join(chaptersDir, file)).catch(() => undefined);
  }
  return { relativePath, index };
}

export function resolveChapterDisplayTitle(input: {
  readonly storedTitle?: string;
  readonly indexTitle?: string;
  readonly label?: string;
  readonly bodyPath?: string;
  readonly chapterNumber: number;
}): string {
  const stored = input.storedTitle?.trim();
  if (stored) return stored;
  const indexed = input.indexTitle?.trim();
  if (indexed) return indexed;
  const fromLabel = (input.label ?? "")
    .replace(/^第\s*\d+\s*章\s*/, "")
    .replace(/候选.*$/, "")
    .replace(/\s*v\d+$/i, "")
    .trim();
  if (fromLabel && !/^(手改|候选|恢复)$/.test(fromLabel)) return fromLabel;
  const fromFile = titleFromChapterFileName(input.bodyPath ?? "");
  if (fromFile) return fromFile;
  return `第${input.chapterNumber}章`;
}

export function titleFromChapterFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? "";
  const match = /^(\d+)_(.+)\.md$/i.exec(base);
  const raw = match?.[2]?.replace(/-/g, " ").trim() ?? "";
  return raw && raw !== "chapter" ? raw : "";
}

export async function findChapterRelativePath(
  bookDir: string,
  chapterNumber: number,
): Promise<{ relativePath: string; title: string } | undefined> {
  const padded = String(chapterNumber).padStart(4, "0");
  const chaptersDir = join(bookDir, "chapters");
  let files: string[] = [];
  try {
    files = await readdir(chaptersDir);
  } catch {
    return undefined;
  }
  const match = files.find((file) => file.startsWith(`${padded}_`) && file.endsWith(".md"));
  if (!match) return undefined;
  const index = await readIndex(bookDir);
  const titled = index.find((item) => item.number === chapterNumber)?.title?.trim();
  return {
    relativePath: `chapters/${match}`,
    title: titled || titleFromChapterFileName(match) || `第${chapterNumber}章`,
  };
}

export { chapterFileName };
