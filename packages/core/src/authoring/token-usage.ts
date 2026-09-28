/**
 * Add token counts from successive authoring calls into one run.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { AuthoringTokenUsage } from "./types.js";

export function combineAuthoringUsage(
  left: AuthoringTokenUsage | undefined,
  right: AuthoringTokenUsage | undefined,
): AuthoringTokenUsage | undefined {
  if (!left && !right) return undefined;
  const promptTokens = (left?.promptTokens ?? 0) + (right?.promptTokens ?? 0);
  const completionTokens = (left?.completionTokens ?? 0) + (right?.completionTokens ?? 0);
  const summed = (left?.totalTokens ?? 0) + (right?.totalTokens ?? 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens: summed > 0 ? summed : promptTokens + completionTokens,
  };
}

export function usageFromUnknown(error: unknown): AuthoringTokenUsage | undefined {
  if (!error || typeof error !== "object" || !("usage" in error)) return undefined;
  const usage = (error as { usage?: Partial<AuthoringTokenUsage> }).usage;
  if (!usage) return undefined;
  const promptTokens = Number(usage.promptTokens);
  const completionTokens = Number(usage.completionTokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) return undefined;
  const prompt = Math.max(0, Math.round(promptTokens));
  const completion = Math.max(0, Math.round(completionTokens));
  const totalRaw = Number(usage.totalTokens);
  const totalTokens = Number.isFinite(totalRaw) && totalRaw > 0 ? Math.round(totalRaw) : prompt + completion;
  return { promptTokens: prompt, completionTokens: completion, totalTokens };
}
