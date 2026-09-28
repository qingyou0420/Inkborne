/**
 * 落笔: chapter draft, review, revise-from-report, adopt with state settle.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { join } from "node:path";
import { persistAdoptedChapter, chapterFileName, findChapterRelativePath, resolveChapterDisplayTitle, titleFromChapterFileName } from "../chapter-index.js";
import { writeFileAtomic } from "../../utils/atomic-write.js";
import { withBookWriteLock } from "../book-lock.js";
import {
  assembleAuthoringContext,
  invalidateChapterState,
  isLightweightAuthoringBook,
  loadBookJson,
  loadCanonDocument,
  loadChapterText,
  loadOutlineText,
  resolvePlannedChapterTitle,
  writeChapterState,
} from "../context.js";
import { composeWriteSystemPrompt } from "../write-system-prompt.js";
import { collapseDuplicateChapterHeadings, ensureSingleChapterHeading } from "../chapter-heading.js";
import { findChapterNode, parseVolumeMapTree } from "../../utils/volume-map-tree.js";
import { completeRole, completeRoleObserved } from "../llm.js";
import { fillMissingAuthoringRoles, loadRoleApiKeys, resolveAuthoringRole } from "../model-config.js";
import { collectWriteReviewChecks, formatChecksForPrompt } from "../review-checks.js";
import { assertReportReusable, mergeDeterministicIssues, parseReviewPayload, requestReviewModelText, reviewPrompt } from "../review.js";
import {
  applyChapterMemory,
  chapterLengthNote,
  chapterMemoryFromSettle,
  countChapterChars,
  loadSerialLedger,
  parseSettleNote,
  SerialLedgerSchema,
} from "../serial-ledger.js";
import { StateManager } from "../../state/manager.js";
import {
  AuthoringRunCancelledError,
  listRuns,
  loadArtifact,
  listReports,
  loadManifest,
  loadReport,
  loadRun,
  newArtifactId,
  newRunId,
  renderManifest,
  saveArtifact,
  saveHandEditedArtifact,
  saveManifest,
  saveReport,
  saveRun,
  throwIfRunCancelled,
  type AuthoringStoreRoot,
} from "../store.js";
import {
  AuthoringArtifactMetaSchema,
  AuthoringRunRecordSchema,
  type AuthoringArtifactMeta,
  type AuthoringLlmFn,
  type AuthoringReviewReport,
  type AuthoringRunRecord,
  type AuthoringTokenUsage,
  type ReviewIssue,
} from "../types.js";
import { usageFromUnknown } from "../token-usage.js";
import { redactSecrets } from "../../utils/redact-secrets.js";
import type { z } from "zod";
import type { ProjectConfig } from "../../models/project.js";

/** Upstream failed after some chapter text was already saved as a candidate. */
export class SavedPartialDraftError extends Error {
  readonly artifactId: string;
  readonly saved = true;

  constructor(message: string, artifactId: string) {
    super(message);
    this.name = "SavedPartialDraftError";
    this.artifactId = artifactId;
  }
}

export interface WriteRuntime {
  readonly root: AuthoringStoreRoot;
  readonly project: ProjectConfig;
  readonly llm?: AuthoringLlmFn;
}

export interface WriteDraftResult {
  readonly artifactId: string;
  readonly runId: string;
  readonly body: string;
  readonly wordCount: number;
  readonly status: "completed" | "cancelled";
  readonly targetWordCount?: number;
  readonly lengthNote?: string;
  readonly usage?: AuthoringTokenUsage;
}

const activeWriteRuns = new Map<string, AbortController>();

