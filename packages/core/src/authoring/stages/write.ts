/**
 * 落笔: chapter draft, review, revise-from-report, adopt with state settle.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { join } from "node:path";
import { persistAdoptedChapter, chapterFileName, findChapterRelativePath, resolveChapterDisplayTitle, titleFromChapterFileName } from "../chapter-index.js";
import {
  assembleAuthoringContext,
  invalidateChapterState,
  isLightweightAuthoringBook,
  loadCanonDocument,
  loadChapterText,
  loadOutlineText,
  resolvePlannedChapterTitle,
  writeChapterState,
} from "../context.js";
import { findChapterNode, parseVolumeMapTree } from "../../utils/volume-map-tree.js";
import { completeRole } from "../llm.js";
import { fillMissingAuthoringRoles, loadRoleApiKeys, resolveAuthoringRole } from "../model-config.js";
import { assertReportReusable, parseReviewPayload, reviewPrompt } from "../review.js";
import { StateManager } from "../../state/manager.js";
import {
  loadArtifact,
  loadManifest,
  loadReport,
  loadRun,
  newArtifactId,
  newRunId,
  saveArtifact,
  saveHandEditedArtifact,
  saveManifest,
  saveReport,
  saveRun,
  type AuthoringStoreRoot,
} from "../store.js";
import type { AuthoringLlmFn, AuthoringReviewReport, AuthoringRunRecord } from "../types.js";
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

async function writeRun(
  root: AuthoringStoreRoot,
  run: Omit<AuthoringRunRecord, "updatedAt"> & { updatedAt?: string },
  onProgress?: (run: AuthoringRunRecord) => void,
): Promise<void> {
  await saveRun(root, run);
  onProgress?.(await loadRun(root, run.runId) ?? { ...run, updatedAt: new Date().toISOString() });
}

export async function generateChapterDraft(input: WriteRuntime & {
  readonly chapterNumber: number;
  readonly title?: string;
  readonly requirements?: string;
  readonly runId?: string;
  readonly onProgress?: (run: AuthoringRunRecord) => void;
}): Promise<{ artifactId: string; runId: string; body: string }> {
  if (!input.root.bookId) throw new Error("落笔需要已建的书。");
  const bookDir = join(input.root.projectRoot, "books", input.root.bookId);
  const currentManifest = await loadManifest(input.root);
  const resolved = await resolve(input.project, "write.main", input.root.projectRoot);
  const runId = input.runId ?? newRunId();
  const startedAt = new Date().toISOString();
  const scope = `chapter:${input.chapterNumber}`;
  const baseRun = {
    runId,
    stage: "write" as const,
    operation: "generate" as const,
    roleId: "write.main" as const,
    bookId: input.root.bookId,
    scope,
    progressDone: 0,
    progressTotal: 1,
    progressLabel: `正在写第 ${input.chapterNumber} 章`,
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [] as string[],
    createdAt: startedAt,
  };
  await writeRun(input.root, { ...baseRun, status: "running" }, input.onProgress);
  try {
    if (await isLightweightAuthoringBook(bookDir)) {
      if (!currentManifest.adopted.weave) {
        throw new Error("请先到织卷生成并采用分卷与本章规划，再自动写正文。");
      }
      const outline = await loadOutlineText(input.root);
      const node = findChapterNode(parseVolumeMapTree(outline), input.chapterNumber);
      if (!node?.summary?.trim() || node.summary.trim() === "（待补概要）") {
        throw new Error(`第 ${input.chapterNumber} 章还没有已采用的织卷概要，请先到织卷生成并采用本章规划。`);
      }
    }
    const ctx = await assembleAuthoringContext(input.root, { stage: "write", chapterNumber: input.chapterNumber });
    const { canon } = await loadCanonDocument(input.root);
    const wordCount = canon.chapterWordCount;
    const previous = input.chapterNumber > 1
      ? await loadChapterText(input.root, input.chapterNumber - 1)
      : "";
    const priorId = currentManifest.candidates.write?.[String(input.chapterNumber)];
    const prior = priorId ? await loadArtifact(input.root, priorId) : null;
    const existing = prior?.body ?? await loadChapterText(input.root, input.chapterNumber);
    const located = await findChapterRelativePath(
      join(input.root.projectRoot, "books", input.root.bookId),
      input.chapterNumber,
    );
    const title = input.title?.trim()
      || located?.title?.trim()
      || await resolvePlannedChapterTitle(input.root, input.chapterNumber);
    const text = await completeRole(resolved, [
      `撰写第 ${input.chapterNumber} 章${title ? `《${title}》` : ""}。只输出章节正文 Markdown。`,
      wordCount ? `目标约 ${wordCount} 字（±15%）。` : "",
      input.requirements ? `本章要求：${input.requirements}` : "",
      existing ? `当前已有正文（可在此基础上改写）：\n${existing.slice(0, 8000)}` : "",
      ctx.text,
      previous ? `上一章结尾：\n${previous.slice(-2000)}` : "",
    ].filter(Boolean).join("\n"), input.llm);
    const artifactId = newArtifactId("write", `ch${input.chapterNumber}`);
    await saveArtifact(input.root, {
      artifactId,
      stage: "write",
      scope,
      version: 1,
      source: "generate",
      status: "candidate",
      bodyPath: `chapters/${chapterFileName(input.chapterNumber, title ?? "")}`,
      parentArtifactId: undefined,
      inputRefs: ctx.refs,
      createdAt: new Date().toISOString(),
      runId,
      title: title || undefined,
      label: title
        ? `第${input.chapterNumber}章 ${title}`
        : `第${input.chapterNumber}章候选`,
    }, text);
    await writeRun(input.root, {
      ...baseRun,
      status: "completed",
      progressDone: 1,
      progressLabel: `第 ${input.chapterNumber} 章已写成`,
      producedArtifactIds: [artifactId],
    }, input.onProgress);
    const manifest = await loadManifest(input.root);
    await saveManifest(input.root, {
      ...manifest,
      candidates: {
        ...manifest.candidates,
        write: { ...manifest.candidates.write, [String(input.chapterNumber)]: artifactId },
      },
      lastRunId: runId,
    });
    return { artifactId, runId, body: text };
  } catch (error) {
    await writeRun(input.root, {
      ...baseRun,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      progressLabel: `第 ${input.chapterNumber} 章未写成`,
    }, input.onProgress);
    throw error;
  }
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
  const startedAt = new Date().toISOString();
  await writeRun(input.root, {
    runId,
    stage: "write",
    operation: "review",
    roleId: "write.review",
    status: "running",
    bookId: input.root.bookId,
    scope: loaded.meta.scope,
    progressLabel: "正在审查正文",
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [],
    createdAt: startedAt,
  }, input.onProgress);
  try {
    const ctx = await assembleAuthoringContext(input.root, { stage: "write", chapterNumber });
    const { canon } = await loadCanonDocument(input.root);
    const extras = [
      ctx.text,
      canon.chapterWordCount ? `核对篇幅：目标约 ${canon.chapterWordCount} 字（±15%），明显偏短或偏长请指出。` : "",
    ].filter(Boolean).join("\n");
    const text = await completeRole(
      resolved,
      reviewPrompt("write", coverage, loaded.body, extras),
      input.llm,
    );
    const report = parseReviewPayload(text, {
      stage: "write",
      targetRefs: [loaded.meta.artifactId],
      coverage,
      model: resolved.modelId,
      runId,
      inputRefs: [{ kind: "artifact", id: loaded.meta.artifactId, version: loaded.meta.version }, ...ctx.refs],
    });
    await saveReport(input.root, report);
    await writeRun(input.root, {
      runId,
      stage: "write",
      operation: "review",
      roleId: "write.review",
      status: "completed",
      bookId: input.root.bookId,
      scope: loaded.meta.scope,
      reportId: report.reportId,
      progressDone: 1,
      progressTotal: 1,
      progressLabel: "审查完成",
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [],
      createdAt: startedAt,
    }, input.onProgress);
    return report;
  } catch (error) {
    await writeRun(input.root, {
      runId,
      stage: "write",
      operation: "review",
      roleId: "write.review",
      status: "failed",
      bookId: input.root.bookId,
      scope: loaded.meta.scope,
      error: error instanceof Error ? error.message : String(error),
      progressLabel: "审查失败",
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [],
      createdAt: startedAt,
    }, input.onProgress);
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
  readonly onProgress?: (run: AuthoringRunRecord) => void;
}): Promise<{ artifactId: string; version: number; runId: string }> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  const report = await loadReport(input.root, input.reportId);
  if (!loaded || !report) throw new Error("按意见修改需要正文和报告。");
  assertReportReusable(report, loaded.meta.artifactId, input.reuseStale);
  const selected = report.issues.filter((issue) => input.selectedIssueIds.includes(issue.issueId));
  if (selected.length === 0) throw new Error("先选择要处理的意见。");
  const resolved = await resolve(input.project, "write.main", input.root.projectRoot);
  const chapterNumber = Number(loaded.meta.scope.replace("chapter:", "")) || undefined;
  const runId = input.runId ?? newRunId();
  const startedAt = new Date().toISOString();
  await writeRun(input.root, {
    runId,
    stage: "write",
    operation: "revise",
    roleId: "write.main",
    status: "running",
    bookId: input.root.bookId,
    scope: loaded.meta.scope,
    reportId: input.reportId,
    progressLabel: "正在按意见修改正文",
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [],
    createdAt: startedAt,
  }, input.onProgress);
  try {
  const ctx = await assembleAuthoringContext(input.root, { stage: "write", chapterNumber });
  const text = await completeRole(resolved, [
    "按选中意见修改正文。只输出完整章节 Markdown。不要声称已经复审通过。",
    `报告 ${report.reportId}`,
    ...selected.map((issue) => `- ${issue.issueId} ${issue.title}: ${issue.suggestion ?? ""}`),
    input.extraRequirement ? `作者补充：${input.extraRequirement}` : "",
    ctx.text,
    loaded.body,
  ].filter(Boolean).join("\n"), input.llm);
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
  await writeRun(input.root, {
    runId,
    stage: "write",
    operation: "revise",
    roleId: "write.main",
    status: "completed",
    bookId: input.root.bookId,
    scope: loaded.meta.scope,
    reportId: input.reportId,
    progressDone: 1,
    progressTotal: 1,
    progressLabel: "修订完成",
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [nextId],
    createdAt: startedAt,
  }, input.onProgress);
  return { artifactId: nextId, version, runId };
  } catch (error) {
    await writeRun(input.root, {
      runId,
      stage: "write",
      operation: "revise",
      roleId: "write.main",
      status: "failed",
      bookId: input.root.bookId,
      scope: loaded.meta.scope,
      reportId: input.reportId,
      error: error instanceof Error ? error.message : String(error),
      progressLabel: "修订失败",
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [],
      createdAt: startedAt,
    }, input.onProgress);
    throw error;
  }
}

export async function adoptChapterDraft(input: WriteRuntime & {
  readonly artifactId: string;
  readonly settle?: AuthoringLlmFn;
  readonly deferSettle?: boolean;
}): Promise<{ adopted: true; settled: boolean; settleError?: string }> {
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
    || (loaded.meta.bodyPath.startsWith("chapters/") ? loaded.meta.bodyPath.replace(/\\/g, "/") : undefined);
  const persisted = await persistAdoptedChapter({
    bookDir,
    chapterNumber,
    title,
    body: loaded.body,
    relativePath,
  });
  await saveArtifact(input.root, {
    ...loaded.meta,
    status: "adopted",
    title,
    bodyPath: persisted.relativePath,
  }, loaded.body);
  const manifest = await loadManifest(input.root);
  await saveManifest(input.root, {
    ...manifest,
    adopted: {
      ...manifest.adopted,
      write: { ...manifest.adopted.write, [chapter]: loaded.meta.artifactId },
    },
    coverage: {
      ...manifest.coverage,
      chaptersWrittenAdopted: Object.keys({ ...manifest.adopted.write, [chapter]: loaded.meta.artifactId }).length,
    },
  });
  try {
    await new StateManager(input.root.projectRoot).snapshotState(input.root.bookId, chapterNumber);
  } catch {
    /* snapshots are optional on lightweight books */
  }
  if (input.deferSettle) {
    return { adopted: true, settled: false };
  }
  const settled = await settleAdoptedChapter({
    root: input.root,
    project: input.project,
    llm: input.llm,
    settle: input.settle,
    artifactId: loaded.meta.artifactId,
  });
  return { adopted: true, settled: settled.settled, settleError: settled.settleError };
}

