/**
 * Hold the book write lock around authoring mutations.
 *
 * Background stages retry this same lock briefly. 落笔 and hand edits keep
 * waitMs 0 and fail immediately when the book is busy.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from "node:crypto";
import { StateManager, isBookWriteLockError } from "../state/manager.js";
import { AuthoringRunCancelledError } from "./store.js";
import type { AuthoringStoreRoot } from "./store.js";

export async function withBookWriteLock<T>(
  root: AuthoringStoreRoot,
  stage: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!root.bookId) return fn(new AbortController().signal);
  const abort = new AbortController();
  const release = await new StateManager(root.projectRoot).acquireBookLock(
    root.bookId,
    { stage, taskId: `${stage}-${randomUUID().slice(0, 8)}`, abort },
    { waitMs: 0 },
  );
  try {
    return await fn(abort.signal);
  } finally {
    await release();
  }
}

/** Background persist gives the writer a few seconds, then stops. */
export const BACKGROUND_LOCK_ATTEMPTS = 25;
export const BACKGROUND_LOCK_DELAY_MS = 200;

export interface BackgroundBookWriteOptions {
  readonly signal?: AbortSignal;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AuthoringRunCancelledError();
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AuthoringRunCancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run a short manifest/catalog write on the book lock. Model calls stay outside.
 * If 落笔 still holds the lock, wait and retry until the attempt or time limit,
 * or until `signal` aborts. The callback must re-read and patch only its own fields.
 */
export async function withBackgroundBookWrite<T>(
  root: AuthoringStoreRoot,
  stage: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: BackgroundBookWriteOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? BACKGROUND_LOCK_ATTEMPTS;
  const delayMs = options.delayMs ?? BACKGROUND_LOCK_DELAY_MS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await withBookWriteLock(root, stage, fn);
    } catch (error) {
      if (!isBookWriteLockError(error)) throw error;
      lastError = error;
      if (attempt === maxAttempts) break;
      await waitForRetry(delayMs, options.signal);
    }
  }
  throw lastError;
}
