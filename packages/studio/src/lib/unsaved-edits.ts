/**
 * Tracks editors that still have keystrokes the server has not stored.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { getDesktopBridge } from "./desktop-bridge";

const holders = new Set<() => boolean>();
const flushers = new Set<() => Promise<void>>();
let installed = false;

function installUnsavedGuard(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("beforeunload", (event) => {
    if (getDesktopBridge()) return;
    if (!hasUnsavedEdits()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  const bridge = window as Window & {
    __inkborneHasUnsavedEdits?: () => boolean;
    __inkborneFlushUnsavedEdits?: () => Promise<void>;
  };
  bridge.__inkborneHasUnsavedEdits = hasUnsavedEdits;
  bridge.__inkborneFlushUnsavedEdits = flushUnsavedEdits;
}

export function hasUnsavedEdits(): boolean {
  for (const check of holders) {
    if (check()) return true;
  }
  return false;
}

export function registerUnsavedCheck(check: () => boolean): () => void {
  installUnsavedGuard();
  holders.add(check);
  return () => {
    holders.delete(check);
  };
}

export async function flushUnsavedEdits(): Promise<void> {
  const pending = [...flushers];
  await Promise.all(pending.map((flush) => flush()));
}

export function registerUnsavedFlush(flush: () => Promise<void>): () => void {
  installUnsavedGuard();
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}
