import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EPub } from "epub-gen-memory";
import JSZip from "jszip";
import {
  fanqieChapterFileName,
  fanqieDownloadName,
  fanqieOptionsFromQuery,
  renderFanqieChapter,
  singleChapterExportFileName,
  type FanqieChapterFile,
  type FanqieExportOptions,
} from "./fanqie-text.js";

export type BookExportFormat = "txt" | "md" | "epub";

export interface BookExportOptions extends FanqieExportOptions {
  readonly format?: BookExportFormat;
  readonly approvedOnly?: boolean;
  readonly outputPath?: string;
  /** Export this chapter only. Unlike from/to, this also narrows md and epub. */
  readonly onlyChapter?: number;
}

export interface ExportStateLike {
  readonly bookDir: (bookId: string) => string;
  readonly loadBookConfig: (bookId: string) => Promise<{ readonly title: string; readonly language?: string }>;
  readonly loadChapterIndex: (bookId: string) => Promise<ReadonlyArray<{
    readonly number: number;
    readonly title?: string;
    readonly status: string;
    readonly wordCount: number;
  }>>;
}

export interface ExportArtifact {
  readonly outputPath: string;
  readonly fileName: string;
  readonly chaptersExported: number;
  readonly totalWords: number;
  readonly format: BookExportFormat;
  readonly contentType: string;
  readonly payload: string | Buffer;
  readonly chapterFiles?: ReadonlyArray<FanqieChapterFile>;
}

export { fanqieOptionsFromQuery };