/** Stop an in-flight 落笔 generate/revise. No-op if that run is not writing. */
export function requestWriteRunCancel(runId: string): boolean {
  const controller = activeWriteRuns.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

function mergeAbort(lockSignal: AbortSignal, local: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  for (const signal of [lockSignal, local]) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

function isStop(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof AuthoringRunCancelledError) return true;
  return error instanceof Error && error.name === "AbortError";
}

async function resolve(project: ProjectConfig, role: "write.main" | "write.review", projectRoot?: string) {
  return resolveAuthoringRole({
    roleId: role,
    baseLlm: project.llm,
    roles: fillMissingAuthoringRoles(project),
    apiKeys: projectRoot ? await loadRoleApiKeys(projectRoot) : undefined,
  });
}

function draftResult(input: {
  readonly body: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly status: "completed" | "cancelled";
  readonly targetWordCount?: number;
  readonly usage?: AuthoringTokenUsage;
}): WriteDraftResult {
  const wordCount = countChapterChars(input.body);
  const lengthNote = chapterLengthNote(wordCount, input.targetWordCount);
  return {
    artifactId: input.artifactId,
    runId: input.runId,
    body: input.body,
    wordCount,
    status: input.status,
    ...(input.targetWordCount ? { targetWordCount: input.targetWordCount } : {}),
    ...(lengthNote ? { lengthNote } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
  };
}

async function rememberCandidate(
  root: AuthoringStoreRoot,
  chapterNumber: number,
  artifactId: string,
  runId: string,
): Promise<void> {
  const manifest = await loadManifest(root);
  await saveManifest(root, {
    ...manifest,
    candidates: {
      ...manifest.candidates,
      write: { ...manifest.candidates.write, [String(chapterNumber)]: artifactId },
    },
    lastRunId: runId,
  });
}

async function persistWriteRun(
  root: AuthoringStoreRoot,
  run: Omit<z.input<typeof AuthoringRunRecordSchema>, "updatedAt"> & { updatedAt?: string },
  onProgress?: (run: AuthoringRunRecord) => void,
): Promise<void> {
  await saveRun(root, { ...run, updatedAt: run.updatedAt ?? new Date().toISOString() });
  const saved = await loadRun(root, run.runId);
  if (saved) onProgress?.(saved);
}

async function persistFailedWriteRun(
  root: AuthoringStoreRoot,
  run: Omit<z.input<typeof AuthoringRunRecordSchema>, "updatedAt"> & { updatedAt?: string },
  cause: unknown,
  onProgress?: (run: AuthoringRunRecord) => void,
): Promise<void> {
  try {
    await persistWriteRun(root, run, onProgress);
  } catch (persistError) {
    const wrapped = cause instanceof Error ? cause : new Error(String(cause));
    (wrapped as Error & { persistError?: unknown }).persistError = persistError;
    throw wrapped;
  }
}

async function assertPreviousSettleIdle(root: AuthoringStoreRoot, chapterNumber: number): Promise<void> {
  if (chapterNumber <= 1) return;
  const previousSettle = (await listRuns(root)).find((run) => (
    run.stage === "write"
    && run.scope === `chapter:${chapterNumber - 1}`
    && run.operation === "settle"
    && (run.status === "running" || run.status === "pausing")
  ));
  if (previousSettle) {
    throw new Error(`正在整理第 ${chapterNumber - 1} 章状态，完成后可写下一章。`);
  }
}

async function assertWriteReady(root: AuthoringStoreRoot, chapterNumber: number, bookDir: string): Promise<void> {
  await assertPreviousSettleIdle(root, chapterNumber);
  if (!(await isLightweightAuthoringBook(bookDir))) return;
  const currentManifest = await loadManifest(root);
  if (!currentManifest.adopted.weave) {
    throw new Error("请先到织卷生成并采用分卷与本章规划，再自动写正文。");
  }
  const outline = await loadOutlineText(root);
  const node = findChapterNode(parseVolumeMapTree(outline), chapterNumber);
  if (!node?.summary?.trim() || node.summary.trim() === "（待补概要）") {
    throw new Error(`第 ${chapterNumber} 章还没有已采用的织卷概要，请先到织卷生成并采用本章规划。`);
  }
}

/**
 * Streams one chapter call. The book lock is held by the caller and released
 * when this returns. A stopped draft is saved in one atomic write, or not at
 * all if nothing was written yet.
 */
async function streamChapterText(input: {
  readonly root: AuthoringStoreRoot;
  readonly projectLlm?: AuthoringLlmFn;
  readonly resolved: Awaited<ReturnType<typeof resolve>>;
  readonly prompt: string;
  readonly lockSignal: AbortSignal;
  readonly operation: "generate" | "revise";
  readonly chapterNumber: number;
  readonly title?: string;
  readonly targetWordCount?: number;
  readonly runId?: string;
  readonly onRunStart?: (runId: string) => void | Promise<void>;
  readonly onProgress?: (run: AuthoringRunRecord) => void;
  readonly onTextDelta?: (delta: string) => void | Promise<void>;
  readonly meta: (runId: string) => Omit<AuthoringArtifactMeta, "artifactId">;
}): Promise<WriteDraftResult> {
  const runId = input.runId ?? newRunId();
  const local = new AbortController();
  activeWriteRuns.set(runId, local);
  const signal = mergeAbort(input.lockSignal, local.signal);
  const createdAt = new Date().toISOString();
  const voice = await loadCanonDocument(input.root).then((doc) => doc.canon.voice).catch(() => "");
  const system = composeWriteSystemPrompt(input.resolved.instructions, voice);
  let streamed = "";
  const baseRun = {
    runId,
    stage: "write" as const,
    operation: input.operation,
    roleId: "write.main" as const,
    bookId: input.root.bookId,
    scope: `chapter:${input.chapterNumber}`,
    progressDone: 0,
    progressTotal: 1,
    progressLabel: input.operation === "revise"
      ? "正在按意见修改正文"
      : `正在写第 ${input.chapterNumber} 章`,
    modelSnapshot: input.resolved.snapshot,
    producedArtifactIds: [] as string[],
    createdAt,
    updatedAt: createdAt,
  };
  try {
    await input.onRunStart?.(runId);
    await persistWriteRun(input.root, { ...baseRun, status: "running" }, input.onProgress);
    await throwIfRunCancelled(input.root, runId);
    if (signal.aborted) {
      await persistWriteRun(input.root, { ...baseRun, status: "cancelled", progressLabel: "还没写出字就停下了" }, input.onProgress);
      return draftResult({ body: "", runId, artifactId: "", status: "cancelled", targetWordCount: input.targetWordCount });
    }
    let observed: { content: string; usage?: AuthoringTokenUsage };
    try {
      observed = await completeRoleObserved(input.resolved, input.prompt, {
        llm: input.projectLlm,
        signal,
        system,
        onTextDelta: (delta) => {
          streamed += delta;
          return input.onTextDelta?.(delta);
        },
      });
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      const carried = usageFromUnknown(error);
      const partial = streamed.trim();
      if (!isStop(error, signal)) {
        if (!partial) {
          const bare = new Error(message);
          (bare as Error & { saved?: boolean }).saved = false;
          await persistFailedWriteRun(input.root, {
            ...baseRun,
            status: "failed",
            error: message,
            progressLabel: `第 ${input.chapterNumber} 章未写成`,
            ...(carried ? { usage: carried } : {}),
          }, bare, input.onProgress);
          throw bare;
        }
        const body = ensureSingleChapterHeading(streamed, { chapterNumber: input.chapterNumber, title: input.title });
        const artifactId = newArtifactId("write", `ch${input.chapterNumber}`);
        const meta = input.meta(runId);
        await saveArtifact(input.root, {
          ...meta,
          artifactId,
          label: meta.label ? `${meta.label}（写到一半断了）` : "写到一半断了",
        }, body);
        await rememberCandidate(input.root, input.chapterNumber, artifactId, runId);
        const partialError = new SavedPartialDraftError(message, artifactId);
        await persistFailedWriteRun(input.root, {
          ...baseRun,
          status: "failed",
          producedArtifactIds: [artifactId],
          error: message,
          progressLabel: "写到一半上游断了，已留下的字在候选稿里",
          ...(carried ? { usage: carried } : {}),
        }, partialError, input.onProgress);
        throw partialError;
      }
      if (!partial) {
        await persistWriteRun(input.root, {
          ...baseRun,
          status: "cancelled",
          ...(carried ? { usage: carried } : {}),
          progressLabel: "还没写出字就停下了",
        }, input.onProgress);
        return draftResult({ body: "", runId, artifactId: "", status: "cancelled", targetWordCount: input.targetWordCount, usage: carried });
      }
      const body = ensureSingleChapterHeading(streamed, { chapterNumber: input.chapterNumber, title: input.title });
      const artifactId = newArtifactId("write", `ch${input.chapterNumber}`);
      const meta = input.meta(runId);
      await saveArtifact(input.root, {
        ...meta,
        artifactId,
        label: meta.label ? `${meta.label}（写到一半停下）` : "写到一半停下",
      }, body);
      await persistWriteRun(input.root, {
        ...baseRun,
        status: "cancelled",
        producedArtifactIds: [artifactId],
        ...(carried ? { usage: carried } : {}),
        progressLabel: "写到一半停下，已留下的字在候选稿里",
      }, input.onProgress);
      await rememberCandidate(input.root, input.chapterNumber, artifactId, runId);
      return draftResult({ body, runId, artifactId, status: "cancelled", targetWordCount: input.targetWordCount, usage: carried });
    }
    let stopped: boolean = signal.aborted;
    try {
      await throwIfRunCancelled(input.root, runId);
    } catch (error) {
      if (!(error instanceof AuthoringRunCancelledError)) throw error;
      stopped = true;
    }
    if (stopped) {
      const source = observed.content.trim() ? observed.content : streamed;
      if (!source.trim()) {
        await persistWriteRun(input.root, { ...baseRun, status: "cancelled", usage: observed.usage }, input.onProgress);
        return draftResult({ body: "", runId, artifactId: "", status: "cancelled", targetWordCount: input.targetWordCount, usage: observed.usage });
      }
      const body = ensureSingleChapterHeading(source, { chapterNumber: input.chapterNumber, title: input.title });
      const artifactId = newArtifactId("write", `ch${input.chapterNumber}`);
      await saveArtifact(input.root, { ...input.meta(runId), artifactId }, body);
      await persistWriteRun(input.root, {
        ...baseRun,
        status: "cancelled",
        producedArtifactIds: [artifactId],
        usage: observed.usage,
        progressLabel: "写到一半停下，已留下的字在候选稿里",
      }, input.onProgress);
      await rememberCandidate(input.root, input.chapterNumber, artifactId, runId);
      return draftResult({ body, runId, artifactId, status: "cancelled", targetWordCount: input.targetWordCount, usage: observed.usage });
    }
    const body = ensureSingleChapterHeading(observed.content, { chapterNumber: input.chapterNumber, title: input.title });
    const artifactId = newArtifactId("write", `ch${input.chapterNumber}`);
    await saveArtifact(input.root, { ...input.meta(runId), artifactId }, body);
    await persistWriteRun(input.root, {
      ...baseRun,
      status: "completed",
      progressDone: 1,
      progressLabel: input.operation === "revise" ? "修订完成" : `第 ${input.chapterNumber} 章已写成`,
      producedArtifactIds: [artifactId],
      usage: observed.usage,
    }, input.onProgress);
    await rememberCandidate(input.root, input.chapterNumber, artifactId, runId);
    return draftResult({
      body,
      runId,
      artifactId,
      status: "completed",
      targetWordCount: input.targetWordCount,
      usage: observed.usage,
    });
  } catch (error) {
    if (error instanceof AuthoringRunCancelledError) {
      await persistWriteRun(input.root, {
        ...baseRun,
        status: "cancelled",
        progressLabel: input.operation === "revise" ? "已放弃这次修订" : `已放弃第 ${input.chapterNumber} 章`,
      }, input.onProgress);
      return draftResult({ body: "", runId, artifactId: "", status: "cancelled", targetWordCount: input.targetWordCount });
    }
    throw error;
  } finally {
    activeWriteRuns.delete(runId);
  }
}

export async function generateChapterDraft(input: WriteRuntime & {
  readonly chapterNumber: number;
  readonly title?: string;
  readonly requirements?: string;
  readonly baseBody?: string;
  readonly parentArtifactId?: string;
  readonly runId?: string;
  readonly onRunStart?: (runId: string) => void | Promise<void>;
  readonly onProgress?: (run: AuthoringRunRecord) => void;
  readonly onTextDelta?: (delta: string) => void | Promise<void>;
}): Promise<WriteDraftResult> {
  await assertPreviousSettleIdle(input.root, input.chapterNumber);
  return withBookWriteLock(input.root, "落笔", (signal) => generateChapterDraftInner(input, signal));
}

async function generateChapterDraftInner(input: WriteRuntime & {
  readonly chapterNumber: number;
  readonly title?: string;
  readonly requirements?: string;
  readonly baseBody?: string;
  readonly parentArtifactId?: string;
  readonly runId?: string;
  readonly onRunStart?: (runId: string) => void | Promise<void>;
  readonly onProgress?: (run: AuthoringRunRecord) => void;
  readonly onTextDelta?: (delta: string) => void | Promise<void>;
}, lockSignal: AbortSignal): Promise<WriteDraftResult> {
  if (!input.root.bookId) throw new Error("落笔需要已建的书。");
  const bookDir = join(input.root.projectRoot, "books", input.root.bookId);
  try {
    await assertWriteReady(input.root, input.chapterNumber, bookDir);
  } catch (error) {
    if (input.runId) {
      const resolved = await resolve(input.project, "write.main", input.root.projectRoot);
      await persistFailedWriteRun(input.root, {
        runId: input.runId,
        stage: "write",
        operation: "generate",
        roleId: "write.main",
        status: "failed",
        bookId: input.root.bookId,
        scope: `chapter:${input.chapterNumber}`,
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
        progressLabel: `第 ${input.chapterNumber} 章未写成`,
        modelSnapshot: resolved.snapshot,
        producedArtifactIds: [],
        createdAt: new Date().toISOString(),
      }, error, input.onProgress);
    }
    throw error;
  }
  const currentManifest = await loadManifest(input.root);
  const resolved = await resolve(input.project, "write.main", input.root.projectRoot);
  const ctx = await assembleAuthoringContext(input.root, { stage: "write", chapterNumber: input.chapterNumber });
  const book = await loadBookJson(bookDir).catch(() => undefined);
  const canonWordCount = await loadCanonDocument(input.root).then((doc) => doc.canon.chapterWordCount).catch(() => undefined);
  const targetWordCount = book?.chapterWordCount ?? canonWordCount;
  const priorId = currentManifest.candidates.write?.[String(input.chapterNumber)];
  const prior = !input.baseBody && priorId ? await loadArtifact(input.root, priorId) : null;
  const existing = input.baseBody ?? prior?.body ?? await loadChapterText(input.root, input.chapterNumber);
  const located = await findChapterRelativePath(bookDir, input.chapterNumber);
  const title = input.title?.trim()
    || located?.title?.trim()
    || await resolvePlannedChapterTitle(input.root, input.chapterNumber);
  const prompt = [
    `撰写第 ${input.chapterNumber} 章${title ? `《${title}》` : ""}。`,
    "只写这一章的故事正文，从情节写起。不要写章节标题，不要写章节号，不要用井号另起一行。标题会由软件加上，你再写就会和标题重复。",
    targetWordCount ? `本章目标约 ${targetWordCount} 字，写完后字数尽量接近这个数。` : "",
    input.requirements ? `本章要求：${input.requirements}` : "",
    existing ? `当前已有正文（可在此基础上改写）：\n${collapseDuplicateChapterHeadings(existing, { chapterNumber: input.chapterNumber, title }).slice(0, 8000)}` : "",
    ctx.text,
  ].filter(Boolean).join("\n");
  const parent = input.parentArtifactId ? await loadArtifact(input.root, input.parentArtifactId) : undefined;
  return streamChapterText({
    root: input.root,
    projectLlm: input.llm,
    resolved,
    prompt,
    lockSignal,
    operation: "generate",
    chapterNumber: input.chapterNumber,
    title,
    targetWordCount,
    runId: input.runId,
    onRunStart: input.onRunStart,
    onProgress: input.onProgress,
    onTextDelta: input.onTextDelta,
    meta: (runId) => ({
      stage: "write",
      scope: `chapter:${input.chapterNumber}`,
      version: parent ? parent.meta.version + 1 : 1,
      parentVersion: parent?.meta.version,
      parentArtifactId: parent?.meta.artifactId,
      source: "generate",
      status: "candidate",
      bodyPath: `chapters/${chapterFileName(input.chapterNumber, title ?? "")}`,
      inputRefs: ctx.refs,
      createdAt: new Date().toISOString(),
      runId,
      title: title || undefined,
      label: title
        ? `第${input.chapterNumber}章 ${title}`
        : `第${input.chapterNumber}章候选`,
    }),
  });
}

export async function reviewChapterDraft(input: WriteRuntime & {
  readonly artifactId: string;
  readonly coverage?: string;
  readonly runId?: string;
  readonly onProgress?: (run: AuthoringRunRecord) => void;
}): Promise<AuthoringReviewReport> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  if (!loaded) throw new Error("找不到要审查的正文。");
  const resolved = await resolve(input.project, "write.review", input.root.projectRoot);
  const coverage = input.coverage ?? loaded.meta.scope;
  const chapterNumber = Number(loaded.meta.scope.replace("chapter:", "")) || undefined;
  const runId = input.runId ?? newRunId();
  const createdAt = new Date().toISOString();
  const running = {
    runId,
    stage: "write" as const,
    operation: "review" as const,
    roleId: "write.review" as const,
    status: "running" as const,
    bookId: input.root.bookId,
    scope: loaded.meta.scope,
    progressLabel: "正在审查正文",
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [] as string[],
    createdAt,
  };
  await persistWriteRun(input.root, running, input.onProgress);
  try {
    await throwIfRunCancelled(input.root, runId);
    const ctx = await assembleAuthoringContext(input.root, { stage: "write", chapterNumber });
    const checks = await collectWriteReviewChecks({
      root: input.root,
      body: loaded.body,
      chapterNumber,
    });
    const voice = await loadCanonDocument(input.root).then((doc) => doc.canon.voice).catch(() => "");
    const reviewed = await requestReviewModelText({
      resolved,
      llm: input.llm,
      system: composeWriteSystemPrompt(resolved.instructions, voice),
      prompt: reviewPrompt(
        "write",
        coverage,
        loaded.body,
        [formatChecksForPrompt(checks), ctx.text].filter(Boolean).join("\n\n"),
      ),
    });
    await throwIfRunCancelled(input.root, runId);
    const report = mergeDeterministicIssues(parseReviewPayload(reviewed.text, {
      stage: "write",
      targetRefs: [loaded.meta.artifactId],
      coverage,
      model: resolved.modelId,
      runId,
      rawExcerpt: reviewed.rawExcerpt,
      inputRefs: [{ kind: "artifact", id: loaded.meta.artifactId, version: loaded.meta.version }, ...ctx.refs],
    }), checks);
    await withBookWriteLock(input.root, "审查本章", async () => {
      await saveReport(input.root, report);
      await persistWriteRun(input.root, {
        ...running,
        status: "completed",
        reportId: report.reportId,
        progressDone: 1,
        progressTotal: 1,
        progressLabel: "审查完成",
        ...(reviewed.usage ? { usage: reviewed.usage } : {}),
      }, input.onProgress);
    });
    return report;
  } catch (error) {
    if (error instanceof AuthoringRunCancelledError) {
      await persistWriteRun(input.root, {
        ...running,
        status: "cancelled",
        progressLabel: "已放弃这次审查",
      }, input.onProgress);
      throw error;
    }
    await persistFailedWriteRun(input.root, {
      ...running,
      status: "failed",
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
      progressLabel: "审查失败",
    }, error, input.onProgress);
    throw error;
  }
}

export async function reviseChapterDraft(input: WriteRuntime & {
  readonly artifactId: string;
  readonly reportId: string;
  readonly selectedIssueIds: readonly string[];
  readonly extraRequirement?: string;
  readonly reuseStale?: boolean;
  readonly runId?: string;
  readonly onRunStart?: (runId: string) => void | Promise<void>;
  readonly onProgress?: (run: AuthoringRunRecord) => void;
  readonly onTextDelta?: (delta: string) => void | Promise<void>;
}): Promise<WriteDraftResult & { version: number }> {
  return withBookWriteLock(input.root, "按意见修改", (signal) => reviseChapterDraftInner(input, signal));
}

async function reviseChapterDraftInner(input: WriteRuntime & {
  readonly artifactId: string;
  readonly reportId: string;
  readonly selectedIssueIds: readonly string[];
  readonly extraRequirement?: string;
  readonly reuseStale?: boolean;
  readonly runId?: string;
  readonly onRunStart?: (runId: string) => void | Promise<void>;
  readonly onProgress?: (run: AuthoringRunRecord) => void;
  readonly onTextDelta?: (delta: string) => void | Promise<void>;
}, lockSignal: AbortSignal): Promise<WriteDraftResult & { version: number }> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  const report = await loadReport(input.root, input.reportId);
  if (!loaded || !report) throw new Error("按意见修改需要正文和报告。");
  assertReportReusable(report, loaded.meta.artifactId, input.reuseStale);
  const selected = report.issues.filter((issue) => input.selectedIssueIds.includes(issue.issueId));
  if (selected.length === 0) throw new Error("先选择要处理的意见。");
  const resolved = await resolve(input.project, "write.main", input.root.projectRoot);
  const chapterNumber = Number(loaded.meta.scope.replace("chapter:", "")) || 1;
  const ctx = await assembleAuthoringContext(input.root, { stage: "write", chapterNumber });
  const book = input.root.bookId
    ? await loadBookJson(join(input.root.projectRoot, "books", input.root.bookId)).catch(() => undefined)
    : undefined;
  const title = loaded.meta.title;
  const version = loaded.meta.version + 1;
  const result = await streamChapterText({
    root: input.root,
    projectLlm: input.llm,
    resolved,
    lockSignal,
    operation: "revise",
    chapterNumber,
    title,
    targetWordCount: book?.chapterWordCount,
    runId: input.runId,
    onRunStart: input.onRunStart,
    onProgress: input.onProgress,
    onTextDelta: input.onTextDelta,
    prompt: [
      "按选中意见修改正文。只输出完整的故事正文。不要声称已经复审通过。",
      "如果开头已经有一行章节标题，只保留这一行，不要再写第二遍，也不要用井号和普通文字各写一次。",
      book?.chapterWordCount ? `本章目标约 ${book.chapterWordCount} 字。` : "",
      `报告 ${report.reportId}`,
      ...selected.map((issue) => `- ${issue.issueId} ${issue.title}: ${issue.suggestion ?? ""}`),
      input.extraRequirement ? `作者补充：${input.extraRequirement}` : "",
      ctx.text,
      collapseDuplicateChapterHeadings(loaded.body, { chapterNumber, title }),
    ].filter(Boolean).join("\n"),
    meta: (runId) => ({
      stage: "write",
      scope: loaded.meta.scope,
      version,
      parentVersion: loaded.meta.version,
      parentArtifactId: loaded.meta.artifactId,
      source: "revise",
      status: "candidate",
      bodyPath: loaded.meta.bodyPath,
      inputRefs: [{ kind: "report", id: report.reportId }],
      createdAt: new Date().toISOString(),
      runId,
      title: loaded.meta.title,
      label: `${loaded.meta.label ?? loaded.meta.scope} v${version}`,
    }),
  });
  return { ...result, version };
}

