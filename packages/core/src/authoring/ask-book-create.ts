/**
 * Create a book with an unadopted Ask candidate, without running later stages.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { BookConfigSchema, type BookConfig } from "../models/book.js";
import type { ProjectConfig } from "../models/project.js";
import { deriveBookIdFromTitle } from "../utils/book-id.js";
import { serializeCanon } from "./canon.js";
import { generateAskCanon } from "./stages/ask.js";
import { loadArtifact, loadManifest, loadRun, saveArtifact, saveManifest, saveRun } from "./store.js";
import type { AuthoringLlmFn } from "./types.js";

export interface AskBookCreateInput {
  readonly projectRoot: string;
  readonly project: ProjectConfig;
  readonly conversation: string;
  readonly requirements?: string;
  readonly book: {
    readonly title: string;
    readonly genre?: string;
    readonly platform?: BookConfig["platform"];
    readonly language?: "zh" | "en";
    readonly targetChapters?: number;
    readonly chapterWordCount?: number;
  };
  readonly llm?: AuthoringLlmFn;
  readonly signal?: AbortSignal;
}

export interface AskBookCreateResult {
  readonly bookId: string;
  readonly bookDir: string;
  readonly artifactId: string;
  readonly runId: string;
}

const pendingCreations = new Set<string>();

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("已取消建书，未发布书籍。", "AbortError");
}

async function assertBookAbsent(projectRoot: string, bookId: string, title: string): Promise<void> {
  const booksDir = join(projectRoot, "books");
  try {
    await lstat(join(booksDir, bookId));
    throw new Error(`已存在同名作品或目录「${title}」，未覆盖原内容。`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let entries;
  try { entries = await readdir(booksDir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let existing: { title?: unknown };
    try { existing = JSON.parse(await readFile(join(booksDir, entry.name, "book.json"), "utf-8")); }
    catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (existing && typeof existing.title === "string" && existing.title.trim().toLowerCase() === title.toLowerCase()) {
      throw new Error(`已存在同名作品「${title}」，未覆盖原内容。`);
    }
  }
}

export async function createAskBookCandidate(input: AskBookCreateInput): Promise<AskBookCreateResult> {
  if (!isAbsolute(input.projectRoot)) throw new Error("建书必须提供明确的绝对项目路径。");
  assertNotAborted(input.signal);
  const projectRoot = resolve(input.projectRoot);
  const title = input.book.title.trim();
  const bookId = deriveBookIdFromTitle(title) || `book-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const book = BookConfigSchema.parse({
    id: bookId,
    title,
    genre: input.book.genre?.trim() || "未分类",
    platform: input.book.platform ?? "other",
    language: input.book.language ?? "zh",
    status: "incubating",
    targetChapters: input.book.targetChapters,
    chapterWordCount: input.book.chapterWordCount,
    writing: { reviewMode: "manual" },
    createdAt: now,
    updatedAt: now,
  });
  const bookDir = join(projectRoot, "books", bookId);
  const key = bookDir.toLowerCase();
  if (pendingCreations.has(key)) throw new Error(`「${title}」正在建书，请等待当前任务完成。`);
  pendingCreations.add(key);
  // Use a draft beneath the real project root so generation resolves the
  // configured Ask credentials, rather than looking for keys in a fake root.
  const stagingParent = join(projectRoot, ".inkos", "authoring-drafts");
  let stagingDir: string | undefined;
  try {
    await assertBookAbsent(projectRoot, bookId, title);
    await mkdir(stagingParent, { recursive: true });
    stagingDir = await mkdtemp(join(stagingParent, "ask-create-"));
    const root = { projectRoot, draftId: basename(stagingDir) };
    const constraints = [
      `作者已确认书名：${title}。不得自行更改。`,
      input.book.genre ? `作者已确认题材：${input.book.genre}。` : "",
      input.book.platform ? `作者已确认平台：${input.book.platform}。` : "",
      input.book.targetChapters !== undefined
        ? `作者已确认目标章数：${input.book.targetChapters}。不得缩减或自行待定。`
        : "确认卡未填写目标章数不代表作者未确认。请从完整原始讨论提取作者最新明确确认的目标章数；仅当原文确实未确认或作者最新明确要求待定时，targetChapters 使用 null，不要自行决定。",
      input.book.chapterWordCount !== undefined
        ? `作者已确认每章字数：${input.book.chapterWordCount}。不得缩减或自行待定。`
        : "确认卡未填写每章字数不代表作者未确认。请从完整原始讨论提取作者最新明确确认的每章字数；仅当原文确实未确认或作者最新明确要求待定时，chapterWordCount 使用 null，不要自行决定。",
      input.requirements ?? "",
    ].filter(Boolean).join("\n");
    assertNotAborted(input.signal);
    const generated = await generateAskCanon({
      root, project: input.project, conversation: input.conversation,
      requirements: constraints, llm: input.llm,
    });
    assertNotAborted(input.signal);
    const artifact = await loadArtifact(root, generated.artifactId);
    const run = await loadRun(root, generated.runId);
    if (!artifact || !run) throw new Error("问心生成记录不完整，未创建书籍。");
    const canon = {
      ...generated.canon,
      title,
      genre: input.book.genre?.trim() || generated.canon.genre,
      targetChapters: input.book.targetChapters ?? generated.canon.targetChapters,
      chapterWordCount: input.book.chapterWordCount ?? generated.canon.chapterWordCount,
    };
    await saveArtifact(root, { ...artifact.meta, status: "candidate" }, serializeCanon(canon));
    const manifest = await loadManifest(root);
    await saveManifest(root, { ...manifest, bookId, draftId: undefined });
    await saveRun(root, { ...run, bookId, draftId: undefined });
    const storyDir = join(stagingDir, "story");
    await mkdir(storyDir);
    await rename(join(stagingDir, "workflow"), join(storyDir, "workflow"));
    await mkdir(join(stagingDir, "chapters"));
    const originalIntent = [
      "# 问心原始材料", "", "## 完整对话", "", input.conversation,
      "", "## 确认建书要求", "", input.requirements ?? "",
      "", "## 已确认的书籍信息", "", JSON.stringify(input.book, null, 2), "",
    ].join("\n");
    await writeFile(join(storyDir, "author_intent.md"), originalIntent, "utf-8");
    await writeFile(join(storyDir, "brief.md"), originalIntent, "utf-8");
    await writeFile(join(storyDir, "workflow.json"), `${JSON.stringify({ lastStage: "ask" }, null, 2)}\n`, "utf-8");
    await writeFile(join(stagingDir, "book.json"), `${JSON.stringify({
      ...book,
      genre: canon.genre || book.genre,
      targetChapters: canon.targetChapters ?? book.targetChapters,
      chapterWordCount: canon.chapterWordCount ?? book.chapterWordCount,
    }, null, 2)}\n`, "utf-8");
    await writeFile(join(stagingDir, "chapters", "index.json"), "[]\n", "utf-8");
    await mkdir(join(projectRoot, "books"), { recursive: true });
    await assertBookAbsent(projectRoot, bookId, title);
    assertNotAborted(input.signal);
    await rename(stagingDir, bookDir);
    stagingDir = undefined;
    return { bookId, bookDir, artifactId: generated.artifactId, runId: generated.runId };
  } finally {
    try {
      if (stagingDir) {
        // Only remove the exact temporary child created by this invocation.
        if (dirname(resolve(stagingDir)) !== resolve(stagingParent) || !basename(stagingDir).startsWith("ask-create-")) {
          throw new Error("临时建书目录不在预期位置，已停止清理。");
        }
        await rm(stagingDir, { recursive: true, force: true });
      }
    } finally {
      pendingCreations.delete(key);
    }
  }
}
