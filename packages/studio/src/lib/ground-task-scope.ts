/** SPDX-License-Identifier: AGPL-3.0-only */
import type { AuthoringCatalogEntry, AuthoringReport } from "./authoring-workspace";

/** Filling empty entries must never replace an existing candidate or adopted text. */
export function groundGenerationScope(entries: ReadonlyArray<AuthoringCatalogEntry>, selectedIds: ReadonlyArray<string>) {
  const visible = entries.filter((entry) => !entry.archived);
  const selected = visible.filter((entry) => selectedIds.includes(entry.id));
  if (selectedIds.length) return { entryIds: selected.map((entry) => entry.id), regenerate: true };
  const missing = visible.filter((entry) => !entry.candidateArtifactId && !entry.adoptedArtifactId);
  if (missing.length) return { entryIds: missing.map((entry) => entry.id), regenerate: false };
  return { entryIds: visible.map((entry) => entry.id), regenerate: true };
}

/** Match the backend's issue target mapping, never the currently focused directory entry. */
export function groundRevisionScope(entries: ReadonlyArray<AuthoringCatalogEntry>, report: AuthoringReport, issueIds: ReadonlyArray<string>, reuseStale = false): { entryIds: string[] } | { error: "unavailable-report" | "unknown-issue" | "unavailable-target" | "changed-version" } {
  if (report.stage !== "ground" || report.incomplete || (report.stale && !reuseStale)) return { error: "unavailable-report" };
  const ids = [...new Set(issueIds)];
  if (!ids.length || ids.some((id) => !report.issues.some((issue) => issue.issueId === id))) return { error: "unknown-issue" };
  const entryIds: string[] = [];
  for (const issue of report.issues.filter((item) => ids.includes(item.issueId))) {
    // Use the same first match as reviseGroundEntry; archived matches cannot silently fall through.
    const entry = entries.find((item) => item.id === issue.target || item.name === issue.target);
    const currentId = entry?.candidateArtifactId ?? entry?.adoptedArtifactId;
    if (!entry || entry.archived || !currentId) return { error: "unavailable-target" };
    if (!reuseStale && !report.targetRefs.includes(currentId)) return { error: "changed-version" };
    if (!entryIds.includes(entry.id)) entryIds.push(entry.id);
  }
  return { entryIds };
}
