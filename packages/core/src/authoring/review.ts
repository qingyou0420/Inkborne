/**
 * Normalize four-stage review reports.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from "node:crypto";
import { asString, asStringArray, extractJsonObject } from "./json.js";
import {
  isJsonResponseFormatUnsupported,
  shouldAttemptJsonResponseFormat,
  completeRole,
} from "./llm.js";
import { normalizeReviewDimension, WRITE_REVIEW_DIMENSIONS } from "./review-checks.js";
import type { AuthoringLlmFn, AuthoringReviewReport, AuthoringStage, ResolvedAuthoringRole, ReviewIssue, ReviewIssueSeverity } from "./types.js";

const SEVERITY_MAP: Record<string, ReviewIssueSeverity> = {
  priority: "priority",
  优先: "priority",
  优先处理: "priority",
  critical: "priority",
  error: "priority",
  improve: "improve",
  可改善: "improve",
  warning: "improve",
  style: "style",
  风格: "style",
  风格建议: "style",
  suggestion: "style",
};

export function parseReviewPayload(raw: string, fallback: {
  readonly stage: AuthoringStage;
  readonly targetRefs: readonly string[];
  readonly coverage: string;
  readonly model: string;
  readonly runId?: string;
  readonly inputRefs?: AuthoringReviewReport["inputRefs"];
  readonly rawExcerpt?: string;
}): AuthoringReviewReport {
  let json: Record<string, unknown> = {};
  try {
    json = extractJsonObject(raw);
  } catch {
    json = {};
  }
  const keys = Object.keys(json);
  const hasSummary = Boolean(asString(json.summary) || asString(json.总体评语));
  const hasIssuesField = Array.isArray(json.issues);
  const incomplete = keys.length === 0 || (!hasSummary && !hasIssuesField);
  const issuesRaw = hasIssuesField ? json.issues as unknown[] : [];
  const issues: ReviewIssue[] = incomplete ? [] : issuesRaw.map((item, index) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const severityKey = asString(row.severity) || asString(row.程度);
    return {
      issueId: asString(row.issueId) || asString(row.id) || `issue-${index + 1}`,
      title: asString(row.title) || asString(row.标题) || `意见 ${index + 1}`,
      severity: SEVERITY_MAP[severityKey] ?? "improve",
      target: asString(row.target) || asString(row.目标) || asString(row.targetRef) || asString(row.entryId) || undefined,
      evidence: asString(row.evidence) || asString(row.原文) || undefined,
      sources: asStringArray(row.sources),
      reason: asString(row.reason) || asString(row.原因) || undefined,
      suggestion: asString(row.suggestion) || asString(row.建议) || undefined,
      suggestedScope: asString(row.suggestedScope) || undefined,
      dimension: normalizeReviewDimension(asString(row.dimension) || asString(row.维度)),
    };
  });
  const rawExcerpt = fallback.rawExcerpt?.trim();
  return {
    reportId: randomUUID(),
    stage: fallback.stage,
    targetRefs: [...fallback.targetRefs],
    coverage: asString(json.coverage) || fallback.coverage,
    inputRefs: fallback.inputRefs ? [...fallback.inputRefs] : [],
    actualReviewModel: fallback.model,
    createdAt: new Date().toISOString(),
    summary: incomplete
      ? "本次审查结果不完整，请重试。"
      : asString(json.summary) || asString(json.总体评语) || (issues.length === 0 ? "本次未发现需修改的问题" : "请查看下列意见。"),
    issues,
    stale: false,
    incomplete,
    ...(rawExcerpt ? { rawExcerpt } : {}),
    runId: fallback.runId,
  };
}

export function reviewPayloadIncomplete(raw: string): boolean {
  try {
    const json = extractJsonObject(raw);
    const hasSummary = Boolean(asString(json.summary) || asString(json.总体评语));
    const hasIssuesField = Array.isArray(json.issues);
    return Object.keys(json).length === 0 || (!hasSummary && !hasIssuesField);
  } catch {
    return true;
  }
}

export function mergeDeterministicIssues(
  report: AuthoringReviewReport,
  checks: readonly ReviewIssue[],
): AuthoringReviewReport {
  if (checks.length === 0) return report;
  const seen = new Set(report.issues.map((issue) => issue.issueId));
  const extra = checks.filter((issue) => !seen.has(issue.issueId));
  if (extra.length === 0) return report;
  const summary = report.incomplete
    ? `模型这次没有给出完整审查，原文附在下面。自动检查先发现 ${extra.length} 条。`
    : `${report.summary} 自动检查另有 ${extra.length} 条，写在对应方面里。`;
  return {
    ...report,
    summary,
    issues: [...extra, ...report.issues],
  };
}

function clipRaw(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 4000) return trimmed;
  return `${trimmed.slice(0, 4000)}\n……（后面还有，已截断）`;
}

/** Ask for review JSON. OpenAI-compatible relays get response_format; others keep the text parser. */
export async function requestReviewModelText(input: {
  readonly resolved: ResolvedAuthoringRole;
  readonly prompt: string;
  readonly llm?: AuthoringLlmFn;
  readonly signal?: AbortSignal;
  readonly system?: string;
}): Promise<{ text: string; rawExcerpt?: string }> {
  const allowFormat = shouldAttemptJsonResponseFormat(input.resolved);
  const once = (format: boolean) => completeRole(
    input.resolved,
    input.prompt,
    input.llm,
    input.signal,
    {
      ...(format ? { responseFormat: "json_object" as const } : {}),
      ...(input.system ? { system: input.system } : {}),
    },
  );
  let text: string;
  try {
    text = await once(allowFormat);
  } catch (error) {
    if (!(allowFormat && isJsonResponseFormatUnsupported(error))) throw error;
    text = await once(false);
  }
  if (!reviewPayloadIncomplete(text)) return { text };
  let second = text;
  try {
    second = await once(false);
  } catch {
    return { text, rawExcerpt: clipRaw(text) };
  }
  if (!reviewPayloadIncomplete(second)) return { text: second };
  const kept = second.trim() ? second : text;
  return { text: kept, rawExcerpt: clipRaw(kept) };
}

