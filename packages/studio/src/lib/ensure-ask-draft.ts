/** Share the two Ask panels' simultaneous draft creation. SPDX-License-Identifier: AGPL-3.0-only */
import { postApi } from "../hooks/use-api";

const pendingDrafts = new Map<string, Promise<{ draftId: string }>>();
export function ensureAskDraft(sessionId: string): Promise<{ draftId: string }> {
  const pending = pendingDrafts.get(sessionId);
  if (pending) return pending;
  const request = postApi<{ draftId: string }>("/authoring/drafts/ensure", { sessionId });
  pendingDrafts.set(sessionId, request);
  void request.finally(() => { if (pendingDrafts.get(sessionId) === request) pendingDrafts.delete(sessionId); }).catch(() => undefined);
  return request;
}
