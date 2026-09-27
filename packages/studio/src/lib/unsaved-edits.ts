/**
 * Tracks editors that still have keystrokes the server has not stored.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { getDesktopBridge } from "./desktop-bridge";

const holders = new Set<() => boolean>();
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
  (window as Window & { __inkborneHasUnsavedEdits?: () => boolean }).__inkborneHasUnsavedEdits = hasUnsavedEdits;
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
