/** Ask-local source imports and conversation history. SPDX-License-Identifier: AGPL-3.0-only */
import { useEffect, useRef, useState } from "react";
import { FolderUp, History, X } from "lucide-react";
import { buildApiUrl, fetchJson, invalidateApiPaths, useApi } from "../hooks/use-api";
import { ensureAskDraft } from "../lib/ensure-ask-draft";
import type { TFunction } from "../hooks/use-i18n";
import { AskSessionDrawer } from "./AskSessionDrawer";
import type { AskSessionNav } from "./ask-session-navigation";
import { useChatStore } from "../store/chat";

interface Source {
  readonly id: string;
  readonly filename: string;
  readonly charCount: number;
  readonly coverage: "complete" | "invalid";
  readonly originalPath: string;
  readonly error?: string;
}

export function AskWorkspaceTools({ bookId, sessionId, importSources, nav, t, isZh }: {
  readonly bookId?: string;
  readonly sessionId?: string;
  readonly importSources?: boolean;
  readonly nav: AskSessionNav;
  readonly t: TFunction;
  readonly isZh: boolean;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(Boolean(importSources));
  const historyButton = useRef<HTMLButtonElement>(null);
  const books = useApi<{ books: Array<{ id: string; title: string }> }>(historyOpen ? "/books" : "");
  useEffect(() => { if (importSources) setSourcesOpen(true); }, [importSources]);
  return <>
    <div className="ask-workspace-tools">
      <button type="button" ref={historyButton} onClick={() => setHistoryOpen(true)}><History size={15} />{isZh ? "问心记录" : "Conversations"}</button>
      <button type="button" aria-expanded={sourcesOpen} aria-controls="ask-source-panel" onClick={() => setSourcesOpen((value) => !value)}><FolderUp size={15} />{isZh ? "导入资料" : "Import sources"}</button>
    </div>
    <AskSourcePanel key={bookId ? `book:${bookId}` : `session:${sessionId ?? "pending"}`} bookId={bookId} sessionId={sessionId} open={sourcesOpen} isZh={isZh} />
    <AskSessionDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} returnFocus={historyButton}
      books={books.data?.books ?? []} booksLoading={books.loading} booksError={books.error}
      onReloadBooks={() => void books.refetch()} currentBookId={bookId} nav={nav} t={t} isZh={isZh} />
  </>;
}

