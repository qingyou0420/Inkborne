/**
 * 落笔: chapter draft, review, revise-from-report, adopt with state settle.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { join } from "node:path";
import { persistAdoptedChapter, chapterFileName, findChapterRelativePath, resolveChapterDisplayTitle, titleFromChapterFileName } from "../chapter-index.js";
import { withBookWriteLock } from "../book-lock.js";
import {
  assembleAuthoringContext,
  invalidateChapterState,
  loadBookJson,
  loadChapterText,
  resolvePlannedChapterTitle,
} from "../context.js";
import { completeRole } from "../llm.js";
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
  loadArtifact,
  listReports,
  loadManifest,
  loadReport,
  newArtifactId,
  newRunId,
  renderManifest,
  saveArtifact,
  saveHandEditedArtifact,
  saveManifest,
  saveReport,
  saveRun,
  type AuthoringStoreRoot,
} from "../store.js";
import { AuthoringArtifactMetaSchema, type AuthoringLlmFn, type AuthoringReviewReport, type ReviewIssue } from "../types.js";
import type { ProjectConfig } from "../../models/project.js";

export interface WriteRuntime {
  readonly root: AuthoringStoreRoot;
  readonly project: ProjectConfig;
  readonly llm?: AuthoringLlmFn;
}

async function resolve(project: ProjectConfig, role: "write.main" | "write.review", projectRoot?: string) {
  return resolveAuthoringRole({
    roleId: role,
    baseLlm: project.llm,
    roles: fillMissingAuthoringRoles(project),
    apiKeys: projectRoot ? await loadRoleApiKeys(projectRoot) : undefined,
  });
}

export async function generateChapterDraft(input: WriteRuntime & {
  readonly chapterNumber: number;
  readonly title?: string;
  readonly requirements?: string;
  readonly baseBody?: string;
  readonly parentArtifactId?: string;
}): Promise<{ artifactId: string; runId: string; body: string; wordCount: number; targetWordCount?: number; lengthNote?: string }> {
  return withBookWriteLock(input.root, "落笔", (signal) => generateChapterDraftInner(input, signal));
}

async function generateChapterDraftInner(input: WriteRuntime & {
  readonly chapterNumber: number;
  readonly title?: string;
  readonly requirements?: string;
  readonly baseBody?: string;
  readonly parentArtifactId?: string;
}, signal?: AbortSignal): Promise<{ artifactId: string; runId: string; body: string; wordCount: number; targetWordCount?: number; lengthNote?: string }> {
  if (!input.root.bookId) throw new Error("落笔需要已建的书。");
  const resolved = await resolve(input.project, "write.main", input.root.projectRoot);
  const ctx = await assembleAuthoringContext(input.root, { stage: "write", chapterNumber: input.chapterNumber });
  const book = await loadBookJson(join(input.root.projectRoot, "books", input.root.bookId)).catch(() => undefined);
  const targetWordCount = book?.chapterWordCount;
  const existing = input.baseBody ?? await loadChapterText(input.root, input.chapterNumber);
  const located = await findChapterRelativePath(
    join(input.root.projectRoot, "books", input.root.bookId),
    input.chapterNumber,
  );
  const title = input.title?.trim()
    || located?.title?.trim()
    || await resolvePlannedChapterTitle(input.root, input.chapterNumber);
  const runId = newRunId();
  const text = await completeRole(resolved, [
    `撰写第 ${input.chapterNumber} 章${title ? `《${title}》` : ""}。只输出章节正文 Markdown。`,
    targetWordCount ? `本章目标约 ${targetWordCount} 字，写完后字数尽量接近这个数。` : "",
    input.requirements ? `本章要求：${input.requirements}` : "",
    existing ? `当前已有正文（可在此基础上改写）：\n${existing.slice(0, 8000)}` : "",
    ctx.text,
  ].filter(Boolean).join("\n"), input.llm, signal);
  const artifactId = newArtifactId("write", `ch${input.chapterNumber}`);
  const parent = input.parentArtifactId ? await loadArtifact(input.root, input.parentArtifactId) : undefined;
  await saveArtifact(input.root, {
    artifactId,
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
  }, text);
  await saveRun(input.root, {
    runId,
    stage: "write",
    operation: "generate",
    roleId: "write.main",
    status: "completed",
    bookId: input.root.bookId,
    scope: `chapter:${input.chapterNumber}`,
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [artifactId],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const manifest = await loadManifest(input.root);
  await saveManifest(input.root, {
    ...manifest,
    candidates: {
      ...manifest.candidates,
      write: { ...manifest.candidates.write, [String(input.chapterNumber)]: artifactId },
    },
    lastRunId: runId,
  });
  const wordCount = countChapterChars(text);
  const lengthNote = chapterLengthNote(wordCount, targetWordCount);
  return {
    artifactId,
    runId,
    body: text,
    wordCount,
    ...(targetWordCount ? { targetWordCount } : {}),
    ...(lengthNote ? { lengthNote } : {}),
  };
}

export async function reviewChapterDraft(input: WriteRuntime & {
  readonly artifactId: string;
  readonly coverage?: string;
}): Promise<AuthoringReviewReport> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  if (!loaded) throw new Error("找不到要审查的正文。");
  const resolved = await resolve(input.project, "write.review", input.root.projectRoot);
  const coverage = input.coverage ?? loaded.meta.scope;
  const chapterNumber = Number(loaded.meta.scope.replace("chapter:", "")) || undefined;
  const ctx = await assembleAuthoringContext(input.root, { stage: "write", chapterNumber });
  const checks = await collectWriteReviewChecks({
    root: input.root,
    body: loaded.body,
    chapterNumber,
  });
  const { text, rawExcerpt } = await requestReviewModelText({
    resolved,
    llm: input.llm,
    prompt: reviewPrompt(
      "write",
      coverage,
      loaded.body,
      [formatChecksForPrompt(checks), ctx.text].filter(Boolean).join("\n\n"),
    ),
  });
  const report = mergeDeterministicIssues(parseReviewPayload(text, {
    stage: "write",
    targetRefs: [loaded.meta.artifactId],
    coverage,
    model: resolved.modelId,
    rawExcerpt,
    inputRefs: [{ kind: "artifact", id: loaded.meta.artifactId, version: loaded.meta.version }, ...ctx.refs],
  }), checks);
  await withBookWriteLock(input.root, "审查本章", async () => {
    await saveReport(input.root, report);
  });
  return report;
}

export async function reviseChapterDraft(input: WriteRuntime & {
  readonly artifactId: string;
  readonly reportId: string;
  readonly selectedIssueIds: readonly string[];
  readonly extraRequirement?: string;
  readonly reuseStale?: boolean;
}): Promise<{ artifactId: string; version: number }> {
  return withBookWriteLock(input.root, "按意见修改", (signal) => reviseChapterDraftInner(input, signal));
}

async function reviseChapterDraftInner(input: WriteRuntime & {
  readonly artifactId: string;
  readonly reportId: string;
  readonly selectedIssueIds: readonly string[];
  readonly extraRequirement?: string;
  readonly reuseStale?: boolean;
}, signal?: AbortSignal): Promise<{ artifactId: string; version: number }> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  const report = await loadReport(input.root, input.reportId);
  if (!loaded || !report) throw new Error("按意见修改需要正文和报告。");
  assertReportReusable(report, loaded.meta.artifactId, input.reuseStale);
  const selected = report.issues.filter((issue) => input.selectedIssueIds.includes(issue.issueId));
  if (selected.length === 0) throw new Error("先选择要处理的意见。");
  const resolved = await resolve(input.project, "write.main", input.root.projectRoot);
  const chapterNumber = Number(loaded.meta.scope.replace("chapter:", "")) || undefined;
  const ctx = await assembleAuthoringContext(input.root, { stage: "write", chapterNumber });
  const book = input.root.bookId
    ? await loadBookJson(join(input.root.projectRoot, "books", input.root.bookId)).catch(() => undefined)
    : undefined;
  const text = await completeRole(resolved, [
    "按选中意见修改正文。只输出完整章节 Markdown。不要声称已经复审通过。",
    book?.chapterWordCount ? `本章目标约 ${book.chapterWordCount} 字。` : "",
    `报告 ${report.reportId}`,
    ...selected.map((issue) => `- ${issue.issueId} ${issue.title}: ${issue.suggestion ?? ""}`),
    input.extraRequirement ? `作者补充：${input.extraRequirement}` : "",
    ctx.text,
    loaded.body,
  ].filter(Boolean).join("\n"), input.llm, signal);
  const nextId = newArtifactId("write", loaded.meta.scope);
  const version = loaded.meta.version + 1;
  await saveArtifact(input.root, {
    artifactId: nextId,
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
    title: loaded.meta.title,
    label: `${loaded.meta.label ?? loaded.meta.scope} v${version}`,
  }, text);
  const chapter = loaded.meta.scope.replace("chapter:", "");
  const manifest = await loadManifest(input.root);
  await saveManifest(input.root, {
    ...manifest,
    candidates: {
      ...manifest.candidates,
      write: { ...manifest.candidates.write, [chapter]: nextId },
    },
  });
  return { artifactId: nextId, version };
}

function auditLine(issue: ReviewIssue): string {
  const severity = issue.severity === "priority" ? "critical" : issue.severity === "improve" ? "warning" : "info";
  const detail = [issue.title, issue.suggestion].filter(Boolean).join("。");
  return `[${severity}] 审稿: ${detail}`;
}

export async function adoptChapterDraft(input: WriteRuntime & {
  readonly artifactId: string;
  readonly settle?: AuthoringLlmFn;
}): Promise<{ adopted: true; settled: boolean; settleError?: string; lengthNote?: string }> {
  return withBookWriteLock(input.root, "采用正文", (signal) => adoptChapterDraftInner(input, signal));
}

async function adoptChapterDraftInner(input: WriteRuntime & {
  readonly artifactId: string;
  readonly settle?: AuthoringLlmFn;
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
  const lengthNote = chapterLengthNote(countChapterChars(loaded.body), book?.chapterWordCount);
  let settled = false;
  let settleError: string | undefined;
  let settleText = "";
  try {
    const resolved = await resolve(input.project, "write.main", input.root.projectRoot);
    settleText = await completeRole(resolved, [
      "根据刚采用的正文整理人物状态与伏笔变化。不要改正文。",
      "只输出一个 JSON 对象，包含 summary（这一章的一段话）、characters（[{name, status}]）、openHooks（[{id, label, targetChapter, note}]，新埋下还没收的线）、advanceHooks（推进了但没收回的旧线 id）、resolveHooks（已经收回的线 id）。拿不准时 summary 仍要写，其余留空数组。",
      loaded.body.slice(0, 8000),
    ].join("\n"), input.settle ?? input.llm, signal);
    settled = true;
  } catch (error) {
    if (signal?.aborted) {
      throw new Error("采用已中止，正文没有写入");
    }
    settleError = error instanceof Error ? error.message : String(error);
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
    body: loaded.body,
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
  if (input.artifactId) {
    const meta = await saveHandEditedArtifact(input.root, input.artifactId, input.body);
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
  }, input.body);
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
