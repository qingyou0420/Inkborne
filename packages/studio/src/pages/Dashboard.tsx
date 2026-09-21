/** Compact bookshelf with one new-book entry.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal, Plus, Search, UserRound } from "lucide-react";
import { fetchJson, useApi } from "../hooks/use-api";
import type { SSEMessage } from "../hooks/use-sse";
import { useI18n, type TFunction } from "../hooks/use-i18n";
import { removeBookFromCollection, removeShortFromCollection, shouldRefetchBookCollections } from "../hooks/use-book-activity";
import { deleteStudioShortWork } from "../lib/short-api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DefaultCover } from "../components/DefaultCover";
import { NewBookIntro } from "../components/NewBookIntro";
import { BookSettingsDrawer } from "../components/BookSettingsDrawer";
import { selectWorksListShorts, type StudioShortSummary } from "../shared/short-works";
import { bookManuscriptExportPath, shortManuscriptExportPath } from "../lib/work-export";
import type { AuthorPublic } from "../lib/author-profile";
import { STAGE_LABELS, type StudioStageId } from "../lib/appearance";
import { usePreferencesStore } from "../store/preferences";
import { useChatStore } from "../store/chat";
import { bookResumeStage } from "../lib/home-navigation";
import { BOOK_COVER_ACCEPT, validateBookCoverFile } from "../lib/book-cover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";

export interface HomeBookSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly stage?: string;
  readonly chaptersWritten: number;
  readonly targetChapters?: number;
  readonly coverImagePath?: string;
}
interface Nav {
  toBook: (id: string) => void;
  toBookSettings: (id: string) => void;
  toAnalytics: (id: string) => void;
  toBookIntro: () => void;
  toBookCreate: (sessionId?: string) => void;
  toServices: () => void;
  toAuthor: () => void;
  toAsk: (id: string) => void;
  toGround: (id: string) => void;
  toWeave: (id: string) => void;
  toWrite: (id: string) => void;
  toImport: (tab?: "chapters" | "canon" | "fanfic" | "spinoff" | "imitation") => void;
  toShort: (id: string) => void;
  toShortSettings: (id: string) => void;
  toShortAnalytics: (id: string) => void;
}
function goBookStage(nav: Nav, bookId: string, stage: StudioStageId) {
  if (stage === "ask") nav.toAsk(bookId);
  else if (stage === "ground") nav.toGround(bookId);
  else if (stage === "weave") nav.toWeave(bookId);
  else nav.toWrite(bookId);
}
function downloadWork(path: string) {
  const link = document.createElement("a");
  link.href = path;
  link.download = "";
  link.click();
}
export function Dashboard({ nav, sse, t }: { nav: Nav; sse: { messages: ReadonlyArray<SSEMessage> }; theme?: unknown; t: TFunction }) {
  const { lang } = useI18n();
  const isZh = lang !== "en";
  const { data: author } = useApi<AuthorPublic>("/author");
  const { data, loading, error, refetch, mutate } = useApi<{ books: ReadonlyArray<HomeBookSummary> }>("/books");
  const { data: shortsData, loading: shortsLoading, error: shortsError, refetch: refetchShorts, mutate: mutateShorts } = useApi<{ shorts: ReadonlyArray<StudioShortSummary> }>("/shorts");
  const shorts = selectWorksListShorts(shortsData);
  const books = data?.books ?? [];
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);
  const bumpBookDataVersion = useChatStore((s) => s.bumpBookDataVersion);
  const lastStages = usePreferencesStore((s) => s.lastStages);
  const setCurrentBookId = usePreferencesStore((s) => s.setCurrentBookId);
  const [query, setQuery] = useState("");
  const [operationError, setOperationError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: "book" | "short"; id: string; title: string } | null>(null);
  const [settingsBookId, setSettingsBookId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const coverTargetRef = useRef<HomeBookSummary | null>(null);
  const coverFileRef = useRef<HTMLInputElement>(null);
  const search = query.trim().toLocaleLowerCase();
  const visibleBooks = useMemo(() => books.filter((book) => `${book.title} ${book.genre}`.toLocaleLowerCase().includes(search)), [books, search]);
  const visibleShorts = useMemo(() => shorts.filter((short) => short.title.toLocaleLowerCase().includes(search)), [shorts, search]);
  const reload = () => { void refetch(); void refetchShorts(); };
  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (recent && shouldRefetchBookCollections(recent)) { void refetch(); void refetchShorts(); }
  }, [sse.messages, refetch, refetchShorts]);
  useEffect(() => { void refetch(); void refetchShorts(); }, [bookDataVersion, refetch, refetchShorts]);

  const updateStatus = async (book: HomeBookSummary, status: "active" | "paused") => {
    setOperationError(null);
    setPending(true);
    try {
      await fetchJson(`/books/${encodeURIComponent(book.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
      bumpBookDataVersion();
    } catch (err) { setOperationError(err instanceof Error ? err.message : (isZh ? "未能更新作品状态。" : "Could not update the work.")); }
    finally { setPending(false); }
  };
  const pickCover = (book: HomeBookSummary) => {
    setOperationError(null);
    coverTargetRef.current = book;
    coverFileRef.current?.click();
  };
  const uploadCover = async (file: File) => {
    const book = coverTargetRef.current;
    if (!book) return;
    const invalid = validateBookCoverFile(file, isZh);
    if (invalid) {
      setOperationError(invalid);
      return;
    }
    setPending(true);
    setOperationError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      await fetchJson(`/books/${encodeURIComponent(book.id)}/cover`, { method: "POST", body });
      bumpBookDataVersion();
      reload();
    } catch (err) {
      setOperationError(err instanceof Error ? err.message : (isZh ? "封面未保存，请重新选择。" : "Could not save the cover. Please select it again."));
    } finally {
      setPending(false);
      coverTargetRef.current = null;
    }
  };
  const removeCover = async (book: HomeBookSummary) => {
    setPending(true);
    setOperationError(null);
    try {
      await fetchJson(`/books/${encodeURIComponent(book.id)}/cover`, { method: "DELETE" });
      bumpBookDataVersion();
      reload();
    } catch (err) {
      setOperationError(err instanceof Error ? err.message : (isZh ? "封面未能移除。" : "Could not remove the cover."));
    } finally {
      setPending(false);
    }
  };
  const deleteWork = async () => {
    if (!deleteTarget || pending) return;
    setPending(true);
    setOperationError(null);
    try {
      if (deleteTarget.kind === "book") {
        await fetchJson(`/books/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" });
        mutate((current) => current ? { books: removeBookFromCollection(current.books, deleteTarget.id) } : current);
      } else {
        await deleteStudioShortWork(deleteTarget.id);
        mutateShorts((current) => current ? { shorts: removeShortFromCollection(current.shorts, deleteTarget.id) } : current);
      }
      setDeleteTarget(null);
      bumpBookDataVersion();
      reload();
    } catch (err) { setOperationError(err instanceof Error ? err.message : (isZh ? "作品未删除，请重试。" : "Could not delete the work. Please retry.")); setDeleteTarget(null); }
    finally { setPending(false); }
  };
  if (!data && (loading || !error) || !shortsData && shortsLoading) return <div className="ink-home-loading" role="status">{t("common.loading")}</div>;
  if (!data && error) return <div className="ink-home-error" role="alert"><h1>{isZh ? "书架暂时未能打开" : "Could not open the bookshelf"}</h1><p>{error}</p><button type="button" className="btn-secondary" onClick={reload}>{isZh ? "重新读取" : "Retry"}</button></div>;
  const hasWorks = books.length + shorts.length > 0;
  if (!hasWorks && !shortsError) return <NewBookIntro isZh={isZh} onEnterAsk={nav.toBookCreate} />;
  const avatar = author?.hasAvatar ? `/api/v1/author/avatar?v=${encodeURIComponent(author.updatedAt ?? "")}` : "";
  return <section className="ink-bookshelf" data-testid="home-page">
    <div className="ink-shelf-heading">
      <div className="ink-shelf-author">
        <span className="ink-author-avatar">{avatar ? <img src={avatar} alt="" /> : <UserRound size={22} strokeWidth={1.2} />}</span>
        <span>{author?.name?.trim() || (isZh ? "未署名" : "Unnamed author")}</span>
      </div>
      <button type="button" className="btn-primary" onClick={nav.toBookIntro} data-testid="shelf-new-book"><Plus size={15} />{isZh ? "新书" : "New book"}</button>
    </div>
    {operationError ? <p role="alert" className="text-sm text-destructive">{operationError}</p> : null}
    {shortsError ? <p role="alert" className="text-sm text-destructive">{isZh ? "短篇列表未能读取。" : "Could not load short works."}<button type="button" onClick={() => void refetchShorts()}>{isZh ? "重试" : "Retry"}</button></p> : null}
    {books.length + shorts.length > 6 || search ? <label className="ink-shelf-search"><Search size={15} /><input aria-label={isZh ? "查找作品" : "Find a work"} placeholder={isZh ? "查找作品" : "Find a work"} value={query} onChange={(event) => setQuery(event.target.value)} /></label> : null}
    {search && visibleBooks.length + visibleShorts.length === 0 ? <div className="ink-shelf-no-results"><p>{isZh ? "没有找到这部作品" : "No matching works"}</p><button type="button" className="btn-secondary" onClick={() => setQuery("")}>{isZh ? "清除搜索" : "Clear search"}</button></div> : null}
    <div className="ink-shelf-grid" data-testid="home-shelf-active">
      {visibleBooks.map((book) => {
        const stage = bookResumeStage(book, lastStages);
        const label = isZh ? STAGE_LABELS[stage].zh : STAGE_LABELS[stage].en;
        const status = book.status === "paused" ? (isZh ? "暂停" : "Paused") : book.status === "completed" ? (isZh ? "完结" : "Complete") : book.status === "dropped" ? (isZh ? "已搁置" : "Shelved") : "";
        return <article key={book.id} className="ink-shelf-book" data-testid={`home-book-${book.id}`}>
          <button type="button" className="ink-book-open" onClick={() => { setCurrentBookId(book.id); goBookStage(nav, book.id, stage); }} aria-label={isZh ? `继续《${book.title}》 · ${label}` : `Continue ${book.title} · ${label}`}>
            <DefaultCover title={book.title} coverSrc={book.coverImagePath} />
            <h2 title={book.title}>{book.title}</h2>
            <p>{label}{status ? ` · ${status}` : ""}</p>
          </button>
          <DropdownMenu><DropdownMenuTrigger className="ink-book-menu" aria-label={isZh ? `《${book.title}》作品菜单` : `${book.title} work menu`} data-testid={`home-book-menu-${book.id}`}><MoreHorizontal size={17} /></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem data-testid={`home-book-cover-upload-${book.id}`} disabled={pending} onClick={() => pickCover(book)}>{book.coverImagePath ? (isZh ? "更换封面" : "Replace cover") : (isZh ? "上传封面" : "Upload cover")}</DropdownMenuItem>
              {book.coverImagePath ? <DropdownMenuItem data-testid={`home-book-cover-remove-${book.id}`} disabled={pending} onClick={() => void removeCover(book)}>{isZh ? "移除封面" : "Remove cover"}</DropdownMenuItem> : null}
              <DropdownMenuItem onClick={() => setSettingsBookId(book.id)}>{isZh ? "作品设置" : "Work settings"}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => nav.toAnalytics(book.id)}>{isZh ? "作品统计" : "Statistics"}</DropdownMenuItem>
              <DropdownMenuItem data-testid={`book-export-manuscript-${book.id}`} onClick={() => downloadWork(bookManuscriptExportPath(book.id))}>{isZh ? "导出正文" : "Export manuscript"}</DropdownMenuItem>
              <DropdownMenuItem disabled={pending} onClick={() => void updateStatus(book, status ? "active" : "paused")}>{status ? (isZh ? "恢复创作" : "Resume") : (isZh ? "暂停作品" : "Pause")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem data-testid={`home-book-delete-${book.id}`} variant="destructive" disabled={pending} onClick={() => setDeleteTarget({ kind: "book", id: book.id, title: book.title })}>{isZh ? "删除作品" : "Delete work"}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </article>;
      })}
      {visibleShorts.map((short) => <article key={`short-${short.id}`} className="ink-shelf-book" data-testid={`dashboard-short-${short.id}`}>
        <button type="button" className="ink-book-open" onClick={() => nav.toShort(short.id)}><DefaultCover title={short.title} coverSrc={short.coverImagePath} /><h2 title={short.title}>{short.title}</h2><p>{isZh ? "短篇" : "Short fiction"}{short.status === "completed" ? (isZh ? " · 完结" : " · Complete") : ""}</p></button>
        <DropdownMenu><DropdownMenuTrigger className="ink-book-menu" data-testid={`home-short-menu-${short.id}`} aria-label={isZh ? `《${short.title}》作品菜单` : `${short.title} work menu`}><MoreHorizontal size={17} /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => nav.toShortSettings(short.id)}>{isZh ? "作品设置" : "Work settings"}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => nav.toShortAnalytics(short.id)}>{isZh ? "作品统计" : "Statistics"}</DropdownMenuItem>
            <DropdownMenuItem data-testid={`short-export-manuscript-${short.id}`} onClick={() => downloadWork(shortManuscriptExportPath(short.id))}>{isZh ? "导出正文" : "Export manuscript"}</DropdownMenuItem>
            <DropdownMenuSeparator /><DropdownMenuItem data-testid={`short-delete-${short.id}`} variant="destructive" disabled={pending} onClick={() => setDeleteTarget({ kind: "short", id: short.id, title: short.title })}>{isZh ? "删除作品" : "Delete work"}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </article>)}
    </div>
    <ConfirmDialog open={Boolean(deleteTarget)} title={isZh ? "删除作品" : "Delete work"} message={isZh ? `删除《${deleteTarget?.title ?? ""}》及其全部内容？此操作无法撤销。` : `Delete ${deleteTarget?.title ?? ""} and its contents? This cannot be undone.`} confirmLabel={pending ? (isZh ? "正在删除…" : "Deleting…") : t("common.delete")} cancelLabel={t("common.cancel")} variant="danger" onConfirm={() => void deleteWork()} onCancel={() => { if (!pending) setDeleteTarget(null); }} />
    {settingsBookId ? <BookSettingsDrawer bookId={settingsBookId} open onClose={() => { setSettingsBookId(null); reload(); }} t={t} isZh={isZh} onDeleted={() => { setSettingsBookId(null); bumpBookDataVersion(); reload(); }} /> : null}
    <input ref={coverFileRef} type="file" accept={BOOK_COVER_ACCEPT} className="sr-only" tabIndex={-1} data-testid="home-book-cover-file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadCover(file); event.target.value = ""; }} />
  </section>;
}
