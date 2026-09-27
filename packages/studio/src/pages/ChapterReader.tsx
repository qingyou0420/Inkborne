import { useCallback, useEffect, useRef, useState } from "react";
import { showToast } from "../lib/toast";
import { trackChapterEdit } from "../lib/pending-chapter-edit";
import { registerUnsavedCheck, registerUnsavedFlush } from "../lib/unsaved-edits";
import { fetchJson, putApi, putChapterAutosave, useApi, postApi } from "../hooks/use-api";
import { StudioApiError } from "../hooks/use-api";
import { shouldRefetchChapterBody } from "../hooks/use-book-activity";
import type { SSEMessage } from "../hooks/use-sse";
import type { Theme } from "../hooks/use-theme";
import { useI18n, type TFunction } from "../hooks/use-i18n";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ChapterWorkspacePanel } from "../components/ChapterWorkspacePanel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  BookOpen,
  Type,
  Clock,
  Pencil,
  Save,
  MoreHorizontal,
} from "lucide-react";

interface ChapterData {
  readonly chapterNumber: number;
  readonly filename: string;
  readonly content: string;
}

interface Nav {
  toBook: (id: string) => void;
  toDashboard: () => void;
}

function chapterKicker(n: number, isZh: boolean): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  if (!isZh) return `Chapter ${n}`;
  if (n <= 10) return `第${digits[n]}章`;
  if (n < 20) return `第十${n === 10 ? "" : digits[n - 10]}章`;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return `第${tens === 1 ? "十" : `${digits[tens]}十`}${ones ? digits[ones] : ""}章`;
  }
  return `第${n}章`;
}