function auditLine(issue: ReviewIssue): string {
  const severity = issue.severity === "priority" ? "critical" : issue.severity === "improve" ? "warning" : "info";
  const detail = [issue.title, issue.suggestion].filter(Boolean).join("。");
  return `[${severity}] 审稿: ${detail}`;
}

const SETTLE_PROMPT = [
  "根据刚采用的正文整理人物状态与伏笔变化。不要改正文。",
  "只输出一个 JSON 对象，包含 summary（这一章的一段话）、characters（[{name, status}]）、openHooks（[{id, label, targetChapter, note}]，新埋下还没收的线）、advanceHooks（推进了但没收回的旧线 id）、resolveHooks（已经收回的线 id）。拿不准时 summary 仍要写，其余留空数组。",
];

export async function adoptChapterDraft(input: WriteRuntime & {
  readonly artifactId: string;
  readonly settle?: AuthoringLlmFn;
  readonly deferSettle?: boolean;
}): Promise<{ adopted: true; settled: boolean; settleError?: string; lengthNote?: string }> {
  return withBookWriteLock(input.root, "采用正文", (signal) => adoptChapterDraftInner(input, signal));
}

async function adoptChapterDraftInner(input: WriteRuntime & {
  readonly artifactId: string;
  readonly settle?: AuthoringLlmFn;
  readonly deferSettle?: boolean;
}, signal?: AbortSignal): Promise<{ adopted: true; settled: boolean; settleError?: string; lengthNote?: string }> {
  if (!input.root.bookId) throw new Error("采用正文需要已建的书。");
  const loaded = await loadArtifact(input.root, input.artifactId);
  if (!loaded) throw new Error("找不到可采用的正文。");
  const bookDir = join(input.root.projectRoot, "books", input.root.bookId);
  const chapter = loaded.meta.scope.replace("chapter:", "");
  const chapterNumber = Number(chapter) || 1;
  const located = await findChapterRelativePath(bookDir, chapterNumber);
  const title = resolveChapterDisplayTitle({
    storedTitle: loaded.meta.title,
    indexTitle: located?.title,
    label: loaded.meta.label,
    bodyPath: loaded.meta.bodyPath,
    chapterNumber,
  });
  const relativePath = located?.relativePath
    || (loaded.meta.bodyPath.startsWith("chapters/") ? loaded.meta.bodyPath.replace(/\\/g, "/") : `chapters/${chapterFileName(chapterNumber, title)}`);
  const reports = await listReports(input.root, "write").catch(() => [] as AuthoringReviewReport[]);
  const latestReport = reports
    .filter((report) => !report.stale && report.targetRefs.includes(loaded.meta.artifactId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const auditIssues = latestReport?.issues.map((issue) => auditLine(issue)) ?? [];
  const blocked = latestReport?.issues.some((issue) => issue.severity === "priority") ?? false;
  const book = await loadBookJson(bookDir).catch(() => undefined);
  const chapterBody = ensureSingleChapterHeading(loaded.body, { chapterNumber, title });
  const lengthNote = chapterLengthNote(countChapterChars(chapterBody), book?.chapterWordCount);
  let settled = false;
  let settleError: string | undefined;
  let settleText = "";
  if (!input.deferSettle) {
    try {
      const resolved = await resolve(input.project, "write.main", input.root.projectRoot);
      const voice = await loadCanonDocument(input.root).then((doc) => doc.canon.voice).catch(() => "");
      settleText = await completeRole(resolved, [
        ...SETTLE_PROMPT,
        chapterBody.slice(0, 8000),
      ].join("\n"), input.settle ?? input.llm, signal, {
        system: composeWriteSystemPrompt(resolved.instructions, voice),
      });
      settled = true;
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("采用已中止，正文没有写入");
      }
      settleError = error instanceof Error ? error.message : String(error);
    }
  }
  if (signal?.aborted) {
    throw new Error("采用已中止，正文没有写入");
  }
  const note = settled ? parseSettleNote(settleText) : undefined;
  const manifest = await loadManifest(input.root);
  const adoptedWrite = { ...manifest.adopted.write, [chapter]: loaded.meta.artifactId };
  const nextManifest = renderManifest({
    ...manifest,
    adopted: { ...manifest.adopted, write: adoptedWrite },
    coverage: {
      ...manifest.coverage,
      chaptersWrittenAdopted: Object.keys(adoptedWrite).length,
    },
  });
  const meta = AuthoringArtifactMetaSchema.parse({
    ...loaded.meta,
    status: "adopted",
    title,
    bodyPath: relativePath,
  });
  const extraWrites = [
    { relativePath: "story/workflow/manifest.json", content: nextManifest },
    { relativePath: `story/workflow/artifacts/${loaded.meta.artifactId}/meta.json`, content: `${JSON.stringify(meta, null, 2)}\n` },
    { relativePath: `story/workflow/artifacts/${loaded.meta.artifactId}/body.md`, content: chapterBody.endsWith("\n") ? chapterBody : `${chapterBody}\n` },
  ];
  if (note) {
    const ledger = applyChapterMemory(
      await loadSerialLedger(bookDir),
      chapterMemoryFromSettle({ chapter: chapterNumber, artifactId: loaded.meta.artifactId, title, note }),
    );
    const stateBody = note.summary.endsWith("\n") ? note.summary : `${note.summary}\n`;
    extraWrites.push(
      { relativePath: `story/state/chapter-${chapterNumber}.md`, content: stateBody },
      { relativePath: `story/state/chapter-${chapterNumber}.ref.json`, content: `${JSON.stringify({ artifactId: loaded.meta.artifactId, chapterNumber }, null, 2)}\n` },
      { relativePath: "story/state/serial-ledger.json", content: `${JSON.stringify(SerialLedgerSchema.parse(ledger), null, 2)}\n` },
    );
  }
  await persistAdoptedChapter({
    bookDir,
    chapterNumber,
    title,
    body: chapterBody,
    relativePath,
    status: blocked ? "ready-for-review" : "approved",
    auditIssues,
    lengthWarnings: lengthNote ? [lengthNote] : [],
    extraWrites,
  });
  if (!settled) await invalidateChapterState(input.root, chapterNumber);
  try {
    await new StateManager(input.root.projectRoot).snapshotState(input.root.bookId, chapterNumber);
  } catch {
    /* snapshots are optional on lightweight books */
  }
  return { adopted: true, settled, settleError, ...(lengthNote ? { lengthNote } : {}) };
}

export async function settleAdoptedChapter(input: WriteRuntime & {
  readonly artifactId: string;
  readonly settle?: AuthoringLlmFn;
  readonly runId?: string;
  readonly onProgress?: (run: AuthoringRunRecord) => void;
}): Promise<{ settled: boolean; settleError?: string; runId: string }> {
  return withBookWriteLock(input.root, "整理状态", (signal) => settleAdoptedChapterInner(input, signal));
}

async function settleAdoptedChapterInner(input: WriteRuntime & {
  readonly artifactId: string;
  readonly settle?: AuthoringLlmFn;
  readonly runId?: string;
  readonly onProgress?: (run: AuthoringRunRecord) => void;
}, signal: AbortSignal): Promise<{ settled: boolean; settleError?: string; runId: string }> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  if (!loaded) throw new Error("找不到要整理状态的正文。");
  if (!input.root.bookId) throw new Error("整理状态需要已建的书。");
  const chapter = loaded.meta.scope.replace("chapter:", "");
  const chapterNumber = Number(chapter) || 1;
  const bookDir = join(input.root.projectRoot, "books", input.root.bookId);
  const resolved = await resolve(input.project, "write.main", input.root.projectRoot);
  const runId = input.runId ?? newRunId();
  const startedAt = new Date().toISOString();
  const running = {
    runId,
    stage: "write" as const,
    operation: "settle" as const,
    roleId: "write.main" as const,
    status: "running" as const,
    bookId: input.root.bookId,
    scope: loaded.meta.scope,
    progressLabel: `正在整理第 ${chapterNumber} 章状态`,
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [loaded.meta.artifactId],
    createdAt: startedAt,
  };
  await persistWriteRun(input.root, running, input.onProgress);
  try {
    await throwIfRunCancelled(input.root, runId);
    const voice = await loadCanonDocument(input.root).then((doc) => doc.canon.voice).catch(() => "");
    const settleText = await completeRole(resolved, [
      ...SETTLE_PROMPT,
      loaded.body.slice(0, 8000),
    ].join("\n"), input.settle ?? input.llm, signal, {
      system: composeWriteSystemPrompt(resolved.instructions, voice),
    });
    await throwIfRunCancelled(input.root, runId);
    const note = parseSettleNote(settleText);
    if (note) {
      const title = loaded.meta.title ?? `第${chapterNumber}章`;
      const ledger = applyChapterMemory(
        await loadSerialLedger(bookDir),
        chapterMemoryFromSettle({ chapter: chapterNumber, artifactId: loaded.meta.artifactId, title, note }),
      );
      await writeChapterState(input.root, chapterNumber, loaded.meta.artifactId, note.summary);
      await writeFileAtomic(
        join(bookDir, "story", "state", "serial-ledger.json"),
        `${JSON.stringify(SerialLedgerSchema.parse(ledger), null, 2)}\n`,
      );
    }
    await persistWriteRun(input.root, {
      ...running,
      status: "completed",
      progressDone: 1,
      progressTotal: 1,
      progressLabel: `第 ${chapterNumber} 章状态已整理`,
    }, input.onProgress);
    return { settled: true, runId };
  } catch (error) {
    if (error instanceof AuthoringRunCancelledError || signal.aborted) {
      await persistWriteRun(input.root, {
        ...running,
        status: "cancelled",
        progressLabel: "已放弃这次状态整理",
      }, input.onProgress);
      throw error instanceof AuthoringRunCancelledError ? error : new AuthoringRunCancelledError();
    }
    const settleError = error instanceof Error ? error.message : String(error);
    await invalidateChapterState(input.root, chapterNumber);
    await persistFailedWriteRun(input.root, {
      ...running,
      status: "failed",
      error: redactSecrets(settleError),
      progressLabel: "状态整理未完成",
    }, error, input.onProgress);
    return { settled: false, settleError, runId };
  }
}

