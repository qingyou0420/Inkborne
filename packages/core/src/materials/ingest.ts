import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { safeChildPath } from "../utils/path-safety.js";
import { toPosixPath } from "../utils/posix-path.js";

export type MaterialPurpose = "reference" | "worldbuilding" | "script" | "storyboard" | "research" | "general";
export type MaterialSourceKind = "url" | "file";
export type MaterialKind = "webpage" | "pdf" | "text";

export interface IngestMaterialInput {
  readonly sourceKind: MaterialSourceKind;
  readonly url?: string;
  readonly filePath?: string;
  readonly filename?: string;
  readonly mimeType?: string;
  readonly title?: string;
  readonly purpose?: MaterialPurpose;
}

export interface MaterialAsset {
  readonly id: string;
  readonly title: string;
  readonly kind: MaterialKind;
  readonly purpose: MaterialPurpose;
  readonly source: string;
  readonly mimeType: string;
  readonly markdownPath: string;
  readonly manifestPath: string;
  readonly charCount: number;
  readonly excerpt: string;
  readonly totalPages?: number;
}

export interface IngestMaterialDeps {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

const MAX_SOURCE_BYTES = 18 * 1024 * 1024;
const EXCERPT_CHARS = 1600;

export async function ingestMaterial(
  projectRoot: string,
  input: IngestMaterialInput,
  deps: IngestMaterialDeps = {},
): Promise<MaterialAsset> {
  const now = deps.now?.() ?? new Date();
  const purpose = input.purpose ?? "reference";
  const source = await readMaterialSource(projectRoot, input, deps);
  const title = (input.title?.trim() || source.title || titleFromSource(input) || "material").slice(0, 120);
  const id = `${now.toISOString().replace(/[:.]/g, "-")}-${slug(title)}`;
  const materialsDir = join(projectRoot, ".inkos", "materials");
  await mkdir(materialsDir, { recursive: true });

  const markdown = renderMaterialMarkdown({
    title,
    kind: source.kind,
    purpose,
    source: source.source,
    mimeType: source.mimeType,
    totalPages: source.totalPages,
    text: source.text,
  });
  const markdownPathAbs = join(materialsDir, `${id}.md`);
  const manifestPathAbs = join(materialsDir, `${id}.json`);
  await writeFile(markdownPathAbs, markdown, "utf-8");
  const asset: MaterialAsset = {
    id,
    title,
    kind: source.kind,
    purpose,
    source: source.source,
    mimeType: source.mimeType,
    markdownPath: toPosixPath(relative(projectRoot, markdownPathAbs)),
    manifestPath: toPosixPath(relative(projectRoot, manifestPathAbs)),
    charCount: source.text.length,
    excerpt: source.text.slice(0, EXCERPT_CHARS),
    ...(source.totalPages !== undefined ? { totalPages: source.totalPages } : {}),
  };
  await writeFile(manifestPathAbs, JSON.stringify(asset, null, 2), "utf-8");
  return asset;
}

interface MaterialSource {
  readonly kind: MaterialKind;
  readonly source: string;
  readonly title?: string;
  readonly mimeType: string;
  readonly text: string;
  readonly totalPages?: number;
}

async function readMaterialSource(
  projectRoot: string,
  input: IngestMaterialInput,
  deps: IngestMaterialDeps,
): Promise<MaterialSource> {
  if (input.sourceKind === "url") {
    if (!input.url) throw new Error("ingest_material.url is required for URL sources.");
    return readUrlMaterial(input.url, deps.fetch ?? fetch);
  }
  if (!input.filePath) throw new Error("ingest_material.filePath is required for file sources.");
  const safePath = safeChildPath(projectRoot, input.filePath);
  const buffer = await readFile(safePath);
  if (buffer.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(`Material file is too large (${buffer.byteLength} bytes).`);
  }
  const filename = input.filename || basename(safePath);
  const mimeType = input.mimeType || mimeFromFilename(filename);
  return extractBufferMaterial(buffer, {
    source: toPosixPath(relative(projectRoot, safePath)),
    filename,
    mimeType,
  });
}

async function readUrlMaterial(url: string, fetchImpl: typeof fetch): Promise<MaterialSource> {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  const response = await fetchImpl(url, {
    headers: {
      "User-Agent": "InkOS/1.6 material-ingestion",
      "Accept": "text/html, text/plain, application/json, application/pdf, */*",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || mimeFromFilename(parsed.pathname);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(`Fetched material is too large (${buffer.byteLength} bytes).`);
  }
  return extractBufferMaterial(buffer, {
    source: url,
    filename: basename(parsed.pathname) || parsed.hostname,
    mimeType,
  });
}

async function extractBufferMaterial(
  buffer: Buffer,
  meta: { readonly source: string; readonly filename: string; readonly mimeType: string },
): Promise<MaterialSource> {
  const mimeType = meta.mimeType || mimeFromFilename(meta.filename);
  if (isPdf(meta.filename, mimeType)) {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const extracted = await extractText(pdf, { mergePages: true });
    const text = normalizeText(extracted.text);
    if (!text) throw new Error("PDF text extraction returned no text. Scanned PDFs require OCR and are not supported yet.");
    return {
      kind: "pdf",
      source: meta.source,
      title: stripExtension(meta.filename),
      mimeType: "application/pdf",
      text,
      totalPages: extracted.totalPages,
    };
  }
  const raw = decodeMaterialText(buffer, meta.filename);
  if (isHtml(meta.filename, mimeType)) {
    return {
      kind: "webpage",
      source: meta.source,
      title: extractHtmlTitle(raw) || stripExtension(meta.filename),
      mimeType,
      text: normalizeText(htmlToText(raw)),
    };
  }
  if (isTextLike(meta.filename, mimeType)) {
    return {
      kind: "text",
      source: meta.source,
      title: stripExtension(meta.filename),
      mimeType,
      text: normalizeText(raw),
    };
  }
  throw new Error(`Unsupported material type: ${mimeType || meta.filename}`);
}

/** Decode known Unicode encodings without replacing unreadable bytes with invented text. */
function decodeMaterialText(buffer: Buffer, filename: string): string {
  const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? "utf-16le"
    : buffer[0] === 0xfe && buffer[1] === 0xff ? "utf-16be"
      : "utf-8";
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
    if (text.includes("\0")) throw new Error("Unexpected NUL in text material");
    return text;
  } catch {
    throw new Error(`无法完整解码资料「${filename}」。支持 UTF-8 或带 BOM 的 UTF-16LE/BE；请将文件另存为 UTF-8 后重新导入。未用乱码替代原文。`);
  }
}

function renderMaterialMarkdown(input: {
  readonly title: string;
  readonly kind: MaterialKind;
  readonly purpose: MaterialPurpose;
  readonly source: string;
  readonly mimeType: string;
  readonly text: string;
  readonly totalPages?: number;
}): string {
  return [
    `# ${input.title}`,
    "",
    "## Metadata",
    `- kind: ${input.kind}`,
    `- purpose: ${input.purpose}`,
    `- source: ${input.source}`,
    `- mime_type: ${input.mimeType}`,
    input.totalPages !== undefined ? `- total_pages: ${input.totalPages}` : "",
    `- char_count: ${input.text.length}`,
    "",
    "## Extracted content",
    input.text,
    "",
  ].filter((line) => line !== "").join("\n");
}

function mimeFromFilename(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".json") return "application/json";
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".csv") return "text/csv";
  return "text/plain";
}

function isPdf(filename: string, mimeType: string): boolean {
  return mimeType.includes("pdf") || extname(filename).toLowerCase() === ".pdf";
}

function isHtml(filename: string, mimeType: string): boolean {
  const ext = extname(filename).toLowerCase();
  return mimeType.includes("html") || ext === ".html" || ext === ".htm";
}

function isTextLike(filename: string, mimeType: string): boolean {
  if (mimeType.startsWith("text/")) return true;
  if (mimeType.includes("json") || mimeType.includes("xml") || mimeType.includes("yaml")) return true;
  return [".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".yaml", ".yml", ".log"].includes(extname(filename).toLowerCase());
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function extractHtmlTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? decodeHtml(match[1]).trim().slice(0, 120) : undefined;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function normalizeText(value: string): string {
  return decodeHtml(value).replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripExtension(filename: string): string {
  const ext = extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

function titleFromSource(input: IngestMaterialInput): string | undefined {
  if (input.filename) return stripExtension(input.filename);
  if (input.filePath) return stripExtension(basename(input.filePath));
  if (!input.url) return undefined;
  try {
    const parsed = new URL(input.url);
    return stripExtension(basename(parsed.pathname)) || parsed.hostname;
  } catch {
    return undefined;
  }
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "material";
}
