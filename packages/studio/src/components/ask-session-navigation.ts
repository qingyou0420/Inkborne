/** Apply conversation changes only after the manuscript navigation guard accepts. SPDX-License-Identifier: AGPL-3.0-only */
export interface AskSessionNav {
  toAsk: (id: string, sessionId?: string, onAccepted?: () => void) => void;
  toBookCreate: (sessionId?: string, onAccepted?: () => void) => void;
}

export function initialAskHistoryScope(currentBookId?: string): string {
  return currentBookId ? `book:${currentBookId}` : "new";
}

export function navigateAskSession(nav: AskSessionNav, bookId: string | null, sessionId: string | undefined, onAccepted: () => void): void {
  if (bookId === null) nav.toBookCreate(sessionId, onAccepted);
  else nav.toAsk(bookId, sessionId, onAccepted);
}
