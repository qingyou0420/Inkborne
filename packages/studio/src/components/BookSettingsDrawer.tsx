/**
 * Book status and legacy length settings. Four-stage length belongs to Ask.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useRef, useState } from "react";
import { fetchJson, invalidateApiPaths, useApi } from "../hooks/use-api";
import type { TFunction } from "../hooks/use-i18n";
import type { AuthoringWorkspace } from "../lib/authoring-workspace";
import { useChatStore } from "../store/chat";
import { buildBookSettingsUpdate, type BookSettingsStatus } from "./book-settings-state";
import { Drawer } from "./ui/drawer";

interface BookSettingsProps {
  readonly bookId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly t: TFunction;
  readonly isZh: boolean;
  readonly onDeleted: () => void;
  readonly onEditLength?: () => void;
}

interface BookSettingsData {
  readonly title: string;
  readonly chapterWordCount: number;
  readonly targetChapters?: number;
  readonly status: BookSettingsStatus;
}

export function BookSettingsDrawer(props: BookSettingsProps) {
  return (
    <Drawer open={props.open} title={props.t("book.settings")} onClose={props.onClose} testId="book-settings-drawer">
      {props.open ? <BookSettingsLoader key={props.bookId} {...props} /> : null}
    </Drawer>
  );
}

function BookSettingsLoader(props: BookSettingsProps) {
  const book = useApi<{ book: BookSettingsData }>(`/books/${encodeURIComponent(props.bookId)}`);
  const workspace = useApi<AuthoringWorkspace>(`/authoring/workspace?bookId=${encodeURIComponent(props.bookId)}&summary=1`);
  const error = book.error || workspace.error;
  if (error) return (
    <div role="alert" className="space-y-3 text-sm">
      <p className="text-destructive">{error}</p>
      <button type="button" className="btn-ghost" disabled={book.loading || workspace.loading} onClick={() => { void book.refetch(); void workspace.refetch(); }}>
        {props.isZh ? "重新读取作品设置" : "Reload work settings"}
      </button>
    </div>
  );
  if (book.loading || workspace.loading || !book.data?.book || !workspace.data) {
    return <p role="status" className="text-sm text-muted-foreground">{props.isZh ? "正在读取作品设置…" : "Loading work settings…"}</p>;
  }
  return <BookSettingsForm {...props} book={book.data.book} authoringBook={workspace.data.authoringBook === true} />;
}

function BookSettingsForm({ bookId, onClose, t, isZh, onDeleted, onEditLength, book, authoringBook }: BookSettingsProps & {
  readonly book: BookSettingsData;
  readonly authoringBook: boolean;
}) {
  const [wordCount, setWordCount] = useState(book.chapterWordCount);
  const [targetChapters, setTargetChapters] = useState(book.targetChapters ?? 200);
  const [status, setStatus] = useState<BookSettingsStatus>(book.status);
  const title = book.title;
  const [confirmName, setConfirmName] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const busy = saving || deleting;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const refreshBook = () => {
    invalidateApiPaths(["/api/v1/books", `/api/v1/books/${encodeURIComponent(bookId)}`, "/api/v1/authoring/workspace"]);
    useChatStore.getState().bumpBookDataVersion();
  };

  const save = async () => {
    if (busyRef.current) return;
    const update = buildBookSettingsUpdate(authoringBook, { chapterWordCount: wordCount, targetChapters, status });
    if (!update) {
      setError(isZh ? "每章字数至少为 100，目标章数至少为 1，请填写整数。" : "Use whole numbers: at least 100 words per chapter and 1 chapter.");
      return;
    }
    busyRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await fetchJson(`/books/${encodeURIComponent(bookId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      refreshBook();
      if (mounted.current) onClose();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : (isZh ? "保存失败" : "Save failed"));
    } finally {
      busyRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const remove = async () => {
    if (busyRef.current || !title || confirmName.trim() !== title) return;
    busyRef.current = true;
    setDeleting(true);
    setError(null);
    try {
      await fetchJson(`/books/${encodeURIComponent(bookId)}`, { method: "DELETE" });
      refreshBook();
      if (mounted.current) onDeleted();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : (isZh ? "删除失败" : "Delete failed"));
    } finally {
      busyRef.current = false;
      if (mounted.current) setDeleting(false);
    }
  };

  return (
      <div className="space-y-5">
        {authoringBook ? (
          <div className="space-y-2 text-sm" data-testid="book-length-in-ask">
            <p className="text-muted-foreground">{isZh ? "目标章数和每章字数统一在问心正典中修改，采用后用于后续写作。" : "Edit target chapters and chapter length in the Ask canon, then adopt them for future writing."}</p>
            {onEditLength ? <button type="button" className="btn-ghost" disabled={busy} onClick={() => { onClose(); onEditLength(); }}>{isZh ? "去问心修改篇幅" : "Edit length in Ask"}</button> : null}
          </div>
        ) : <>
        <label className="block space-y-1 text-sm">
          <span>{t("create.wordsPerChapter")}</span>
          <input type="number" min={100} step={1} disabled={busy} value={wordCount} onChange={(event) => setWordCount(Number(event.target.value))} className="w-full rounded-lg border border-border-strong bg-card px-3 h-10" />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t("create.targetChapters")}</span>
          <input type="number" min={1} step={1} disabled={busy} value={targetChapters} onChange={(event) => setTargetChapters(Number(event.target.value))} className="w-full rounded-lg border border-border-strong bg-card px-3 h-10" />
        </label>
        </>}
        <label className="block space-y-1 text-sm">
          <span>{t("book.status")}</span>
          <select value={status} disabled={busy} onChange={(event) => setStatus(event.target.value as BookSettingsStatus)} className="w-full rounded-lg border border-border-strong bg-card px-3 h-10">
            <option value="active">{t("book.statusActive")}</option>
            <option value="paused">{t("book.statusPaused")}</option>
            <option value="completed">{t("book.statusCompleted")}</option>
            <option value="dropped">{t("book.statusDropped")}</option>
          </select>
        </label>
        <button type="button" onClick={() => void save()} disabled={busy} className="btn-primary disabled:opacity-40">
          {saving ? t("book.saving") : t("book.save")}
        </button>
        <div className="border-t border-destructive/30 pt-4 space-y-3" data-testid="book-danger-zone">
          <div className="text-sm font-medium text-destructive">{t("book.dangerZone")}</div>
          <p className="text-xs text-muted-foreground">{t("book.typeTitleToDelete")}（{title}）</p>
          <input
            value={confirmName}
            disabled={busy}
            aria-label={t("book.typeTitleToDelete")}
            onChange={(event) => setConfirmName(event.target.value)}
            data-testid="book-delete-confirm-name"
            className="w-full rounded-lg border border-destructive/30 bg-card px-3 h-10 text-sm"
          />
          <button
            type="button"
            data-testid="book-delete-confirm"
            disabled={busy || !title || confirmName.trim() !== title}
            onClick={() => void remove()}
            className="btn-danger disabled:opacity-40"
          >
            {deleting ? t("common.loading") : t("book.deleteBook")}
          </button>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
  );
}
