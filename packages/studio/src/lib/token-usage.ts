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

export function usageTotal(usage?: TokenUsage | null): number {
  if (!usage) return 0;
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) return usage.totalTokens;
  const prompt = typeof usage.promptTokens === "number" ? usage.promptTokens : 0;
  const completion = typeof usage.completionTokens === "number" ? usage.completionTokens : 0;
  const sum = prompt + completion;
  return sum > 0 ? sum : 0;
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
  return (runs ?? []).reduce((sum, run) => sum + usageTotal(run.usage), 0);
}

export interface PricedService {
  readonly service?: string;
  readonly name?: string;
  readonly pricePerMillion?: number;
}

export function serviceConfigKey(entry: PricedService): string {
  if (entry.service === "custom") return `custom:${entry.name ?? "Custom"}`;
  return entry.service ?? "";
}

/** Price of the connection this run actually used. Missing price stays unpriced. */
export function priceForServiceRef(
  serviceRef: string | undefined,
  services: readonly PricedService[] | undefined,
): number | undefined {
  const ref = serviceRef?.trim();
  if (!ref || !services?.length) return undefined;
  const match = services.find((entry) => serviceConfigKey(entry) === ref || entry.service === ref);
  const price = match?.pricePerMillion;
  return typeof price === "number" && price > 0 ? price : undefined;
}

export function estimateRunsCost(
  runs: ReadonlyArray<{ usage?: TokenUsage; modelSnapshot?: { serviceRef?: string } }> | undefined,
  services: readonly PricedService[] | undefined,
): string {
  let yuan = 0;
  let priced = false;
  let missing = false;
  for (const run of runs ?? []) {
    const tokens = usageTotal(run.usage);
    if (tokens <= 0) continue;
    const price = priceForServiceRef(run.modelSnapshot?.serviceRef, services);
    if (!price) {
      missing = true;
      continue;
    }
    yuan += (tokens / 1_000_000) * price;
    priced = true;
  }
  if (!priced) return "";
  const amount = yuan < 0.01 ? "不到 0.01 元" : `约 ${yuan.toFixed(2)} 元`;
  return missing ? `${amount}（没标价的连接没算进去）` : amount;
}

export function formatPassUsage(usage: TokenUsage | undefined, isZh: boolean, cost = ""): string {
  const total = usageTotal(usage);
  if (total <= 0) return "";
  const label = formatTokenCount(total, isZh);
  if (!label) return "";
  if (isZh) return `这次用了 ${label}${cost ? `（${cost}）` : ""}`;
  return `This pass used ${label}${cost ? ` (${cost})` : ""}`;
}

export function firstPricePerMillion(
  services: ReadonlyArray<{ pricePerMillion?: number }> | undefined,
): number | undefined {
  const price = services?.find((entry) => typeof entry.pricePerMillion === "number" && entry.pricePerMillion > 0)?.pricePerMillion;
  return price && price > 0 ? price : undefined;
}

/** Rough yuan estimate from an optional 元 / 百万 token price. Empty when the author left it blank. */
export function estimateTokenCost(totalTokens: number, pricePerMillion?: number): string {
  if (!pricePerMillion || pricePerMillion <= 0 || !Number.isFinite(totalTokens) || totalTokens <= 0) return "";
  const yuan = (totalTokens / 1_000_000) * pricePerMillion;
  if (yuan < 0.01) return "不到 0.01 元";
  return `约 ${yuan.toFixed(2)} 元`;
}
