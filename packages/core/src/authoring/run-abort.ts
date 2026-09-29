/**
 * One AbortController per book per authoring run.
 *
 * The cancel route aborts this signal. Model calls keep running until the
 * stage passes the signal through; registration is removed when the run ends.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { AuthoringRunCancelledError } from "./store.js";

interface RunAbortEntry {
  readonly bookId?: string;
  readonly controller: AbortController;
}

const runs = new Map<string, RunAbortEntry>();

function storageKey(bookId: string | undefined, runId: string): string {
  return `${bookId ?? ""}::${runId}`;
}

function runIdOf(key: string): string {
  const index = key.lastIndexOf("::");
  return index < 0 ? key : key.slice(index + 2);
}

/** Register the controller for this book and run. A second begin returns the same signal. */
export function beginAuthoringRun(bookId: string | undefined, runId: string): AbortSignal {
  const key = storageKey(bookId, runId);
  const existing = runs.get(key);
  if (existing) return existing.controller.signal;
  const controller = new AbortController();
  runs.set(key, { bookId, controller });
  return controller.signal;
}

/**
 * Abort the run. A book id limits the abort to that book; omit it to abort
 * every registration of this run id (落笔 streaming still cancels by run id).
 */
export function abortAuthoringRun(bookId: string | undefined, runId: string): boolean {
  if (bookId) {
    const entry = runs.get(storageKey(bookId, runId));
    if (!entry) return false;
    if (!entry.controller.signal.aborted) entry.controller.abort();
    return true;
  }
  let aborted = false;
  for (const [key, entry] of runs) {
    if (runIdOf(key) !== runId) continue;
    if (!entry.controller.signal.aborted) entry.controller.abort();
    aborted = true;
  }
  return aborted;
}

export function endAuthoringRun(bookId: string | undefined, runId: string): void {
  runs.delete(storageKey(bookId, runId));
}

export function isAuthoringRunAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof AuthoringRunCancelledError) return true;
  return error instanceof Error && error.name === "AbortError";
}
