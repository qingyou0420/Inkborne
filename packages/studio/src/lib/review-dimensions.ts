/**
 * Group review notes by the aspect an author actually reads.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const ORDER = ["情节推进", "人物一致", "伏笔", "节奏", "文笔", "其他"];

function dimensionOf(issue: unknown): string | undefined {
  if (!issue || typeof issue !== "object" || !("dimension" in issue)) return undefined;
  const value = issue.dimension;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function groupReviewIssues<T>(
  issues: readonly T[],
): ReadonlyArray<{ readonly dimension: string; readonly issues: readonly T[] }> {
  if (!issues.some((issue) => dimensionOf(issue))) {
    return [{ dimension: "", issues }];
  }
  const buckets = new Map<string, T[]>();
  for (const issue of issues) {
    const name = dimensionOf(issue) || "其他";
    const list = buckets.get(name) ?? [];
    list.push(issue);
    buckets.set(name, list);
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    const ai = ORDER.indexOf(a);
    const bi = ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b, "zh");
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return keys.map((dimension) => ({ dimension, issues: buckets.get(dimension) ?? [] }));
}