export function reviewPrompt(stage: AuthoringStage, coverage: string, body: string, extras?: string): string {
  if (stage === "write") return writeReviewPrompt(coverage, body, extras);
  return [
    `请审查以下${stageLabel(stage)}成果。覆盖范围：${coverage}。`,
    extras ?? "",
    "只输出 JSON，字段：summary, coverage, issues[]。",
    "每条 issue 含 issueId, title, severity(priority|improve|style), target, evidence, reason, suggestion。",
    stage === "ground"
      ? "target 必须是设定条目 id（如 shen），不要用顺序号或第一条默认目标。"
      : "target 指向具体段落、条目或章节号。",
    "必须对照上方依据判断是否违背正典、设定或规划。不要把作者主动保留的未知写成缺陷。不要改稿。",
    "",
    body,
  ].filter(Boolean).join("\n");
}

function writeReviewPrompt(coverage: string, body: string, extras?: string): string {
  const dimensions = WRITE_REVIEW_DIMENSIONS
    .map((item, index) => `${index + 1}. ${item.label}：${item.hint}`)
    .join("\n");
  return [
    `请审查以下正文成果。覆盖范围：${coverage}。`,
    extras ?? "",
    "按下面几个方面看，用作者能直接看懂的话，不要用编号，不要用英文术语：",
    dimensions,
    "只输出 JSON，不要代码围栏，不要解释。字段：summary, coverage, issues[]。",
    "每条 issue 含 issueId, dimension, title, severity(priority|improve|style), target, evidence, reason, suggestion。",
    `dimension 只能是：${WRITE_REVIEW_DIMENSIONS.map((item) => item.label).join("、")}。`,
    "suggestion 写成作者下一句就能改的人话，不要写「建议优化」「提升表达」这种空话。",
    "某个方面没问题就不要为了凑数硬编。target 指向具体段落或章节号。",
    "必须对照上方依据判断是否违背正典、设定或规划。不要把作者主动保留的未知写成缺陷。不要改稿。",
    "",
    body,
  ].filter(Boolean).join("\n");
}

export function assertReportReusable(report: AuthoringReviewReport, artifactId: string, reuseStale?: boolean): void {
  if (report.incomplete) throw new Error("这份审查结果不完整，请重新审查。");
  const applies = report.targetRefs.includes(artifactId);
  if (!applies && !reuseStale) {
    throw new Error("这份报告对应旧稿。请审查当前稿，或明确沿用这些建议。");
  }
  if (report.stale && !reuseStale) {
    throw new Error("这份报告对应旧稿。请审查当前稿，或明确沿用这些建议。");
  }
}

function stageLabel(stage: AuthoringStage): string {
  if (stage === "ask") return "正典";
  if (stage === "ground") return "设定";
  if (stage === "weave") return "规划";
  return "正文";
}