export async function saveWriteBody(input: WriteRuntime & {
  readonly chapterNumber: number;
  readonly title?: string;
  readonly body: string;
  readonly artifactId?: string;
}): Promise<{ artifactId: string; version: number }> {
  return withBookWriteLock(input.root, "保存手改", () => saveWriteBodyInner(input));
}

async function saveWriteBodyInner(input: WriteRuntime & {
  readonly chapterNumber: number;
  readonly title?: string;
  readonly body: string;
  readonly artifactId?: string;
}): Promise<{ artifactId: string; version: number }> {
  const body = collapseDuplicateChapterHeadings(input.body, {
    chapterNumber: input.chapterNumber,
    title: input.title,
  });
  if (input.artifactId) {
    const meta = await saveHandEditedArtifact(input.root, input.artifactId, body);
    return { artifactId: meta.artifactId, version: meta.version };
  }
  const located = input.root.bookId
    ? await findChapterRelativePath(
      join(input.root.projectRoot, "books", input.root.bookId),
      input.chapterNumber,
    )
    : undefined;
  const title = input.title?.trim()
    || located?.title?.trim()
    || await resolvePlannedChapterTitle(input.root, input.chapterNumber);
  const artifactId = newArtifactId("write", `ch${input.chapterNumber}`);
  await saveArtifact(input.root, {
    artifactId,
    stage: "write",
    scope: `chapter:${input.chapterNumber}`,
    version: 1,
    source: "hand",
    status: "candidate",
    bodyPath: `chapters/${chapterFileName(input.chapterNumber, title ?? "")}`,
    inputRefs: [],
    createdAt: new Date().toISOString(),
    title: title || undefined,
    label: title
      ? `第${input.chapterNumber}章 ${title}`
      : `第${input.chapterNumber}章`,
  }, body);
  const manifest = await loadManifest(input.root);
  await saveManifest(input.root, {
    ...manifest,
    candidates: {
      ...manifest.candidates,
      write: { ...manifest.candidates.write, [String(input.chapterNumber)]: artifactId },
    },
  });
  return { artifactId, version: 1 };
}

