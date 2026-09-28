/**
 * Plain-language token counts for the author.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export interface TokenUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export function formatTokenCount(total: number, isZh: boolean): string {
  if (!Number.isFinite(total) || total <= 0) return "";
  const rounded = Math.round(total);
  if (isZh && rounded >= 10000) {
    const wan = rounded / 10000;
    const label = wan >= 10 ? String(Math.round(wan)) : wan.toFixed(1).replace(/\.0$/, "");
    return `${label} 万 token`;
  }
  return isZh ? `${rounded.toLocaleString("zh-CN")} token` : `${rounded.toLocaleString("en-US")} tokens`;
}

export function sumTokenUsage(runs: ReadonlyArray<{ usage?: TokenUsage }> | undefined): number {
  return (runs ?? []).reduce((sum, run) => sum + (run.usage?.totalTokens ?? 0), 0);
}
