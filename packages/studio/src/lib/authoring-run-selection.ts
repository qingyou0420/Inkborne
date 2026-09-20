/**
 * Pick the last authoring run that belongs to the current panel, and decide
 * how a failed run should be retried. Run records themselves stay unchanged.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const AUTHORING_FAILED_RUN_TAKEOVER_MS = 10 * 60 * 1000;

export interface AuthoringRunLike {
  readonly runId: string;
  readonly stage: string;
  readonly status: string;
  readonly operation?: string;
  readonly scope?: string;
  readonly updatedAt?: string;
  readonly producedArtifactIds?: ReadonlyArray<string>;
  readonly progressLabel?: string;
}

export function selectScopedAuthoringRun<T extends AuthoringRunLike>(
  runs: readonly T[] | undefined,
  stage: string,
  scope?: string,
): T | undefined {
  return runs?.find((item) => item.stage === stage && (scope === undefined || item.scope === scope));
}

export function shouldAutoTakeoverAuthoringRun(
  run: Pick<AuthoringRunLike, "status" | "updatedAt"> | undefined,
  now = Date.now(),
): boolean {
  if (!run) return false;
  if (run.status === "running" || run.status === "pausing") return true;
  if (run.status !== "failed" && run.status !== "partial") return false;
  if (!run.updatedAt) return false;
  const at = Date.parse(run.updatedAt);
  return Number.isFinite(at) && now - at <= AUTHORING_FAILED_RUN_TAKEOVER_MS;
}

export type WriteRetryAction = "settle" | "review" | "generate";

export function writeRetryAction(operation?: string): WriteRetryAction {
  if (operation === "settle") return "settle";
  if (operation === "review") return "review";
  return "generate";
}

export type AskRetryAction = "review" | "generate";

export function askRetryAction(operation?: string): AskRetryAction {
  return operation === "review" ? "review" : "generate";
}

export type GroundRetryAction = "review" | "catalog" | "generate";

export function groundRetryAction(
  run: Pick<AuthoringRunLike, "operation" | "progressLabel"> | undefined,
  hasEntries: boolean,
): GroundRetryAction {
  if (run?.operation === "review") return "review";
  if (!hasEntries) return "catalog";
  return "generate";
}

export function producedArtifactForScope(
  run: Pick<AuthoringRunLike, "scope" | "producedArtifactIds"> | undefined,
  scope: string,
): string | undefined {
  if (!run || (run.scope && run.scope !== scope)) return undefined;
  return run.producedArtifactIds?.[0];
}
