/**
 * Existing Ask conversations, reachable from the secondary navigation.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { TFunction } from "../hooks/use-i18n";
import { startFreshBookCreateSession } from "../pages/chat-page-state";
import { useChatStore } from "../store/chat";
import { bookKey } from "../store/chat/slices/message/runtime";
import type { SessionRuntime } from "../store/chat/types";
import type { AppMoreNav } from "./AppMoreMenu";
import { Dialog, DialogClose, DialogTitle } from "./ui/dialog";

interface BookSummary {
  readonly id: string;
  readonly title: string;
}

type EditTarget = { readonly sessionId: string; readonly title: string; readonly mode: "rename" | "delete" };

function sessionLabel(session: SessionRuntime, t: TFunction): string {
  return session.title?.trim()
    || session.messages.find((message) => message.role === "user")?.content.trim().replace(/\s+/g, " ").slice(0, 80)
    || t("nav.newAskPlaceholder");
}

export function AskSessionDrawer({
  open, onClose, returnFocus, books, booksLoading, booksError, onReloadBooks,
  currentBookId, nav, t, isZh,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly returnFocus: RefObject<HTMLButtonElement | null>;
  readonly books: ReadonlyArray<BookSummary>;
  readonly booksLoading: boolean;
  readonly booksError: string | null;
  readonly onReloadBooks: () => void;
  readonly currentBookId?: string;
  readonly nav: Pick<AppMoreNav, "toAsk" | "toBookCreate">;
  readonly t: TFunction;
  readonly isZh: boolean;
}) {
  const sessions = useChatStore((state) => state.sessions);
  const sessionIdsByBook = useChatStore((state) => state.sessionIdsByBook);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const bookDataVersion = useChatStore((state) => state.bookDataVersion);
  const loadSessionList = useChatStore((state) => state.loadSessionList);
  const [scope, setScope] = useState("new");
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [target, setTarget] = useState<EditTarget | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const operationBusy = useRef(false);
  const selectedBookId = scope.startsWith("book:") ? scope.slice(5) : null;
  const selectedBook = books.find((book) => book.id === selectedBookId);
  const bookLabel = selectedBook?.title ?? (isZh ? "尚未建书" : "Before creating a book");
  const rows = (sessionIdsByBook[bookKey(selectedBookId)] ?? [])
    .map((id) => sessions[id])
    .filter((session): session is SessionRuntime => Boolean(session)
      && session.bookId === selectedBookId
      && (selectedBookId === null
        ? session.sessionKind === "book-create"
        : !session.sessionKind || session.sessionKind === "book" || session.sessionKind === "book-create"));

  useEffect(() => {
    if (!open) return;
    setScope(currentBookId && books.some((book) => book.id === currentBookId) ? `book:${currentBookId}` : "new");
    setTarget(null);
    setError(null);
    setNotice(null);
    // Capture the current work when opened, without overriding later user selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadSessionList(selectedBookId, true).then(() => {
      if (!cancelled) setLoadedScope(scope);
    }).catch((err: unknown) => {
      if (!cancelled) {
        setLoadedScope(null);
        setError(`${isZh ? "问心记录加载失败" : "Could not load conversations"}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, selectedBookId, scope, retry, bookDataVersion, loadSessionList, isZh]);

  useEffect(() => {
    if (target?.mode === "rename") renameInput.current?.focus();
    if (target?.mode === "delete") cancelButton.current?.focus();
  }, [target]);

  const changeScope = (value: string) => {
    setScope(value);
    setTarget(null);
    setNotice(null);
  };

  const beginEdit = (session: SessionRuntime, mode: EditTarget["mode"]) => {
    setError(null);
    setNotice(null);
    setTitle(session.title ?? "");
    setTarget({ sessionId: session.sessionId, title: sessionLabel(session, t), mode });
  };

  const run = async (operation: () => Promise<void>, failure: string) => {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (err) {
      setError(`${failure}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      operationBusy.current = false;
      setBusy(false);
    }
  };

  const openSession = (sessionId: string) => run(async () => {
    const store = useChatStore.getState();
    await store.loadSessionDetail(sessionId, true);
    const session = useChatStore.getState().sessions[sessionId];
    if (!session || session.bookId !== selectedBookId || (selectedBookId === null && session.sessionKind !== "book-create")) {
      throw new Error(isZh ? "这条记录所属作品已改变，请刷新列表。" : "This conversation has moved. Refresh the list.");
    }
    store.setInput("");
    store.activateSession(sessionId);
    if (selectedBookId === null) nav.toBookCreate(sessionId);
    else nav.toAsk(selectedBookId, sessionId);
    onClose();
  }, isZh ? "无法打开问心记录" : "Could not open conversation");

  const confirmEdit = () => {
    if (!target || (target.mode === "rename" && !title.trim())) return;
    const editing = target;
    void run(async () => {
      const store = useChatStore.getState();
      const session = store.sessions[editing.sessionId];
      if (!session || session.bookId !== selectedBookId) {
        throw new Error(isZh ? "这条记录已改变，请刷新后重试。" : "This conversation changed. Refresh and retry.");
      }
      if (editing.mode === "rename") {
        await store.renameSession(editing.sessionId, title.trim(), true);
        setNotice(isZh ? "名称已保存。" : "Title saved.");
      } else {
        const wasActive = store.activeSessionId === editing.sessionId;
        await store.deleteSession(editing.sessionId, true);
        // Drop an explicit URL to the deleted session; the normal page selects the remaining conversation.
        if (wasActive) {
          if (selectedBookId === null) nav.toBookCreate();
          else nav.toAsk(selectedBookId);
        }
        setNotice(isZh ? "问心记录已删除。" : "Conversation deleted.");
      }
      setTarget(null);
    }, editing.mode === "rename"
      ? (isZh ? "名称保存失败，可重试" : "Could not save title; retry")
      : (isZh ? "删除失败，记录仍保留，可重试" : "Deletion failed; the conversation is retained. Retry"));
  };

  const newSession = () => {
    const store = useChatStore.getState();
    store.setInput("");
    if (selectedBookId === null) {
      startFreshBookCreateSession(store.createDraftSession);
      nav.toBookCreate();
    } else {
      const sessionId = store.createDraftSession(selectedBookId, "book");
      nav.toAsk(selectedBookId, sessionId);
    }
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !operationBusy.current) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[80] bg-foreground/20" />
        <DialogPrimitive.Popup
          data-testid="ask-session-drawer"
          finalFocus={returnFocus}
          className="fixed inset-y-0 right-0 z-[80] flex w-full max-w-[420px] flex-col border-l border-border bg-card px-6 py-6 text-foreground outline-none"
          aria-busy={busy || loading}
        >
          <div className="mb-5 flex items-center justify-between gap-3">
            <DialogTitle className="font-serif text-[18px] font-medium leading-[26px]">{t("nav.history")}</DialogTitle>
            <DialogClose disabled={busy} className="btn-ghost" aria-label={isZh ? "关闭问心记录" : "Close conversations"}><X size={18} /></DialogClose>
          </div>
          <label className="mb-4 grid gap-2 text-sm">
            <span>{isZh ? "所属作品" : "Work"}</span>
            <select
              value={scope}
              onChange={(event) => changeScope(event.target.value)}
              disabled={busy || booksLoading}
              className="h-10 w-full min-w-0 rounded-md border border-border-strong bg-card px-3 text-sm"
            >
              <option value="new">{isZh ? "尚未建书" : "Before creating a book"}</option>
              {books.map((book) => <option key={book.id} value={`book:${book.id}`}>{book.title}</option>)}
            </select>
          </label>
          {booksError ? <div role="alert" className="mb-4 text-sm text-destructive">{isZh ? "作品列表加载失败" : "Could not load works"}: {booksError}<button type="button" className="btn-ghost ml-2" onClick={onReloadBooks}>{isZh ? "重试" : "Retry"}</button></div> : null}
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm text-muted-foreground" title={bookLabel}>{bookLabel}</span>
            <button type="button" className="btn-ghost shrink-0" disabled={busy || loading} onClick={() => setRetry((value) => value + 1)}>{isZh ? "刷新" : "Refresh"}</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {error ? <p role="alert" className="mb-4 break-words text-sm text-destructive">{error}</p> : null}
            {notice ? <p role="status" className="mb-4 text-sm text-muted-foreground">{notice}</p> : null}
            {loading ? <p role="status" className="py-6 text-sm text-muted-foreground">{isZh ? "正在读取问心记录…" : "Loading conversations…"}</p> : loadedScope !== scope ? (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setRetry((value) => value + 1)}>{isZh ? "重新读取" : "Retry loading"}</button>
            ) : rows.length === 0 ? <p className="py-6 text-sm text-muted-foreground">{isZh ? "这里还没有问心记录。" : "No Ask conversations here yet."}</p> : (
              <ul className="divide-y divide-border">
                {rows.map((session) => {
                  const label = sessionLabel(session, t);
                  const editing = target?.sessionId === session.sessionId;
                  return (
                    <li key={session.sessionId} className="py-4" data-testid={`ask-session-${session.sessionId}`}>
                      <button
                        type="button"
                        disabled={busy}
                        className="block w-full break-words text-left text-sm leading-6 hover:underline underline-offset-4"
                        onClick={() => void openSession(session.sessionId)}
                        aria-current={activeSessionId === session.sessionId ? "true" : undefined}
                      >{label}</button>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className="text-muted-foreground">{session.isStreaming ? (isZh ? "进行中" : "Running") : activeSessionId === session.sessionId ? (isZh ? "当前会话" : "Current conversation") : null}</span>
                        <button type="button" className="btn-ghost" disabled={busy} aria-label={`${isZh ? "改名" : "Rename"}：${label}`} onClick={() => beginEdit(session, "rename")}>{isZh ? "改名" : "Rename"}</button>
                        <button type="button" className="btn-ghost" disabled={busy} aria-label={`${isZh ? "删除" : "Delete"}：${label}`} onClick={() => beginEdit(session, "delete")}>{isZh ? "删除" : "Delete"}</button>
                      </div>
                      {editing ? (
                        <form className="mt-3 space-y-3" onSubmit={(event) => { event.preventDefault(); confirmEdit(); }}>
                          {target.mode === "rename" ? <label className="grid gap-2 text-sm"><span>{t("nav.renameAsk")}</span><input ref={renameInput} value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} maxLength={200} className="h-10 w-full rounded-md border border-border-strong bg-card px-3" /></label> : (
                            <div className="space-y-2 text-sm">
                              <p className="font-medium">{t("nav.deleteAsk")}</p>
                              <p className="break-words">“{target.title}”</p>
                              <p className="text-muted-foreground">{t("nav.deleteAskHint")}{session.isStreaming ? (isZh ? " 这条记录正在运行，删除会同时停止其任务。" : " This conversation is running; deleting it also stops its task.") : null}</p>
                            </div>
                          )}
                          <div className="flex flex-wrap justify-end gap-2">
                            <button ref={cancelButton} type="button" className="btn-ghost" disabled={busy} onClick={() => { setTarget(null); setError(null); }}>{isZh ? "取消" : "Cancel"}</button>
                            <button type="submit" className={target.mode === "delete" ? "btn-danger" : "btn-primary"} disabled={busy || (target.mode === "rename" && !title.trim())}>
                              {busy ? (isZh ? "处理中…" : "Working…") : target.mode === "delete" ? (isZh ? "确认删除" : "Delete conversation") : (isZh ? "保存名称" : "Save title")}
                            </button>
                          </div>
                        </form>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="mt-4 border-t border-border pt-4">
            <button type="button" className="btn-primary" disabled={busy || booksLoading || (selectedBookId !== null && !selectedBook)} onClick={newSession}>{t("nav.newAsk")}</button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </Dialog>
  );
}
