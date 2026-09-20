/**
 * Book settings + danger zone. Opened from ⋯, never from the write header.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useState } from "react";
import { fetchJson } from "../hooks/use-api";
import type { TFunction } from "../hooks/use-i18n";
import { Drawer } from "./ui/drawer";

type BookStatus = "active" | "paused" | "completed" | "dropped";

export function BookSettingsDrawer({
  bookId,
  open,
  onClose,
  t,
  isZh: _isZh,
  onDeleted,
}: {
  readonly bookId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly t: TFunction;
  readonly isZh: boolean;
  readonly onDeleted: () => void;
}) {
  const [wordCount, setWordCount] = useState(3000);
  const [targetChapters, setTargetChapters] = useState(200);
  const [status, setStatus] = useState<BookStatus>("active");
  const [title, setTitle] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setConfirmName("");
    setError(null);
    void fetchJson<{
      book: { title: string; chapterWordCount: number; targetChapters?: number; status: string };
    }>(`/books/${bookId}`).then((body) => {
      setTitle(body.book.title);
      setWordCount(body.book.chapterWordCount);
      setTargetChapters(body.book.targetChapters ?? 200);
      const next = body.book.status;
      setStatus(next === "paused" || next === "completed" || next === "dropped" ? next : "active");
    }).catch(() => undefined);
  }, [bookId, open]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await fetchJson(`/books/${bookId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chapterWordCount: wordCount, targetChapters, status }),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (confirmName.trim() !== title) return;
    setDeleting(true);
    setError(null);
    try {
      await fetchJson(`/books/${encodeURIComponent(bookId)}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Drawer open={open} title={t("book.settings")} onClose={onClose} testId="book-settings-drawer">
      <div className="space-y-5">
        <label className="block space-y-1 text-sm">
          <span>{t("create.wordsPerChapter")}</span>
          <input type="number" value={wordCount} onChange={(event) => setWordCount(Number(event.target.value))} className="w-full rounded-lg border border-border-strong bg-card px-3 h-10" />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t("create.targetChapters")}</span>
          <input type="number" value={targetChapters} onChange={(event) => setTargetChapters(Number(event.target.value))} className="w-full rounded-lg border border-border-strong bg-card px-3 h-10" />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t("book.status")}</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as BookStatus)} className="w-full rounded-lg border border-border-strong bg-card px-3 h-10">
            <option value="active">{t("book.statusActive")}</option>
            <option value="paused">{t("book.statusPaused")}</option>
            <option value="completed">{t("book.statusCompleted")}</option>
            <option value="dropped">{t("book.statusDropped")}</option>
          </select>
        </label>
        <button type="button" onClick={() => void save()} disabled={saving} className="btn-primary disabled:opacity-40">
          {saving ? t("book.saving") : t("book.save")}
        </button>
        <div className="border-t border-destructive/30 pt-4 space-y-3" data-testid="book-danger-zone">
          <div className="text-sm font-medium text-destructive">{t("book.dangerZone")}</div>
          <p className="text-xs text-muted-foreground">{t("book.typeTitleToDelete")}（{title}）</p>
          <input
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            data-testid="book-delete-confirm-name"
            className="w-full rounded-lg border border-destructive/30 bg-card px-3 h-10 text-sm"
          />
          <button
            type="button"
            data-testid="book-delete-confirm"
            disabled={deleting || confirmName.trim() !== title}
            onClick={() => void remove()}
            className="btn-danger disabled:opacity-40"
          >
            {deleting ? t("common.loading") : t("book.deleteBook")}
          </button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </Drawer>
  );
}