export async function selectWriteCandidate(input: WriteRuntime & {
  readonly chapterNumber: number;
  readonly artifactId: string;
}): Promise<{ artifactId: string }> {
  return withBookWriteLock(input.root, "选择稿件", () => selectWriteCandidateInner(input));
}

async function selectWriteCandidateInner(input: WriteRuntime & {
  readonly chapterNumber: number;
  readonly artifactId: string;
}): Promise<{ artifactId: string }> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  if (!loaded || loaded.meta.stage !== "write") throw new Error("找不到要保留的正文。");
  const chapter = String(input.chapterNumber);
  if (loaded.meta.scope !== `chapter:${chapter}`) throw new Error("这份稿不属于当前章。");
  const manifest = await loadManifest(input.root);
  await saveManifest(input.root, {
    ...manifest,
    candidates: {
      ...manifest.candidates,
      write: { ...manifest.candidates.write, [chapter]: loaded.meta.artifactId },
    },
  });
  return { artifactId: loaded.meta.artifactId };
}

/**
 * Locks, then binds. The Studio restore route already holds the book lock and must
 * call bindRestoredChapterUnlocked. This wrapper stays for callers that do not
 * hold the lock (direct core use and tests).
 */
export async function bindRestoredChapter(input: {
  readonly root: AuthoringStoreRoot;
  readonly chapterNumber: number;
  readonly title?: string;
  readonly relativePath?: string;
  readonly body: string;
}): Promise<{ artifactId: string }> {
  return withBookWriteLock(input.root, "恢复正文", () => bindRestoredChapterUnlocked(input));
}