export function ChapterReader({ bookId, chapterNumber, nav, theme: _theme, t, sse }: {
  bookId: string;
  chapterNumber: number;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse?: { readonly messages: ReadonlyArray<SSEMessage> };
}) {
  const { data, loading, error, refetch } = useApi<ChapterData>(
    `/books/${bookId}/chapters/${chapterNumber}`,
  );
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [packetOpen, setPacketOpen] = useState(false);
  const [packetText, setPacketText] = useState("");
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideWhy, setOverrideWhy] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const pendingSave = useRef<{ bookId: string; chapterNumber: number; content: string } | null>(null);
  const editGeneration = useRef(0);
  const flushedGeneration = useRef(0);
  const { lang } = useI18n();
  const isZh = lang !== "en";

  useEffect(() => registerUnsavedCheck(() => pendingSave.current !== null), []);

  const flushPendingChapter = useCallback(async () => {
    const pending = pendingSave.current;
    if (!pending) return;
    pendingSave.current = null;
    const generation = editGeneration.current;
    const fresh = flushedGeneration.current !== generation;
    try {
      await putChapterAutosave(pending.bookId, pending.chapterNumber, pending.content, { fresh });
      if (editGeneration.current === generation) flushedGeneration.current = generation;
    } catch (error) {
      if (!pendingSave.current) pendingSave.current = pending;
      throw error;
    }
  }, []);
  const flushPendingRef = useRef(flushPendingChapter);
  flushPendingRef.current = flushPendingChapter;
  useEffect(() => registerUnsavedFlush(() => flushPendingRef.current()), []);

  useEffect(() => {
    if (!editing || !pendingSave.current) return;
    const timer = window.setTimeout(() => {
      void flushPendingChapter().then(() => {
        void refetch();
      }).catch((error) => {
        showToast(error instanceof Error ? error.message : "Save failed", "error");
      });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [editContent, editing, flushPendingChapter, refetch]);

  useEffect(() => {
    return () => {
      const pending = pendingSave.current;
      if (!pending) return;
      pendingSave.current = null;
      const generation = editGeneration.current;
      const fresh = flushedGeneration.current !== generation;
      void putChapterAutosave(pending.bookId, pending.chapterNumber, pending.content, { fresh }).then(() => {
        if (editGeneration.current === generation) flushedGeneration.current = generation;
      });
    };
  }, [bookId, chapterNumber]);

  const handleChapterChanged = useCallback(() => {
    const pending = pendingSave.current;
    pendingSave.current = null;
    setEditing(false);
    setEditContent("");
    setWorkspaceRevision((revision) => revision + 1);
    if (!pending) {
      void refetch();
      return;
    }
    const generation = editGeneration.current;
    const fresh = flushedGeneration.current !== generation;
    void putChapterAutosave(pending.bookId, pending.chapterNumber, pending.content, { fresh }).then(() => {
      if (editGeneration.current === generation) flushedGeneration.current = generation;
    }).finally(() => {
      void refetch();
    });
  }, [refetch]);

  useEffect(() => {
    const recent = sse?.messages.at(-1);
    if (!recent) return;
    if (shouldRefetchChapterBody(recent, bookId, chapterNumber)) {
      handleChapterChanged();
    }
  }, [bookId, chapterNumber, handleChapterChanged, sse?.messages]);

  const handleStartEdit = () => {
    if (!data) return;
    pendingSave.current = null;
    editGeneration.current += 1;
    setEditContent(data.content);
    setEditing(true);
  };

  const handleCancelEdit = () => {
    if (pendingSave.current) {
      setDiscardOpen(true);
      return;
    }
    setEditing(false);
    setEditContent("");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      pendingSave.current = null;
      await putApi(`/books/${bookId}/chapters/${chapterNumber}`, { content: editContent });
      setEditing(false);
      refetch();
      setWorkspaceRevision((revision) => revision + 1);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) return (
    <div className="flex flex-col items-center justify-center py-32 space-y-4">
      <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <span className="text-sm text-muted-foreground">{t("reader.openingManuscript")}</span>
    </div>
  );

  if (error) return <div className="text-destructive p-8 bg-destructive/5 rounded-xl border border-destructive/20">Error: {error}</div>;
  if (!data) return null;

  const lines = data.content.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine?.replace(/^#\s*/, "") ?? `Chapter ${chapterNumber}`;
  const body = lines
    .filter((l) => l !== titleLine)
    .join("\n")
    .trim();

  const handleApprove = async (why?: string) => {
    try {
      await postApi(`/books/${bookId}/chapters/${chapterNumber}/approve`, why?.trim()
        ? { override: { who: "author", why: why.trim() } }
        : {});
      nav.toBook(bookId);
    } catch (e) {
      const blocked = e instanceof StudioApiError && e.code === "APPROVE_BLOCKED";
      if (blocked && !why?.trim()) {
        setOverrideOpen(true);
        return;
      }
      showToast(blocked
        ? `${e.message} ${e.details ? JSON.stringify(e.details) : ""}`
        : (e instanceof Error ? e.message : "Approve failed"), "error");
    }
  };

  const handleReject = async () => {
    try {
      await postApi(`/books/${bookId}/chapters/${chapterNumber}/reject`);
      nav.toBook(bookId);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Reject failed", "error");
    }
  };

  const handleOpenPacket = async () => {
    try {
      const packet = await fetchJson<unknown>(`/books/${bookId}/chapters/${chapterNumber}/packet`);
      setPacketText(JSON.stringify(packet, null, 2));
      setPacketOpen(true);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "No packet snapshot", "error");
    }
  };

  const handleDelete = async () => {
    try {
      await fetchJson(`/books/${bookId}/chapters/${chapterNumber}`, { method: "DELETE" });
      setDeleteOpen(false);
      nav.toBook(bookId);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Delete failed", "error");
    }
  };

  const paragraphs = body.split(/\n\n+/).filter(Boolean);

  return (
    <div className="w-full space-y-10 fade-in">
      <div className="flex justify-end gap-2">
        {editing ? (
          <>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="btn-primary disabled:opacity-50"
            >
              {saving ? <div className="w-3.5 h-3.5 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Save size={14} />}
              {saving ? t("book.saving") : t("book.save")}
            </button>
            <button type="button" onClick={handleCancelEdit} className="btn-ghost">
              {t("reader.cancel")}
            </button>
          </>
        ) : (
          <button type="button" onClick={handleStartEdit} className="btn-secondary">
            <Pencil size={14} />
            {t("reader.edit")}
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleApprove()}
          className="btn-primary"
          data-testid="chapter-approve"
        >
          {t("reader.approve")}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger data-testid="chapter-more" className="btn-ghost inline-flex h-10 w-10 items-center justify-center">
            <MoreHorizontal size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void handleReject()}>
              {t("reader.rollback")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void handleOpenPacket()}>
              {t("reader.packet")}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
              {t("reader.deleteChapter")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {packetOpen && (
        <pre className="max-h-80 overflow-auto rounded-xl border border-border/50 bg-secondary/20 p-4 text-xs" data-testid="packet-viewer">
          {packetText}
        </pre>
      )}

      <ChapterWorkspacePanel
        key={`${chapterNumber}-${workspaceRevision}`}
        bookId={bookId}
        chapterNumber={chapterNumber}
        t={t}
        onChapterChanged={handleChapterChanged}
        onChapterDeleted={() => nav.toBook(bookId)}
      />

      <div className="paper-sheet rounded-2xl p-8 md:p-16 lg:p-24 min-h-[80vh] relative overflow-hidden border border-border">
        <div className="absolute top-0 left-8 w-px h-full bg-border/40 hidden md:block" />
        <div className="absolute top-0 right-8 w-px h-full bg-border/40 hidden md:block" />

        <header className="mb-16 text-center">
          <div className="flex items-center justify-center gap-2 text-muted-foreground/30 mb-8 select-none">
            <div className="h-px w-12 bg-border/40" />
            <BookOpen size={20} />
            <div className="h-px w-12 bg-border/40" />
          </div>
          <p className="literary-kicker mb-4">{chapterKicker(chapterNumber, isZh)}</p>
          <h1 className="font-serif text-[32px] font-medium leading-10 text-foreground">
            {title}
          </h1>
        </header>

        {editing ? (
          <textarea
            value={editContent}
            onChange={(e) => {
              const next = e.target.value;
              setEditContent(next);
              pendingSave.current = trackChapterEdit(bookId, chapterNumber, next, data.content);
            }}
            className="w-full min-h-[60vh] bg-transparent font-serif text-lg leading-[32px] text-foreground/90 focus:outline-none resize-none border border-border-strong rounded-[10px] p-6 focus:ring-1 focus:ring-ring"
            autoFocus
          />
        ) : (
          <article className="prose prose-zinc dark:prose-invert max-w-none">
            {paragraphs.map((para, i) => (
              <p key={i} className="font-serif text-lg md:text-xl leading-[32px] text-foreground/90 mb-8">
                {para}
              </p>
            ))}
          </article>
        )}

        <footer className="mt-24 pt-12 border-t border-border/20 flex flex-col items-center gap-6 text-center">
          <div className="flex items-center gap-4 text-[13px] font-medium text-muted-foreground">
             <div className="flex items-center gap-1.5">
               <Type size={14} />
               <span>{body.length.toLocaleString()} {t("reader.characters")}</span>
             </div>
             <div className="flex items-center gap-1.5">
               <Clock size={14} />
               <span>{Math.ceil(body.length / 500)} {t("reader.minRead")}</span>
             </div>
          </div>
          <p className="literary-kicker text-muted-foreground/70">{t("reader.endOfChapter")}</p>
        </footer>
      </div>

      <ConfirmDialog
        open={overrideOpen}
        title={t("reader.stillApprove")}
        message=""
        confirmLabel={t("reader.approve")}
        cancelLabel={t("common.cancel")}
        onCancel={() => { setOverrideOpen(false); setOverrideWhy(""); }}
        onConfirm={() => {
          const why = overrideWhy.trim();
          if (!why) return;
          setOverrideOpen(false);
          void handleApprove(why);
        }}
      >
        <input
          data-testid="chapter-override-why"
          value={overrideWhy}
          onChange={(event) => setOverrideWhy(event.target.value)}
          placeholder={t("reader.overrideWhy")}
          className="w-full rounded-[10px] border border-border-strong bg-card px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={discardOpen}
        title={isZh ? "这段修改还没保存" : "Edits are not saved"}
        message={isZh ? "取消后，刚才改的字会丢掉。" : "Canceling drops the words you just changed."}
        confirmLabel={isZh ? "丢掉修改" : "Discard"}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => {
          pendingSave.current = null;
          setDiscardOpen(false);
          setEditing(false);
          setEditContent("");
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        title={t("reader.deleteChapter")}
        message={t("reader.deleteChapterConfirm")}
        confirmLabel={t("reader.deleteChapter")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}
