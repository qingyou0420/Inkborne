import { useCallback, useEffect, useRef, useState } from "react";
import { showToast } from "../lib/toast";
import { fetchJson, useApi, postApi } from "../hooks/use-api";
import { StudioApiError } from "../hooks/use-api";
import { shouldRefetchChapterBody } from "../hooks/use-book-activity";
import type { SSEMessage } from "../hooks/use-sse";
import type { Theme } from "../hooks/use-theme";
import { useI18n, type TFunction } from "../hooks/use-i18n";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ChapterWorkspacePanel } from "../components/ChapterWorkspacePanel";
import { ReadingAppearanceDrawer } from "../components/ReadingAppearanceDrawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  Type,
  Clock,
  Pencil,
  Save,
  MoreHorizontal,
} from "lucide-react";

const pendingReaderEdits = new Map<string, { content: string; baseline: string }>();
let readerUnloadGuardInstalled = false;
function installReaderUnloadGuard() {
  if (readerUnloadGuardInstalled || typeof window === "undefined") return;
  readerUnloadGuardInstalled = true;
  window.addEventListener("beforeunload", (event) => {
    if (!pendingReaderEdits.size) return;
    event.preventDefault(); event.returnValue = "";
  });
}

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

export function ChapterReader(props: Parameters<typeof ChapterReaderWorkspace>[0]) {
  return <ChapterReaderWorkspace key={`${props.bookId}:${props.chapterNumber}`} {...props} />;
}

function ChapterReaderWorkspace({ bookId, chapterNumber, nav, theme: _theme, t, sse }: {
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
  const bufferKey = `${bookId}:${chapterNumber}`;
  const restoredEdit = useRef(pendingReaderEdits.get(bufferKey));
  const [editing, setEditing] = useState(Boolean(restoredEdit.current));
  const [editContent, setEditContent] = useState(restoredEdit.current?.content ?? "");
  const baseline = useRef(restoredEdit.current?.baseline ?? "");
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [externalChange, setExternalChange] = useState(false);
  const dirty = editing && editContent !== baseline.current;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const [saving, setSaving] = useState(false);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [packetOpen, setPacketOpen] = useState(false);
  const [packetText, setPacketText] = useState("");
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideWhy, setOverrideWhy] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { lang } = useI18n();
  const isZh = lang !== "en";

  const handleChapterChanged = useCallback(() => {
    if (dirtyRef.current) setExternalChange(true);
    else { setEditing(false); setEditContent(""); }
    setWorkspaceRevision((revision) => revision + 1);
    void refetch();
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
    setEditContent(data.content);
    baseline.current = data.content;
    setSaveError(null);
    setEditing(true);
  };

  const discardEdit = () => {
    pendingReaderEdits.delete(bufferKey);
    setEditing(false);
    setEditContent("");
    setDiscardOpen(false);
    setExternalChange(false);
    setSaveError(null);
  };
  const handleCancelEdit = () => {
    if (dirty) setDiscardOpen(true);
    else discardEdit();
  };

  const handleSave = async () => {
    if (saving || !editing || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      await fetchJson(`/books/${bookId}/chapters/${chapterNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      pendingReaderEdits.delete(bufferKey);
      baseline.current = editContent;
      setEditing(false);
      setExternalChange(false);
      refetch();
      setWorkspaceRevision((revision) => revision + 1);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Save failed";
      setSaveError(message);
      showToast(message, "error");
    } finally {
      setSaving(false);
    }
  };

  const saveAction = useRef(handleSave);
  saveAction.current = handleSave;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s" || event.altKey) return;
      event.preventDefault();
      void saveAction.current();
    };
    installReaderUnloadGuard();
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, []);

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
    <div className="w-full space-y-8 fade-in">
      <div className="reader-toolbar">
        <span className="reader-save-state" role="status">{saving ? (isZh ? "正在保存…" : "Saving…") : dirty ? (isZh ? "有未保存修改" : "Unsaved changes") : (isZh ? "正式正文" : "Manuscript")}</span>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setAssistantOpen((open) => !open)}
        >
          {assistantOpen ? t("reader.closeAssistant") : t("reader.openAssistant")}
        </button>
        {editing ? (
          <>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !dirty}
              aria-keyshortcuts="Control+s Meta+s"
              className="btn-primary disabled:opacity-50"
            >
              {saving ? <div className="w-3.5 h-3.5 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Save size={14} />}
              {saving ? t("book.saving") : t("book.save")}
            </button>
            <button type="button" onClick={handleCancelEdit} disabled={saving} className="btn-ghost">
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
          disabled={saving || dirty}
          className="btn-secondary"
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

      {saveError ? <p className="manuscript-error" role="alert">{saveError}</p> : null}
      {externalChange ? <p className="manuscript-notice">{isZh ? "正文在别处有更新。你的手改仍保留，请核对后保存。" : "The manuscript changed elsewhere. Your edits are retained; check them before saving."}</p> : null}
      {packetOpen && (
        <pre className="max-h-80 overflow-auto rounded-xl border border-border/50 bg-secondary/20 p-4 text-xs" data-testid="packet-viewer">
          {packetText}
        </pre>
      )}

      {assistantOpen ? (
        <ChapterWorkspacePanel
          key={`${chapterNumber}-${workspaceRevision}`}
          bookId={bookId}
          chapterNumber={chapterNumber}
          t={t}
          onChapterChanged={handleChapterChanged}
          onChapterDeleted={() => nav.toBook(bookId)}
        />
      ) : null}

      <div className="one-document mx-auto min-h-[70vh] max-w-[740px] px-2">
        <header className="manuscript-heading">
          <h1 className="text-[30px] font-medium leading-10 text-foreground">
            {title || chapterKicker(chapterNumber, isZh)}
          </h1>
          <div className="manuscript-meta">
            <span>{body.length.toLocaleString()} {t("reader.characters")}</span>
            <button type="button" onClick={() => setAppearanceOpen(true)} data-testid="reader-appearance"><Type size={15} />{isZh ? "排版" : "Appearance"}</button>
          </div>
        </header>

        {editing ? (
          <textarea
            value={editContent}
            onChange={(e) => {
              const content = e.target.value;
              setEditContent(content);
              setSaveError(null);
              if (content === baseline.current) pendingReaderEdits.delete(bufferKey);
              else pendingReaderEdits.set(bufferKey, { content, baseline: baseline.current });
            }}
            readOnly={saving}
            aria-label={isZh ? "编辑正式正文" : "Edit manuscript"}
            className="prose-body w-full min-h-[60vh] bg-transparent focus:outline-none resize-none border border-input rounded-[5px] p-4"
            autoFocus
          />
        ) : (
          <article className="prose-body max-w-none">
            {paragraphs.map((para, i) => (
              <p key={i} className="mb-8">
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
          <p className="text-sm text-muted-foreground">{t("reader.endOfChapter")}</p>
        </footer>
      </div>

      <ReadingAppearanceDrawer open={appearanceOpen} onClose={() => setAppearanceOpen(false)} isZh={isZh} />
      <ConfirmDialog open={discardOpen} title={isZh ? "放弃本次修改？" : "Discard these edits?"} message={isZh ? "正式正文不受影响。" : "The saved manuscript will remain unchanged."} confirmLabel={isZh ? "放弃修改" : "Discard edits"} cancelLabel={isZh ? "继续编辑" : "Keep editing"} onConfirm={discardEdit} onCancel={() => setDiscardOpen(false)} />

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