/** Caller already holds the book lock. Do not acquire it again. */
export async function bindRestoredChapterUnlocked(input: {
  readonly root: AuthoringStoreRoot;
  readonly chapterNumber: number;
  readonly title?: string;
  readonly relativePath?: string;
  readonly body: string;
}): Promise<{ artifactId: string }> {
  return bindRestoredChapterInner(input);
}

async function bindRestoredChapterInner(input: {
  readonly root: AuthoringStoreRoot;
  readonly chapterNumber: number;
  readonly title?: string;
  readonly relativePath?: string;
  readonly body: string;
}): Promise<{ artifactId: string }> {
  const located = input.root.bookId
    ? await findChapterRelativePath(
      join(input.root.projectRoot, "books", input.root.bookId),
      input.chapterNumber,
    )
    : undefined;
  const relativePath = input.relativePath?.replace(/\\/g, "/")
    || located?.relativePath
    || `chapters/${chapterFileName(input.chapterNumber, input.title ?? located?.title ?? "")}`;
  const title = input.title?.trim()
    || located?.title
    || titleFromChapterFileName(relativePath)
    || `第${input.chapterNumber}章`;
  await invalidateChapterState(input.root, input.chapterNumber);
  const artifactId = newArtifactId("write", `ch${input.chapterNumber}`);
  await saveArtifact(input.root, {
    artifactId,
    stage: "write",
    scope: `chapter:${input.chapterNumber}`,
    version: 1,
    source: "compat",
    status: "adopted",
    bodyPath: relativePath,
    inputRefs: [],
    createdAt: new Date().toISOString(),
    title,
    label: `第${input.chapterNumber}章 ${title}`.trim(),
  }, input.body);
  const chapter = String(input.chapterNumber);
  const manifest = await loadManifest(input.root);
  await saveManifest(input.root, {
    ...manifest,
    adopted: {
      ...manifest.adopted,
      write: { ...manifest.adopted.write, [chapter]: artifactId },
    },
    candidates: {
      ...manifest.candidates,
      write: { ...manifest.candidates.write, [chapter]: artifactId },
    },
  });
  return { artifactId };
}

export { diffLines } from "../line-diff.js";
