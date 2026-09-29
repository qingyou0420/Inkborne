/** SPDX-License-Identifier: AGPL-3.0-only */
import type { AuthoringReport, AuthoringWorkspace } from "../lib/authoring-workspace";
import type { SessionRuntime } from "../store/chat/types";

export function isAskSession(session: Pick<SessionRuntime, "bookId" | "sessionKind"> | null | undefined, bookId?: string): boolean {
  if (!session || session.bookId !== (bookId ?? null)) return false;
  return bookId ? !session.sessionKind || session.sessionKind === "book" : session.sessionKind === "book-create";
}

export function askConversation(session: Pick<SessionRuntime, "bookId" | "sessionKind" | "messages"> | null | undefined, bookId?: string): string {
  if (!isAskSession(session, bookId)) return "";
  return (session?.messages ?? []).map((message) => {
    const text = message.content || message.parts?.filter((part) => part.type === "text").map((part) => part.content).join("\n") || "";
    return text.trim() ? `${message.role}: ${text}` : "";
  }).filter(Boolean).join("\n");
}

export function askReportState(reports: ReadonlyArray<AuthoringReport> | undefined, artifactId: string | undefined, dirty: boolean) {
  const askReports = (reports ?? []).filter((report) => report.stage === "ask");
  const report = askReports.find((item) => artifactId && item.targetRefs.includes(artifactId)) ?? askReports[0];
  return { report, stale: Boolean(report && (dirty || report.stale || !artifactId || !report.targetRefs.includes(artifactId))) };
}

interface AskCanonDraft {
  readonly body: string;
  readonly savedBody: string;
  readonly editBaseId?: string;
  readonly pendingSavedId?: string;
}

const pendingCanonEdits = new Map<string, AskCanonDraft>();
let unloadGuardInstalled = false;

function installUnloadGuard() {
  if (unloadGuardInstalled || typeof window === "undefined") return;
  unloadGuardInstalled = true;
  window.addEventListener("beforeunload", (event) => {
    if (pendingCanonEdits.size === 0) return;
    event.preventDefault(); event.returnValue = "";
  });
}

export function askCanonScopeKey(bookId?: string, sessionId?: string): string | undefined {
  return bookId ? `book:${bookId}` : sessionId ? `draft:${sessionId}` : undefined;
}

/** Session-only drafts; the adopted canon is never written by this editor state. */
export function createAskCanonEditor(scopeKey: string | undefined) {
  installUnloadGuard();
  let state: AskCanonDraft = (scopeKey && pendingCanonEdits.get(scopeKey)) || { body: "", savedBody: "" };
  const dirty = () => state.body !== state.savedBody;
  return {
    get snapshot() { return { ...state, dirty: dirty() }; },
    load(candidate: AuthoringWorkspace["candidateAsk"], busy = false): boolean {
      if (dirty() || busy || (state.pendingSavedId && state.pendingSavedId !== candidate?.artifactId)) return false;
      const body = candidate?.body ?? "";
      if (!state.pendingSavedId && state.editBaseId === candidate?.artifactId && state.body === body) return false;
      state = { body, savedBody: body, editBaseId: candidate?.artifactId };
      return true;
    },
    change(body: string) {
      state = { ...state, body };
      if (!scopeKey) return;
      if (dirty()) pendingCanonEdits.set(scopeKey, state);
      else pendingCanonEdits.delete(scopeKey);
    },
    discard() {
      state = { ...state, body: state.savedBody };
      if (scopeKey) pendingCanonEdits.delete(scopeKey);
    },
    expectCandidate(artifactId: string) {
      state = { ...state, pendingSavedId: artifactId };
    },
    async save(write: (baseId: string, body: string) => Promise<{ artifactId: string }>): Promise<string | undefined> {
      if (!dirty()) return state.pendingSavedId ?? state.editBaseId;
      if (!state.editBaseId) throw new Error("找不到手稿的原候选，请重新加载。");
      const draft = state;
      const buffered = scopeKey ? pendingCanonEdits.get(scopeKey) : undefined;
      const saved = await write(draft.editBaseId!, draft.body);
      state = { body: draft.body, savedBody: draft.body, editBaseId: saved.artifactId, pendingSavedId: saved.artifactId };
      // A second mount may already contain newer typing while this request finishes.
      if (scopeKey && pendingCanonEdits.get(scopeKey) === buffered) pendingCanonEdits.delete(scopeKey);
      return saved.artifactId;
    },
  };
}