function AskSourcePanel({ bookId, sessionId, open, isZh }: {
  readonly bookId?: string; readonly sessionId?: string; readonly open: boolean; readonly isZh: boolean;
}) {
  const [draftId, setDraftId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [draftRetry, setDraftRetry] = useState(0);
  const requestBusy = useRef(false);
  const mounted = useRef(true);
  const uploadInput = useRef<HTMLInputElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (bookId || !sessionId || !open) return;
    let cancelled = false;
    void ensureAskDraft(sessionId).then((draft) => {
      if (!cancelled) { setDraftId(draft.draftId); setError(undefined); }
    }).catch((failure: unknown) => { if (!cancelled) setError(String(failure)); });
    return () => { cancelled = true; };
  }, [bookId, sessionId, open, draftRetry]);
  const query = bookId ? `bookId=${encodeURIComponent(bookId)}` : draftId ? `draftId=${encodeURIComponent(draftId)}` : "";
  const { data, loading, error: loadError, refetch } = useApi<{ sources: Source[]; maxChars: number }>(query && open ? `/authoring/ask/sources?${query}` : "");
  const sources = data?.sources ?? [];
  const changed = () => {
    invalidateApiPaths(["/api/v1/authoring/ask/sources", "/api/v1/authoring/workspace"]);
    void refetch();
  };
  const upload = async (file: File) => {
    if (!query || requestBusy.current) return;
    requestBusy.current = true;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      if (file.size > 18 * 1024 * 1024) throw new Error(isZh ? "每份资料最多 18 MB，请拆分后导入。" : "Each source is limited to 18 MB. Split it before importing.");
      if (sessionId) await useChatStore.getState().ensureSessionPersisted(sessionId);
      const body = new FormData();
      body.append("file", file);
      if (bookId) body.append("bookId", bookId);
      else if (draftId) body.append("draftId", draftId);
      const response = await fetch(buildApiUrl("/authoring/ask/sources")!, { method: "POST", body });
      const result = await response.json() as { source?: Source; error?: string };
      if (!response.ok || !result.source) throw new Error(result.error || (isZh ? "导入失败，请重试。" : "Import failed. Retry."));
      changed();
      if (mounted.current) setNotice(isZh
        ? `${result.source.filename} 已完整提取 ${result.source.charCount.toLocaleString()} 字符。点击下方「整理正典」生成候选；已有正典可在正典操作中「重新生成」。`
        : `${result.source.filename}: all ${result.source.charCount.toLocaleString()} characters extracted. Use Create canon below, or Regenerate in canon actions.`);
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { requestBusy.current = false; if (mounted.current) setBusy(false); }
  };
  const remove = async (source: Source) => {
    if (requestBusy.current) return;
    requestBusy.current = true;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await fetchJson(`/authoring/ask/sources/${encodeURIComponent(source.id)}?${query}`, { method: "DELETE" });
      changed();
      if (mounted.current) setNotice(isZh ? "已从整理依据中移除，原始文件仍保留。已有正典未改变。" : "Removed from sources. The original file and existing canon are retained.");
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { requestBusy.current = false; if (mounted.current) setBusy(false); }
  };
  if (!open) return null;
  return <section id="ask-source-panel" className="ask-source-panel" aria-label={isZh ? "问心资料" : "Ask sources"} aria-busy={busy}>
    <p>{isZh ? "旧作、母本、设定或文风参考，先交给问心整理为候选正典，再由你确认采用。不会自动写入正式章节。可在对话里说明要沿用什么、只参考什么。" : "Import earlier work, settings, or style references for a candidate canon you can review and adopt. Chapters are not imported automatically. Describe what to retain or use only as reference in the conversation."}</p>
    <p className="ask-source-hint">{isZh ? "支持 TXT、Markdown、文字型 PDF、HTML。原文件保留。每份最多 18 MB；全部资料合计最多 120,000 字符，超限会明确提示，不会只读取开头。" : "TXT, Markdown, text PDFs, and HTML. Originals are retained. Up to 18 MB per file and 120,000 extracted characters across sources. Oversized material is reported, never silently cut."}</p>
    <input ref={uploadInput} type="file" accept=".txt,.md,.markdown,.pdf,.html,.htm" hidden onChange={(event) => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
      if (file) void upload(file);
    }} />
    <button type="button" className="ask-source-select" disabled={busy || !query || loading || Boolean(loadError)} onClick={() => uploadInput.current?.click()}><FolderUp size={15} />{busy ? (isZh ? "处理中…" : "Processing…") : (isZh ? "选择资料文件" : "Choose source file")}</button>
    {sources.length ? <ul>{sources.map((source) => <li key={source.id}>
      <div><strong>{source.filename}</strong>{source.error ? <p role="alert" className="ask-source-error">{source.error}</p> : <span>{isZh ? `完整读取 · ${source.charCount.toLocaleString()} 字符` : `Complete · ${source.charCount.toLocaleString()} characters`}</span>}<small>{source.originalPath}</small></div>
      <button type="button" disabled={busy} onClick={() => void remove(source)} aria-label={isZh ? `移除资料 ${source.filename}，保留原文件` : `Remove ${source.filename}, keep original`} title={isZh ? "移除依据，保留原文件" : "Remove source, keep original"}><X size={16} /></button>
    </li>)}</ul> : null}
    {loading ? <p role="status">{isZh ? "正在读取资料…" : "Loading sources…"}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {error || loadError ? <div role="alert" className="ask-source-error"><p>{error ?? loadError}</p>{loadError || (!query && error) ? <button type="button" onClick={() => { setDraftRetry((value) => value + 1); void refetch(); }}>{isZh ? "重新加载" : "Reload"}</button> : null}</div> : null}
  </section>;
}
