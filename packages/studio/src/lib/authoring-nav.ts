/**
 * Hash jumps between the four authoring stages.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { routeToHash, type HashRoute } from "../hooks/use-hash-route";

export type AuthoringNavStage = "ask" | "ground" | "weave" | "write";

export function bookAuthoringHash(bookId: string, stage: AuthoringNavStage): string {
  const route: HashRoute = stage === "ask"
    ? { page: "book-ask", bookId }
    : stage === "ground"
      ? { page: "book-ground", bookId }
      : stage === "weave"
        ? { page: "book-weave", bookId }
        : { page: "book-write", bookId };
  return routeToHash(route);
}

export function goBookAuthoringStage(bookId: string, stage: AuthoringNavStage): void {
  if (!bookId.trim() || typeof window === "undefined") return;
  window.location.hash = bookAuthoringHash(bookId, stage);
}
