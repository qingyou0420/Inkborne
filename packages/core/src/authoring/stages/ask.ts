/**
 * 问心: chat → canon candidate → optional review → adopt + lightweight book.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCanon, serializeCanon } from "../canon.js";
import { asNumber, asString, asStringArray, extractJsonObject } from "../json.js";
import { completeRole } from "../llm.js";
import { fillMissingAuthoringRoles, loadRoleApiKeys, resolveAuthoringRole } from "../model-config.js";
import { assertReportReusable, parseReviewPayload, reviewPrompt } from "../review.js";
import {
  loadArtifact,
  loadManifest,
  loadReport,
  newArtifactId,
  newRunId,
  saveArtifact,
  saveManifest,
  saveReport,
  saveRun,
  type AuthoringStoreRoot,
} from "../store.js";
import { createLightweightBook, syncBookJsonTitle } from "../book-create.js";
import type {
  AuthoringLlmFn,
  AuthoringReviewReport,
  CanonDocument,
  ResolvedAuthoringRole,
} from "../types.js";
import type { ProjectConfig } from "../../models/project.js";

export interface AskRuntime {
  readonly root: AuthoringStoreRoot;
  readonly project: ProjectConfig;
  readonly llm?: AuthoringLlmFn;
}

function rolesOf(project: ProjectConfig) {
  return fillMissingAuthoringRoles(project);
}

async function resolve(
  project: ProjectConfig,
  role: "ask.main" | "ask.review",
  projectRoot?: string,
): Promise<ResolvedAuthoringRole> {
  return resolveAuthoringRole({
    roleId: role,
    baseLlm: project.llm,
    roles: rolesOf(project),
    apiKeys: projectRoot ? await loadRoleApiKeys(projectRoot) : undefined,
  });
}

function canonFromJson(raw: Record<string, unknown>, fallbackTitle: string): CanonDocument {
  return {
    title: asString(raw.title) || fallbackTitle,
    genre: asString(raw.genre) || undefined,
    targetChapters: asNumber(raw.targetChapters),
    chapterWordCount: asNumber(raw.chapterWordCount),
    oneLine: asString(raw.oneLine) || asString(raw.一句话故事),
    proposition: asString(raw.proposition) || asString(raw.核心命题),
    protagonist: asString(raw.protagonist) || asString(raw.主角),
    conflict: asString(raw.conflict) || asString(raw.主要冲突),
    voice: asString(raw.voice) || asString(raw.文风),
    boundaries: asString(raw.boundaries) || asString(raw.边界),
    direction: asString(raw.direction) || asString(raw.方向),
    openQuestions: asStringArray(raw.openQuestions).length
      ? asStringArray(raw.openQuestions)
      : asStringArray(raw.待定项),
  };
}

export async function generateAskCanon(input: AskRuntime & {
  readonly conversation: string;
  readonly requirements?: string;
  readonly baseCanon?: CanonDocument;
  readonly keepHandEdits?: boolean;
}): Promise<{ artifactId: string; version: number; canon: CanonDocument; runId: string }> {
  const manifest = await loadManifest(input.root);
  const parentId = manifest.candidates.ask ?? manifest.adopted.ask;
  const parent = parentId ? await loadArtifact(input.root, parentId) : undefined;
  const baseCanon = input.baseCanon ?? (parent ? parseCanon(parent.body) : undefined);
  const keepHandEdits = input.keepHandEdits ?? Boolean(parent);
  const resolved = await resolve(input.project, "ask.main", input.root.projectRoot);
  const runId = newRunId();
  await saveRun(input.root, {
    runId,
    stage: "ask",
    operation: "generate",
    roleId: "ask.main",
    status: "running",
    bookId: input.root.bookId,
    draftId: input.root.draftId,
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const prompt = [
    "根据对话整理一份故事正典。只输出 JSON。",
    "字段：title, genre, targetChapters, chapterWordCount, oneLine, proposition, protagonist, conflict, voice, boundaries, direction, openQuestions[]。",
    keepHandEdits ? "保留作者已手改的字段，只更新需要改的部分。" : "",
    input.requirements ? `补充要求：${input.requirements}` : "",
    baseCanon ? `当前正典：\n${serializeCanon(baseCanon)}` : "",
    "对话：",
    input.conversation.slice(0, 12000),
  ].filter(Boolean).join("\n");
  try {
    const text = await completeRole(resolved, prompt, input.llm);
    const canon = canonFromJson(extractJsonObject(text), baseCanon?.title || "未命名");
    const body = serializeCanon(canon);
    const version = (parent?.meta.version ?? 0) + 1;
    const artifactId = newArtifactId("ask", "canon");
    await saveArtifact(input.root, {
      artifactId,
      stage: "ask",
      scope: "canon",
      version,
      parentVersion: parent?.meta.version,
      parentArtifactId: parent?.meta.artifactId,
      source: "generate",
      status: "candidate",
      bodyPath: `artifacts/${artifactId}/body.md`,
      inputRefs: [],
      createdAt: new Date().toISOString(),
      runId,
      label: `正典 v${version}`,
    }, body);
    const nextManifest = await loadManifest(input.root);
    await saveManifest(input.root, {
      ...nextManifest,
      candidates: { ...nextManifest.candidates, ask: artifactId },
      lastRunId: runId,
    });
    await saveRun(input.root, {
      runId,
      stage: "ask",
      operation: "generate",
      roleId: "ask.main",
      status: "completed",
      bookId: input.root.bookId,
      draftId: input.root.draftId,
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [artifactId],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { artifactId, version, canon, runId };
  } catch (error) {
    await saveRun(input.root, {
      runId,
      stage: "ask",
      operation: "generate",
      roleId: "ask.main",
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      bookId: input.root.bookId,
      draftId: input.root.draftId,
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    throw error;
  }
}

export async function reviewAskCanon(input: AskRuntime & {
  readonly artifactId: string;
  readonly conversation?: string;
}): Promise<AuthoringReviewReport> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  if (!loaded) throw new Error("找不到要审查的正典。");
  const resolved = await resolve(input.project, "ask.review", input.root.projectRoot);
  const runId = newRunId();
  const extras = [
    input.conversation ? `【作者对话】\n${input.conversation.slice(0, 8000)}` : "",
  ].filter(Boolean).join("\n");
  const text = await completeRole(
    resolved,
    reviewPrompt("ask", "故事正典全文", loaded.body, extras),
    input.llm,
  );
  const report = parseReviewPayload(text, {
    stage: "ask",
    targetRefs: [loaded.meta.artifactId],
    coverage: "故事正典全文",
    model: resolved.modelId,
    runId,
    inputRefs: [
      { kind: "artifact", id: loaded.meta.artifactId, version: loaded.meta.version },
      ...(input.conversation ? [{ kind: "conversation", id: "ask-chat" }] : []),
    ],
  });
  await saveReport(input.root, report);
  await saveRun(input.root, {
    runId,
    stage: "ask",
    operation: "review",
    roleId: "ask.review",
    status: "completed",
    reportId: report.reportId,
    bookId: input.root.bookId,
    draftId: input.root.draftId,
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return report;
}

export async function reviseAskCanon(input: AskRuntime & {
  readonly artifactId: string;
  readonly reportId: string;
  readonly selectedIssueIds: readonly string[];
  readonly extraRequirement?: string;
  readonly reuseStale?: boolean;
}): Promise<{ artifactId: string; version: number; canon: CanonDocument }> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  const report = await loadReport(input.root, input.reportId);
  if (!loaded || !report) throw new Error("修订需要已有正典和审查报告。");
  assertReportReusable(report, loaded.meta.artifactId, input.reuseStale);
  const selected = report.issues.filter((issue) => input.selectedIssueIds.includes(issue.issueId));
  if (selected.length === 0) throw new Error("先选择要处理的意见。");
  const resolved = await resolve(input.project, "ask.main", input.root.projectRoot);
  const prompt = [
    "按选中的审查意见更新正典。只输出 JSON，字段同生成正典。",
    `报告 ${report.reportId}，选中：`,
    ...selected.map((issue) => `- ${issue.issueId} ${issue.title}: ${issue.suggestion ?? issue.reason ?? ""}`),
    input.extraRequirement ? `作者补充：${input.extraRequirement}` : "",
    "当前正典：",
    loaded.body,
  ].filter(Boolean).join("\n");
  const text = await completeRole(resolved, prompt, input.llm);
  const canon = canonFromJson(extractJsonObject(text), parseCanon(loaded.body).title);
  const version = loaded.meta.version + 1;
  const artifactId = newArtifactId("ask", "canon");
  await saveArtifact(input.root, {
    artifactId,
    stage: "ask",
    scope: "canon",
    version,
    parentVersion: loaded.meta.version,
    parentArtifactId: loaded.meta.artifactId,
    source: "revise",
    status: "candidate",
    bodyPath: `artifacts/${artifactId}/body.md`,
    inputRefs: [{ kind: "report", id: report.reportId }],
    createdAt: new Date().toISOString(),
    label: `正典 v${version}`,
  }, serializeCanon(canon));
  const manifest = await loadManifest(input.root);
  await saveManifest(input.root, {
    ...manifest,
    candidates: { ...manifest.candidates, ask: artifactId },
  });
  return { artifactId, version, canon };
}

export async function adoptAskCanon(input: AskRuntime & {
  readonly artifactId: string;
  readonly language?: "zh" | "en";
}): Promise<{ bookId: string; created: boolean; artifactId: string }> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  if (!loaded) throw new Error("找不到可采用的正典。");
  const canon = parseCanon(loaded.body);
  if (input.root.bookId) {
    const bookDir = join(input.root.projectRoot, "books", input.root.bookId);
    await writeFile(join(bookDir, "story", "canon.md"), serializeCanon(canon), "utf-8");
    await syncBookJsonTitle(bookDir, canon);
    await saveArtifact(input.root, { ...loaded.meta, status: "adopted", bodyPath: "story/canon.md" }, loaded.body);
    const manifest = await loadManifest(input.root);
    const previous = manifest.adopted.ask;
    await saveManifest(input.root, {
      ...manifest,
      adopted: { ...manifest.adopted, ask: loaded.meta.artifactId },
      watches: previous && previous !== loaded.meta.artifactId
        ? [
            ...manifest.watches,
            {
              id: `ask-${Date.now()}`,
              stage: "ground",
              sourceKind: "canon",
              sourceId: loaded.meta.artifactId,
              label: "正典已采用新版本，设定可能需要核对",
              acknowledged: false,
            },
            {
              id: `ask-weave-${Date.now()}`,
              stage: "weave",
              sourceKind: "canon",
              sourceId: loaded.meta.artifactId,
              label: "正典已采用新版本，大纲可能需要核对",
              acknowledged: false,
            },
          ]
        : manifest.watches,
    });
    return { bookId: input.root.bookId, created: false, artifactId: loaded.meta.artifactId };
  }
  const created = await createLightweightBook({
    projectRoot: input.root.projectRoot,
    canon,
    draftId: input.root.draftId,
    language: input.language,
    fromArtifact: loaded,
  });
  return { bookId: created.bookId, created: created.created, artifactId: loaded.meta.artifactId };
}
