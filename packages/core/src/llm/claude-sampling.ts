/**
 * Claude Opus 4.7/4.8/5 and Sonnet 5 reject non-default sampling values.
 * Omit the deprecated fields at the transport boundary, including when a
 * worker overrides the temperature or a gateway uses a vendor-prefixed ID.
 * https://platform.claude.com/docs/zh-CN/models/opus-5/migration-guide
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";

function omitsClaudeSampling(model: string): boolean {
  return /(?:^|[/.])claude-(?:opus-(?:4[-.][78]|5)|sonnet-5)(?=$|[-.:])/i.test(model.trim());
}

export function applyClaudeSamplingConstraints<T>(payload: T, model: string): T {
  if (!omitsClaudeSampling(model) || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const body = payload as Record<string, unknown>;
  delete body.temperature;
  delete body.top_p;
  delete body.top_k;
  return payload;
}

/** Keep caller hooks, then sanitize the final SDK payload just before HTTP. */
export function constrainClaudeSamplingOptions(
  model: string,
  options: SimpleStreamOptions,
): SimpleStreamOptions {
  if (!omitsClaudeSampling(model)) return options;
  const next = { ...options };
  delete next.temperature;
  next.onPayload = async (payload, piModel) => {
    const replacement = await options.onPayload?.(payload, piModel);
    return applyClaudeSamplingConstraints(replacement === undefined ? payload : replacement, model);
  };
  return next;
}
