/**
 * Hold the book write lock around authoring mutations.
 *
 * Background stages retry this same lock. While 落笔 or another write-stage
 * run holds it, they keep waiting instead of giving up after a few seconds.
 * 落笔 and hand edits keep waitMs 0 and fail immediately when the book is busy.
 * The async context records which book it holds, so a caller that already has
 * the lock can patch the manifest without acquiring it again.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { StateManager, isBookWriteLockError, type BookLockOwnerInfo } from "../state/manager.js";
import { AuthoringRunCancelledError } from "./store.js";
import type { AuthoringStoreRoot } from "./store.js";

/** Stable token. Studio `error-copy` maps this exact code to the user sentence. */
export const BACKGROUND_SAVE_DEFERRED = "BACKGROUND_SAVE_DEFERRED";

export class BackgroundSaveDeferredError extends Error {
  readonly code = BACKGROUND_SAVE_DEFERRED;
  readonly owner?: BookLockOwnerInfo;

  constructor(owner?: BookLockOwnerInfo) {
    super(BACKGROUND_SAVE_DEFERRED);
    this.name = "BackgroundSaveDeferredError";
    this.owner = owner;
  }
}

export function isBackgroundSaveDeferredError(error: unknown): error is BackgroundSaveDeferredError {
  return error instanceof BackgroundSaveDeferredError
    || (error instanceof Error && (error as { code?: unknown }).code === BACKGROUND_SAVE_DEFERRED);
}

export class BookWriteLockNotHeldError extends Error {
  readonly code = "BOOK_LOCK_NOT_HELD";

  constructor(readonly bookId: string) {
    super(`Book write lock is not held for "${bookId}".`);
    this.name = "BookWriteLockNotHeldError";
  }
}

interface HeldBookWrite {
  readonly key: string;
  readonly signal: AbortSignal;
}

const bookWriteContext = new AsyncLocalStorage<readonly HeldBookWrite[]>();

export function bookWriteLockKey(projectRoot: string, bookId: string): string {
  const lockPath = resolve(projectRoot, "books", bookId, ".write.lock");
  return process.platform === "win32" ? lockPath.toLowerCase() : lockPath;
}

/** True when this async call stack already entered withBookWriteLock for the book. */
export function bookWriteLockHeld(projectRoot: string, bookId: string): boolean {
  const key = bookWriteLockKey(projectRoot, bookId);
  return (bookWriteContext.getStore() ?? []).some((entry) => entry.key === key);
}

const WRITING_BOOK_LOCK_STAGES = new Set([
  "落笔",
  "审查本章",
  "按意见修改",
  "采用正文",
  "整理状态",
  "保存手改",
  "选择稿件",
  "恢复正文",
]);

export function isWritingBookLockStage(stage: string | undefined): boolean {
  if (!stage) return false;
  if (WRITING_BOOK_LOCK_STAGES.has(stage)) return true;
  return stage.includes("落笔") || /^write(?:[.:\s-]|$)/i.test(stage);
}

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
  const held: HeldBookWrite = {
    key: bookWriteLockKey(root.projectRoot, root.bookId),
    signal: abort.signal,
  };
  const parent = bookWriteContext.getStore() ?? [];
  try {
    return await bookWriteContext.run([...parent, held], () => fn(abort.signal));
  } finally {
    await release();
  }
}

/**
 * Short budget when some other stage holds the lock.
 * 25 × 200ms is about five seconds.
 */
export const BACKGROUND_LOCK_ATTEMPTS = 25;
export const BACKGROUND_LOCK_DELAY_MS = 200;
/**
 * While a write-stage run holds the lock, keep waiting.
 * 36000 × 200ms is about two hours. Abort still stops the wait immediately.
 */
export const BACKGROUND_LOCK_WRITING_ATTEMPTS = 36_000;

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
  return new Promise((resolveRetry, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveRetry();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AuthoringRunCancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function attemptCap(writing: boolean, options: BackgroundBookWriteOptions): number {
  if (options.maxAttempts != null) return options.maxAttempts;
  return writing ? BACKGROUND_LOCK_WRITING_ATTEMPTS : BACKGROUND_LOCK_ATTEMPTS;
}

/**
 * Run a short manifest/catalog write on the book lock. Model calls stay outside.
 * If 落笔 or another write-stage run holds the lock, wait until it releases,
 * until the writing attempt cap, or until `signal` aborts. Any other holder
 * still uses the short attempt budget. The callback must re-read and patch
 * only its own fields.
 */
export async function withBackgroundBookWrite<T>(
  root: AuthoringStoreRoot,
  stage: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: BackgroundBookWriteOptions = {},
): Promise<T> {
  const delayMs = options.delayMs ?? BACKGROUND_LOCK_DELAY_MS;
  let lastError: unknown;
  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await withBookWriteLock(root, stage, fn);
    } catch (error) {
      if (!isBookWriteLockError(error)) throw error;
      lastError = error;
      const writing = isWritingBookLockStage(error.owner?.stage);
      if (attempt >= attemptCap(writing, options)) {
        if (writing) throw new BackgroundSaveDeferredError(error.owner);
        throw error;
      }
      await waitForRetry(delayMs, options.signal);
    }
  }
}