function buildChapterFileLookup(files: ReadonlyArray<string>): ReadonlyMap<number, string> {
  const lookup = new Map<number, string>();
  for (const file of files) {
    if (!file.endsWith(".md") || !/^\d{4}/.test(file)) {
      continue;
    }
    const chapterNumber = parseInt(file.slice(0, 4), 10);
    if (!lookup.has(chapterNumber)) {
      lookup.set(chapterNumber, file);
    }
  }
  return lookup;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function markdownToSimpleHtml(markdown: string): { title: string; html: string } {
  const title = markdown.match(/^#\s+(.+)/m)?.[1]?.trim() ?? "Untitled Chapter";
  const html = markdown
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("\n");
  return { title, html };
}

function selectChapters<T extends { readonly number: number; readonly status: string }>(
  index: ReadonlyArray<T>,
  options: BookExportOptions,
  format: BookExportFormat,
): T[] {
  const onlyChapter = options.onlyChapter;
  if (onlyChapter !== undefined) {
    if (!Number.isInteger(onlyChapter) || onlyChapter < 1) {
      throw new Error("章号得是正整数。");
    }
    const found = index.find((chapter) => chapter.number === onlyChapter);
    if (!found) {
      throw new Error(`第${onlyChapter}章还没有正文，不能导出。`);
    }
    if (options.approvedOnly && found.status !== "approved") {
      throw new Error(`第${onlyChapter}章还没通过。勾了「仅已通过」时，不能导出这一章。`);
    }
    return [found];
  }
  const approved = options.approvedOnly
    ? index.filter((chapter) => chapter.status === "approved")
    : [...index];
  if (format !== "txt") return approved;
  const fromChapter = options.fromChapter;
  const toChapter = options.toChapter;
  if (fromChapter !== undefined && toChapter !== undefined && fromChapter > toChapter) {
    throw new Error("起始章不能大于结束章。");
  }
  return approved.filter((chapter) => {
    if (fromChapter !== undefined && chapter.number < fromChapter) return false;
    if (toChapter !== undefined && chapter.number > toChapter) return false;
    return true;
  });
}

function singleChapterOutputPath(
  requested: string | undefined,
  fallbackDir: string,
  fileName: string,
  format: BookExportFormat,
): string {
  if (!requested) return join(fallbackDir, fileName);
  if (requested.toLowerCase().endsWith(`.${format}`)) return requested;
  return join(requested, fileName);
}

export async function buildExportArtifact(
  state: ExportStateLike,
  bookId: string,
  options: BookExportOptions = {},
): Promise<ExportArtifact> {
  const format = options.format ?? "txt";
  const index = await state.loadChapterIndex(bookId);
  const book = await state.loadBookConfig(bookId);
  const chapters = selectChapters(index, options, format);

  if (chapters.length === 0) {
    throw new Error(format === "txt" ? "没有可导出的章节。" : "No chapters to export.");
  }

  const bookDir = state.bookDir(bookId);
  const chaptersDir = join(bookDir, "chapters");
  const projectRoot = dirname(dirname(bookDir));
  const chapterFiles = buildChapterFileLookup(await readdir(chaptersDir));
  if (options.onlyChapter !== undefined && !chapterFiles.has(options.onlyChapter)) {
    throw new Error(`第${options.onlyChapter}章还没有正文，不能导出。`);
  }
  const singleName = options.onlyChapter !== undefined
    ? singleChapterExportFileName(book.title, chapters[0]?.number ?? options.onlyChapter, chapters[0]?.title ?? "", format)
    : undefined;
  const outputPath = singleName
    ? singleChapterOutputPath(options.outputPath, projectRoot, singleName, format)
    : (options.outputPath ?? join(projectRoot, `${bookId}_export.${format}`));
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);
  const fanqieOptions: BookExportOptions = options.onlyChapter !== undefined
    ? { ...options, layout: "combined" }
    : options;

  if (format === "txt") {
    return buildFanqieArtifact({
      bookTitle: book.title,
      chaptersDir,
      chapterFiles,
      chapters,
      options: fanqieOptions,
      outputPath,
      totalWords,
      downloadName: singleName,
    });
  }

  if (format === "epub") {
    const epubChapters: Array<{ title: string; content: string }> = [];
    for (const chapter of chapters) {
      const match = chapterFiles.get(chapter.number);
      if (!match) {
        continue;
      }
      const markdown = await readFile(join(chaptersDir, match), "utf-8");
      const { title, html } = markdownToSimpleHtml(markdown);
      epubChapters.push({ title, content: html });
    }
    const epubInstance = new EPub(
      { title: book.title, lang: book.language === "en" ? "en" : "zh-CN" },
      epubChapters,
    );
    return {
      outputPath,
      fileName: singleName ?? `${bookId}.epub`,
      chaptersExported: chapters.length,
      totalWords,
      format,
      contentType: "application/epub+zip",
      payload: await epubInstance.genEpub(),
    };
  }

  const parts: string[] = [];
  parts.push(format === "md" ? `# ${book.title}\n\n---\n` : `${book.title}\n\n`);
  for (const chapter of chapters) {
    const match = chapterFiles.get(chapter.number);
    if (!match) {
      continue;
    }
    parts.push(await readFile(join(chaptersDir, match), "utf-8"));
    parts.push("\n\n");
  }

  return {
    outputPath,
    fileName: singleName ?? `${bookId}.${format}`,
    chaptersExported: chapters.length,
    totalWords,
    format,
    contentType: format === "md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
    payload: parts.join(format === "md" ? "\n---\n\n" : "\n"),
  };
}

async function buildFanqieArtifact(input: {
  readonly bookTitle: string;
  readonly chaptersDir: string;
  readonly chapterFiles: ReadonlyMap<number, string>;
  readonly chapters: ReadonlyArray<{ readonly number: number; readonly title?: string; readonly wordCount: number }>;
  readonly options: BookExportOptions;
  readonly outputPath: string;
  readonly totalWords: number;
  readonly downloadName?: string;
}): Promise<ExportArtifact> {
  const layout = input.options.layout === "per-chapter" ? "per-chapter" : "combined";
  const style = { blankLine: input.options.blankLine, indent: input.options.indent };
  const files: FanqieChapterFile[] = [];
  const chapterTexts: string[] = [];
  for (const chapter of input.chapters) {
    const match = input.chapterFiles.get(chapter.number);
    if (!match) continue;
    const markdown = await readFile(join(input.chaptersDir, match), "utf-8");
    const text = renderFanqieChapter({
      chapterNumber: chapter.number,
      title: chapter.title,
      markdown,
      style,
    }).trim();
    if (!text) continue;
    chapterTexts.push(text);
    files.push({
      fileName: fanqieChapterFileName(chapter.number, chapter.title || text.split("\n")[0] || ""),
      text: `${text}\n`,
    });
  }
  if (files.length === 0) {
    throw new Error("没有可导出的章节。");
  }
  const downloadName = input.downloadName ?? fanqieDownloadName(input.bookTitle, layout);
  const bookTitle = input.bookTitle.trim();
  const firstLine = chapterTexts[0]?.split("\n")[0]?.trim() ?? "";
  if (layout === "per-chapter") {
    const directory = input.options.outputPath && !input.options.outputPath.endsWith(".zip")
      ? input.options.outputPath
      : input.outputPath;
    return {
      outputPath: directory,
      fileName: downloadName,
      chaptersExported: files.length,
      totalWords: input.totalWords,
      format: "txt",
      contentType: "application/zip",
      payload: await zipFanqieFiles(files),
      chapterFiles: files,
    };
  }
  const combined = (bookTitle && bookTitle !== firstLine ? [bookTitle, ...chapterTexts] : chapterTexts).join("\n\n");
  return {
    outputPath: input.outputPath,
    fileName: downloadName,
    chaptersExported: files.length,
    totalWords: input.totalWords,
    format: "txt",
    contentType: "text/plain; charset=utf-8",
    payload: `${combined.trim()}\n`,
    chapterFiles: files,
  };
}

export async function writeExportArtifact(
  state: ExportStateLike,
  bookId: string,
  options: BookExportOptions = {},
): Promise<Omit<ExportArtifact, "payload" | "contentType" | "fileName" | "chapterFiles">> {
  const artifact = await buildExportArtifact(state, bookId, options);
  if (
    options.onlyChapter === undefined
    && artifact.format === "txt"
    && options.layout === "per-chapter"
    && artifact.chapterFiles
    && options.outputPath
    && !options.outputPath.endsWith(".zip")
  ) {
    await writeChapterDirectory(options.outputPath, artifact.chapterFiles);
    return {
      outputPath: options.outputPath,
      chaptersExported: artifact.chaptersExported,
      totalWords: artifact.totalWords,
      format: artifact.format,
    };
  }
  await mkdir(dirname(artifact.outputPath), { recursive: true });
  await writeFile(artifact.outputPath, artifact.payload);
  return {
    outputPath: artifact.outputPath,
    chaptersExported: artifact.chaptersExported,
    totalWords: artifact.totalWords,
    format: artifact.format,
  };
}

export async function zipFanqieFiles(files: ReadonlyArray<FanqieChapterFile>): Promise<Buffer> {
  const zip = new JSZip();
  for (const file of files) zip.file(file.fileName, file.text);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function writeChapterDirectory(dir: string, files: ReadonlyArray<FanqieChapterFile>): Promise<void> {
  await mkdir(dir, { recursive: true });
  const existing = await readdir(dir).catch(() => [] as string[]);
  for (const name of existing) {
    if (name.endsWith(".txt")) await unlink(join(dir, name));
  }
  for (const file of files) {
    await writeFile(join(dir, file.fileName), file.text, "utf-8");
  }
}
