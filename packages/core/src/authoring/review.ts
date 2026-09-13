/**
 * Normalize four-stage review reports.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from "node:crypto";
import { asString, asStringArray, extractJsonObject } from "./json.js";
import type { AuthoringReviewReport, AuthoringStage, ReviewIssue, ReviewIssueSeverity } from "./types.js";

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
}): AuthoringReviewReport {
  const json = extractJsonObject(raw);
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
    };
  });
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
    runId: fallback.runId,
  };
}

export function reviewPrompt(stage: AuthoringStage, coverage: string, body: string, extras?: string): string {
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
