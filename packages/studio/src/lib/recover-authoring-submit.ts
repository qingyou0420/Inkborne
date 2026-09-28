/**
 * Recover a four-stage submit whose POST was accepted but the response was lost.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { fetchJson, StudioApiError } from "../hooks/use-api";

export const AUTHORING_SUBMIT_UNKNOWN_MESSAGE = "提交结果未知。请核对是否已有任务在运行，不要重复提交。";

export class AuthoringSubmitUnknownError extends Error {
  override readonly name = "AuthoringSubmitUnknownError";
  constructor(message = AUTHORING_SUBMIT_UNKNOWN_MESSAGE) {
    super(message);
  }
}

export interface RecoverableAuthoringRun {
  readonly runId: string;
  readonly status: string;
  readonly stage?: string;
  readonly operation?: string;
  readonly scope?: string;
  readonly progressLabel?: string;
}

export type AuthoringSubmitResult<T> =
  | { readonly kind: "ok"; readonly result: T }
  | { readonly kind: "bound"; readonly run: RecoverableAuthoringRun }
  | { readonly kind: "unknown" };

export function isLostSubmitResponse(error: unknown): boolean {
  if (error instanceof StudioApiError) {
    return error.kind === "transient" || error.kind === "unreachable";
  }
  return error instanceof TypeError && /Failed to fetch|NetworkError|Load failed/i.test(error.message);
}

export function isAuthoringSubmitUnknown(error: unknown): error is AuthoringSubmitUnknownError {
  return error instanceof AuthoringSubmitUnknownError;
}

export function matchActiveAuthoringSubmit(
  stage: string,
  operation: string,
  scope?: string,
): (run: RecoverableAuthoringRun) => boolean {
  return (run) => {
    if (run.stage !== stage || run.operation !== operation) return false;
    if (run.status !== "running" && run.status !== "pausing") return false;
    if (scope && run.scope && run.scope !== scope) return false;
    return true;
  };
}

export async function recoverAuthoringSubmit(options: {
  readonly readWorkspace: () => Promise<{ readonly runs?: ReadonlyArray<RecoverableAuthoringRun> }>;
  readonly match: (run: RecoverableAuthoringRun) => boolean;
}): Promise<{ kind: "bound"; run: RecoverableAuthoringRun } | { kind: "unknown" }> {
  try {
    const workspace = await options.readWorkspace();
    const found = (workspace.runs ?? []).find(options.match);
    if (found) return { kind: "bound", run: found };
  } catch {
    /* lookup failure is still unknown; never re-POST */
  }
  return { kind: "unknown" };
}

export async function submitAuthoringAction<T extends { runId?: string; status?: string }>(options: {
  readonly post: () => Promise<T>;
  readonly readWorkspace: () => Promise<{ readonly runs?: ReadonlyArray<RecoverableAuthoringRun> }>;
  readonly match: (run: RecoverableAuthoringRun) => boolean;
}): Promise<AuthoringSubmitResult<T>> {
  try {
    return { kind: "ok", result: await options.post() };
  } catch (error) {
    if (!isLostSubmitResponse(error)) throw error;
    return recoverAuthoringSubmit({ readWorkspace: options.readWorkspace, match: options.match });
  }
}

export function readAuthoringWorkspaceRuns(path: string): Promise<{ readonly runs?: ReadonlyArray<RecoverableAuthoringRun> }> {
  return fetchJson(path);
}