export async function settleAdoptedChapter(input: WriteRuntime & {
  readonly artifactId: string;
  readonly settle?: AuthoringLlmFn;
  readonly runId?: string;
  readonly onProgress?: (run: AuthoringRunRecord) => void;
}): Promise<{ settled: boolean; settleError?: string; runId: string }> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  if (!loaded) throw new Error("找不到要整理状态的正文。");
  const chapter = loaded.meta.scope.replace("chapter:", "");
  const chapterNumber = Number(chapter) || 1;
  const resolved = await resolve(input.project, "write.main", input.root.projectRoot);
  const runId = input.runId ?? newRunId();
  const startedAt = new Date().toISOString();
  await writeRun(input.root, {
    runId,
    stage: "write",
    operation: "settle",
    roleId: "write.main",
    status: "running",
    bookId: input.root.bookId,
    scope: loaded.meta.scope,
    progressLabel: `正在整理第 ${chapterNumber} 章状态`,
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [loaded.meta.artifactId],
    createdAt: startedAt,
  }, input.onProgress);
  try {
    const note = await completeRole(resolved, [
      "根据刚采用的正文整理人物状态与伏笔变化。只输出 Markdown 摘要，不要改正文。",
      loaded.body.slice(0, 8000),
    ].join("\n"), input.settle ?? input.llm);
    await writeChapterState(input.root, chapterNumber, loaded.meta.artifactId, note);
    await writeRun(input.root, {
      runId,
      stage: "write",
      operation: "settle",
      roleId: "write.main",
      status: "completed",
      bookId: input.root.bookId,
      scope: loaded.meta.scope,
      progressDone: 1,
      progressTotal: 1,
      progressLabel: `第 ${chapterNumber} 章状态已整理`,
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [loaded.meta.artifactId],
      createdAt: startedAt,
    }, input.onProgress);
    return { settled: true, runId };
  } catch (error) {
    const settleError = error instanceof Error ? error.message : String(error);
    await invalidateChapterState(input.root, chapterNumber);
    await writeRun(input.root, {
      runId,
      stage: "write",
      operation: "settle",
      roleId: "write.main",
      status: "failed",
      bookId: input.root.bookId,
      scope: loaded.meta.scope,
      error: settleError,
      progressLabel: "状态整理未完成",
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [loaded.meta.artifactId],
      createdAt: startedAt,
    }, input.onProgress);
    return { settled: false, settleError, runId };
  }
}

export async function saveWriteBody(input: WriteRuntime & {
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

export async function bindRestoredChapter(input: {
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

export function diffLines(before: string, after: string): Array<{ kind: "add" | "del" | "same"; text: string }> {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  const rows: Array<{ kind: "add" | "del" | "same"; text: string }> = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if (a[i] === b[i]) {
      if (a[i] !== undefined) rows.push({ kind: "same", text: a[i]! });
    } else {
      if (a[i] !== undefined) rows.push({ kind: "del", text: a[i]! });
      if (b[i] !== undefined) rows.push({ kind: "add", text: b[i]! });
    }
  }
  return rows;
}
