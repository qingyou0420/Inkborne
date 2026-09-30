import { useEffect, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { putApi, useApi } from "../hooks/use-api";
import { useI18n, type TFunction } from "../hooks/use-i18n";
import { deleteStudioShortWork } from "../lib/short-api";
import { showToast } from "../lib/toast";
import { shortManuscriptExportPath } from "../lib/work-export";
import type { StudioShortDetail } from "../shared/short-works";

interface Nav {
  toDashboard: () => void;
  toShort: (id: string) => void;
}

export function ShortSettings({ storyId, nav, t }: {
  storyId: string;
  nav: Nav;
  t: TFunction;
}) {
  const { data, loading, error, refetch } = useApi<StudioShortDetail>(`/shorts/${encodeURIComponent(storyId)}`);
  const [title, setTitle] = useState("");
  const [chapterCount, setChapterCount] = useState(12);
  const [direction, setDirection] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { lang } = useI18n();
  const isZh = lang !== "en";

  useEffect(() => {
    if (!data) return;
    setTitle(data.title);
    setChapterCount(data.chapterCount ?? 12);
    setDirection(data.direction ?? "");
  }, [data]);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await putApi(`/shorts/${encodeURIComponent(storyId)}`, {
        title,
        chapterCount,
        direction: direction.trim(),
      });
      setMessage(t("short.saved"));
      await refetch();
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : t("common.error"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteStudioShortWork(storyId);
      setDeleteOpen(false);
      nav.toDashboard();
    } catch (deleteError) {
      showToast(deleteError instanceof Error ? deleteError.message : t("common.error"), "error");
    }
  };

  if (loading) return <div className="text-muted-foreground">{t("common.loading")}</div>;
  if (error) return <div className="text-destructive">{t("common.error")}: {error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-8">
      <div>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">{t("short.badge")}</span>
        <h1 className="mt-3 font-serif text-[32px] font-medium leading-10">{t("short.settings")}</h1>
      </div>

      <div className="paper-sheet rounded-2xl border border-border/40 p-6 space-y-5">
        <div className="flex flex-col gap-1">
          <label className="literary-kicker">{t("create.bookTitle")}</label>
          <input
            data-testid="short-settings-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="h-10 rounded-lg border border-border-strong bg-card px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="literary-kicker">{t("create.targetChapters")}</label>
          <input
            data-testid="short-settings-chapters"
            type="number"
            min={1}
            value={chapterCount}
            onChange={(event) => setChapterCount(Number(event.target.value))}
            className="h-10 w-32 rounded-lg border border-border-strong bg-card px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="literary-kicker">{t("short.direction")}</label>
          <textarea
            data-testid="short-settings-direction"
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
            placeholder={t("short.directionPlaceholder")}
            rows={4}
            className="rounded-lg border border-border-strong bg-card px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="short-settings-save"
            onClick={() => void handleSave()}
            disabled={saving || !title.trim()}
            className="btn-primary"
          >
            {saving ? t("book.saving") : t("book.save")}
          </button>
          <a
            href={shortManuscriptExportPath(storyId)}
            download
            data-testid="short-settings-export"
            className="btn-secondary"
          >
            {t("book.export")}
          </a>
        </div>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
      </div>

      <div className="rounded-xl border border-destructive/20 px-5 py-5 space-y-3" data-testid="short-danger-zone">
        <div className="text-[13px] text-destructive">{isZh ? "危险区" : "Danger zone"}</div>
        <p className="text-sm text-muted-foreground">{isZh ? "删除后无法恢复。" : "This cannot be undone."}</p>
        <button
          type="button"
          data-testid="short-delete"
          onClick={() => setDeleteOpen(true)}
          className="btn-danger"
        >
          {isZh ? "删除短篇" : "Delete short"}
        </button>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        title={isZh ? "删除这篇短篇？" : "Delete this short?"}
        message={isZh ? "删除后无法恢复。" : "This cannot be undone."}
        confirmLabel={isZh ? "删除" : "Delete"}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}
