/** Startup decisions are based on a successfully loaded collection only.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { HashRoute } from "../hooks/use-hash-route";
import type { StudioStageId } from "./appearance";

export function bookResumeStage(
  book: { readonly id: string; readonly stage?: string },
  lastStages: Readonly<Record<string, StudioStageId>>,
): StudioStageId {
  if (lastStages[book.id]) return lastStages[book.id];
  return book.stage === "ground" || book.stage === "weave" || book.stage === "write" ? book.stage : "ask";
}

export function stageRoute(bookId: string, stage: StudioStageId): HashRoute {
  if (stage === "ask") return { page: "book-ask", bookId };
  if (stage === "ground") return { page: "book-ground", bookId };
  if (stage === "weave") return { page: "book-weave", bookId };
  return { page: "book-write", bookId };
}

export function isStartupHomeHash(hash: string): boolean {
  return hash === "" || hash === "#" || hash === "#/";
}

export function startupBookRoute(
  books: ReadonlyArray<{ readonly id: string; readonly stage?: string }>,
  lastStages: Readonly<Record<string, StudioStageId>>,
): HashRoute | null {
  const book = books.length === 1 ? books[0] : undefined;
  return book ? stageRoute(book.id, bookResumeStage(book, lastStages)) : null;
}
