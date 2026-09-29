/** SPDX-License-Identifier: AGPL-3.0-only */
import type { AuthoringReport } from "./authoring-workspace";

/** Only current, complete reports can be carried into a fresh generation implicitly. */
export function generationReviewNotes(report: AuthoringReport | null | undefined, artifactIds: ReadonlyArray<string | undefined>): string | undefined {
  if (!report || report.stale || report.incomplete || !artifactIds.length || artifactIds.some((id) => !id || !report.targetRefs.includes(id))) return undefined;
  return [report.summary, ...report.issues.map((issue) => `${issue.title}${issue.suggestion ? `：${issue.suggestion}` : ""}`)].filter(Boolean).join("\n");
}

export function withGenerationReview(requirements: string, notes?: string): string {
  return [requirements.trim(), notes && `审查意见 / Review notes:\n${notes}`].filter(Boolean).join("\n\n");
}
