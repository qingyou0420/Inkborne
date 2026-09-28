/**
 * Hold the book write lock around authoring mutations.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from "node:crypto";
import { StateManager } from "../state/manager.js";
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
