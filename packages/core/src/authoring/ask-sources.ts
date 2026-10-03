/** Persistent, complete source material for Ask candidates. SPDX-License-Identifier: AGPL-3.0-only */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { z } from "zod";
import { ingestMaterial } from "../materials/ingest.js";
import { safeChildPath } from "../utils/path-safety.js";
import { toPosixPath } from "../utils/posix-path.js";
import { authoringRootDir, loadManifest, type AuthoringStoreRoot } from "./store.js";

export const ASK_SOURCE_MAX_BYTES = 18 * 1024 * 1024;
export const ASK_SOURCE_MAX_CHARS = 120_000;
const SourceSchema = z.object({
  id: z.string(), filename: z.string(), originalPath: z.string(), textPath: z.string(),
  charCount: z.number().int().nonnegative(), createdAt: z.string(),
  coverage: z.literal("complete"),
  textSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type AskSource = z.infer<typeof SourceSchema>;

async function listLocalAskSources(root: AuthoringStoreRoot): Promise<AskSource[]> {
  const directory = join(authoringRootDir(root), "source-materials");
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(names.filter((name) => name.endsWith(".json")).sort()
    .map(async (name) => SourceSchema.parse(JSON.parse(await readFile(join(directory, name), "utf-8")))));
}

async function sourceRoots(root: AuthoringStoreRoot): Promise<AuthoringStoreRoot[]> {
  const draftId = root.bookId ? root.draftId ?? (await loadManifest(root)).draftId : undefined;
  return draftId ? [{ projectRoot: root.projectRoot, draftId }, root] : [root];
}

export async function listAskSources(root: AuthoringStoreRoot): Promise<AskSource[]> {
  const sources = (await Promise.all((await sourceRoots(root)).map(listLocalAskSources))).flat();
  return [...new Map(sources.map((source) => [source.id, source])).values()];
}

/** Originals survive parser failures and coverage limits; no chapter or adopted canon is changed. */
export async function importAskSource(root: AuthoringStoreRoot, input: {
  readonly filename: string; readonly bytes: Uint8Array;
}): Promise<AskSource> {
  if (!root.bookId && !root.draftId) throw new Error("请先打开一条问心，再导入资料。");
  if (input.bytes.byteLength > ASK_SOURCE_MAX_BYTES) throw new Error("每份资料最多 18 MB，请拆分后导入。");
  const filename = input.filename.replace(/[/\\\0]/g, "_").slice(0, 120) || "source.txt";
  if (![".txt", ".md", ".markdown", ".pdf", ".html", ".htm"].includes(extname(filename).toLowerCase())) {
    throw new Error("目前支持 TXT、Markdown、文字型 PDF 和 HTML。请将其他格式另存为这些格式后导入。");
  }
  const id = randomUUID();
  const uploadDirectory = join(root.projectRoot, ".inkos", "uploads", "ask", id);
  await mkdir(uploadDirectory, { recursive: true });
  const originalPath = toPosixPath(relative(root.projectRoot, join(uploadDirectory, filename)));
  await writeFile(join(root.projectRoot, originalPath), input.bytes, { flag: "wx" });
  try {
    const material = await ingestMaterial(root.projectRoot, {
      sourceKind: "file", filePath: originalPath, filename, purpose: "reference",
    });
    if (material.charCount === 0) throw new Error("没有提取到文字，请检查文件内容。");
    const existing = await listAskSources(root);
    const total = existing.reduce((sum, source) => sum + source.charCount, 0) + material.charCount;
    if (total > ASK_SOURCE_MAX_CHARS) {
      throw new Error(`本文件完整提取 ${material.charCount.toLocaleString("en-US")} 字符，连同已有资料共 ${total.toLocaleString("en-US")} 字符，超过每次整理 ${ASK_SOURCE_MAX_CHARS.toLocaleString("en-US")} 字符的资料上限。未截取开头，也未纳入正典依据；请拆分或精简资料后重试。`);
    }
    const directory = join(authoringRootDir(root), "source-materials");
    await mkdir(directory, { recursive: true });
    const extractedBytes = await readFile(safeChildPath(root.projectRoot, material.markdownPath));
    const source: AskSource = {
      id, filename, originalPath, textPath: material.markdownPath,
      charCount: material.charCount, coverage: "complete", createdAt: new Date().toISOString(),
      textSha256: createHash("sha256").update(extractedBytes).digest("hex"),
    };
    await writeFile(join(directory, `${id}.json`), `${JSON.stringify(source, null, 2)}\n`, { flag: "wx" });
    return source;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} 原始文件已保留：${originalPath}`);
  }
}

export async function removeAskSource(root: AuthoringStoreRoot, id: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("资料编号无效。");
  for (const sourceRoot of await sourceRoots(root)) {
    try { await unlink(join(authoringRootDir(sourceRoot), "source-materials", `${id}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function readAskSourceContext(root: AuthoringStoreRoot): Promise<Array<{ source: AskSource; text: string }>> {
  const sources = await listAskSources(root);
  const total = sources.reduce((sum, source) => sum + source.charCount, 0);
  if (total > ASK_SOURCE_MAX_CHARS) throw new Error(`问心资料共 ${total} 字符，超过 ${ASK_SOURCE_MAX_CHARS} 字符的完整读取上限。请先移除部分资料后整理；原文件仍保留。`);
  return Promise.all(sources.map(async (source) => ({
    source, text: await readVerifiedSource(root, source),
  })));
}

async function readVerifiedSource(root: AuthoringStoreRoot, source: AskSource): Promise<string> {
  try {
    const bytes = await readFile(safeChildPath(root.projectRoot, source.textPath));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const marker = "\n## Extracted content\n";
    const start = text.indexOf(marker);
    const content = start < 0 ? "" : text.slice(start + marker.length);
    // charCount is the entire normalized extracted body, without the generated metadata header.
    if (!content.trim() || content.length !== source.charCount
      || (source.textSha256 && createHash("sha256").update(bytes).digest("hex") !== source.textSha256)) {
      throw new Error("提取内容校验失败");
    }
    return text;
  } catch {
    throw new Error(`资料「${source.filename}」的提取副本缺失或损坏，已停止使用，未送入模型。请移除此资料后从原文件重新导入：${source.originalPath}`);
  }
}

/** Keep damaged records removable in the UI without claiming their contents were read completely. */
export async function inspectAskSources(root: AuthoringStoreRoot): Promise<Array<Omit<AskSource, "coverage"> & { coverage: "complete" | "invalid"; error?: string }>> {
  return Promise.all((await listAskSources(root)).map(async (source) => {
    try { await readVerifiedSource(root, source); return source; }
    catch (error) { return { ...source, coverage: "invalid" as const, error: error instanceof Error ? error.message : String(error) }; }
  }));
}
