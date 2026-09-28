/**
 * Drop secrets from a run before it is sent to the studio.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { AuthoringRunRecord } from "./types.js";
import { redactSecrets } from "../utils/redact-secrets.js";

const SENSITIVE_KEY = /^(api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|authorization|auth|secret|password|bearer|headers)$/i;

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) continue;
    out[key] = sanitizeValue(child);
  }
  return out;
}

export function sanitizeAuthoringRun<T extends { modelSnapshot?: unknown; error?: string }>(run: T): T {
  const snapshot = run.modelSnapshot && typeof run.modelSnapshot === "object"
    ? sanitizeValue(run.modelSnapshot) as Record<string, unknown>
    : {};
  return {
    ...run,
    modelSnapshot: snapshot,
    ...(typeof run.error === "string" ? { error: redactSecrets(run.error) } : {}),
  };
}

export function sanitizeAuthoringRuns(runs: readonly AuthoringRunRecord[]): AuthoringRunRecord[] {
  return runs.map((run) => sanitizeAuthoringRun(run));
}
