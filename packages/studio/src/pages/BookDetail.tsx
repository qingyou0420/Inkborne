import { fetchJson, useApi, postApi } from "../hooks/use-api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SerialCockpitStrip, startDraft, startWriteNext } from "../components/SerialCockpitStrip";
import { AuthoringWritePanel, type WriteLeaveGuard } from "../components/AuthoringWritePanel";
import type { BookWorkspaceNavTarget } from "../components/BookWorkspaceNav";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { LiteraryEmpty } from "../components/LiteraryEmpty";
import { StageDot } from "../components/StageDot";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import { deriveBookActivity, shouldRefetchBookView } from "../hooks/use-book-activity";
import { bookManuscriptExportPath } from "../lib/work-export";
import { formatReviewIssueCopy, hasPreviousChapterUnapprovedReason, isMustFixSeverity } from "../lib/copy-map";
import { formatStudyWords, writeEmptyCopy } from "../lib/stage-copy";
import type { BookStepState } from "../lib/book-stage";
import { useBookStage } from "../hooks/use-book-stage";
import { usePreferencesStore } from "../store/preferences";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  Feather,
  Download,
  Check,
  ChevronDown,
  MoreHorizontal,
  List,
} from "lucide-react";

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
}

interface BookData {
  readonly book: {
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly status: string;
    readonly chapterWordCount: number;
    readonly targetChapters?: number;
    readonly language?: string;
    readonly fanficMode?: string;
  };
  readonly chapters: ReadonlyArray<ChapterMeta>;
  readonly nextChapter: number;
}

type ReviseMode = "spot-fix" | "polish" | "rewrite" | "rework" | "anti-detect";
type ExportFormat = "txt" | "md" | "epub";

interface Nav extends BookWorkspaceNavTarget {
  toDashboard: () => void;
  toChapter: (bookId: string, num: number) => void;
  toAnalytics: (bookId: string) => void;
  toTruth: (bookId: string) => void;
}

type BriefKind = "rewrite" | "revise" | "sync";

function translateChapterStatus(status: string, t: TFunction): string {
  const map: Record<string, () => string> = {
    "ready-for-review": () => t("chapter.readyForReview"),
    "approved": () => t("chapter.approved"),
    "drafted": () => t("chapter.drafted"),
    "needs-revision": () => t("chapter.needsRevision"),
    "imported": () => t("chapter.imported"),
    "audit-failed": () => t("chapter.auditFailed"),
    "state-degraded": () => t("chapter.stateDegraded"),
  };
  return map[status]?.() ?? status;
}

function statusDotState(status: string): BookStepState {
  if (status === "approved") return "done";
  if (status === "audit-failed") return "blocked";
  if (status === "ready-for-review" || status === "needs-revision" || status === "state-degraded") return "current";
  return "todo";
}

function statusTone(status: string): string {
  if (status === "audit-failed") return "text-seal-text";
  if (status === "ready-for-review" || status === "needs-revision" || status === "state-degraded") return "text-mark-text";
  if (status === "approved") return "text-foreground";
  return "text-muted-foreground";
}

export function BookDetail({
  bookId,
  nav,
  theme: _theme,
  t,
  sse,
}: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse: { messages: ReadonlyArray<SSEMessage> };
}) {
  const { data, loading, error, refetch } = useApi<BookData>(`/books/${bookId}`);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [writeRequestPending, setWriteRequestPending] = useState(false);
  const [draftRequestPending, setDraftRequestPending] = useState(false);
  const stage = useBookStage(bookId);
  const [rewritingChapters, setRewritingChapters] = useState<ReadonlyArray<number>>([]);
  const [revisingChapters, setRevisingChapters] = useState<ReadonlyArray<number>>([]);
  const [syncingChapters, setSyncingChapters] = useState<ReadonlyArray<number>>([]);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("txt");
  const [exportApprovedOnly, setExportApprovedOnly] = useState(false);
  const [bookActionPending, setBookActionPending] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<"auto" | "manual">("auto");
  const [skipPreviousApproval, setSkipPreviousApproval] = useState(false);
  const [preflight, setPreflight] = useState<{ ok: boolean; reasons: Array<{ code?: string; message?: string; messageZh?: string; chapterNumber?: number }> } | null>(null);
  const [reviewQueue, setReviewQueue] = useState<ReadonlyArray<{
    chapterNumber: number;
    severity: string;
    category: string;
    description: string;
  }>>([]);
  const [briefPrompt, setBriefPrompt] = useState<{ kind: BriefKind; chapter: number; mode?: ReviseMode } | null>(null);
  const [briefValue, setBriefValue] = useState("");
  const [overridePrompt, setOverridePrompt] = useState<{
    chapter: number;
    remaining: ReadonlyArray<number>;
  } | null>(null);
  const [overrideValue, setOverrideValue] = useState("");
  const [writeChapter, setWriteChapter] = useState<number | null>(null);
  const [directoryOpen, setDirectoryOpen] = useState(true);
  const writeLeaveGuard = useRef<WriteLeaveGuard | null>(null);
  const [chapterSwitchPending, setChapterSwitchPending] = useState(false);
  const registerWriteGuard = useCallback((guard: WriteLeaveGuard | null) => { writeLeaveGuard.current = guard; }, []);
  const switchWriteChapter = async (chapter: number) => {
    if (chapterSwitchPending || chapter === writeChapter) return;
    setChapterSwitchPending(true);
    try {
      if (writeLeaveGuard.current && !(await writeLeaveGuard.current())) return;
      setWriteChapter(chapter);
      usePreferencesStore.getState().setLastChapter(bookId, chapter);
    } finally {
      setChapterSwitchPending(false);
    }
  };
  useEffect(() => { setWriteChapter(null); }, [bookId]);
  useEffect(() => {
    if (data?.book.id === bookId && writeChapter === null) {
      const previous = usePreferencesStore.getState().lastChapters[bookId];
      const restored = previous && (previous === data.nextChapter || data.chapters.some((chapter) => chapter.number === previous)) ? previous : data.nextChapter;
      setWriteChapter(restored);
      usePreferencesStore.getState().setLastChapter(bookId, restored);
    }
  }, [bookId, data?.book.id, data?.nextChapter, writeChapter]);


  useEffect(() => {
    void fetchJson<{ mode?: string }>(`/books/${encodeURIComponent(bookId)}/chapter-review-mode`)
      .then((r) => setReviewMode(r.mode === "manual" ? "manual" : "auto"))
      .catch(() => undefined);
  }, [bookId]);
  const activity = useMemo(() => deriveBookActivity(sse.messages, bookId), [bookId, sse.messages]);
  const writing = writeRequestPending || activity.writing;
  const drafting = draftRequestPending || activity.drafting;
  const latestPersistedChapter = data ? data.nextChapter - 1 : 0;

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;

    const payload = recent.data as { bookId?: string } | null;
    if (payload?.bookId !== bookId) return;

    if (recent.event === "write:start") {
      setWriteRequestPending(false);
      return;
    }

    if (recent.event === "draft:start") {
      setDraftRequestPending(false);
      return;
    }

    if (shouldRefetchBookView(recent, bookId)) {
      setWriteRequestPending(false);
      setDraftRequestPending(false);
      refetch();
    }
  }, [bookId, refetch, sse.messages]);

  useEffect(() => {
    const query = skipPreviousApproval ? "?skipPreviousApproval=1" : "";
    void fetchJson<{ ok: boolean; reasons?: Array<{ code?: string; message?: string; messageZh?: string; chapterNumber?: number }> }>(`/books/${bookId}/write-preflight${query}`)
      .then((body) => setPreflight({ ok: body.ok, reasons: body.reasons ?? [] }))
      .catch(() => setPreflight({ ok: true, reasons: [] }));
    void fetchJson<{ items?: Array<{ chapterNumber: number; severity: string; category: string; description: string }> }>(`/books/${bookId}/review-queue`)
      .then((body) => setReviewQueue(body.items ?? []))
      .catch(() => setReviewQueue([]));
  }, [bookId, skipPreviousApproval, data?.nextChapter, activity.lastError]);

  const handleWriteNext = async () => {
    setWriteRequestPending(true);
    try {
      await startWriteNext(bookId, skipPreviousApproval);
    } catch (e) {
      setWriteRequestPending(false);
      setActionMessage(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleDraft = async () => {
    setDraftRequestPending(true);
    try {
      await startDraft(bookId, skipPreviousApproval);
    } catch (e) {
      setDraftRequestPending(false);
      setActionMessage(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleToggleReviewMode = async () => {
    const next = reviewMode === "manual" ? "auto" : "manual";
    setReviewMode(next);
    try {
      await fetchJson(`/books/${encodeURIComponent(bookId)}/chapter-review-mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
    } catch {
      setReviewMode(reviewMode);
    }
  };

  const runRewrite = async (chapterNum: number, brief: string) => {
    setRewritingChapters((prev) => [...prev, chapterNum]);
    try {
      await fetchJson(`/books/${bookId}/rewrite/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: brief.trim() || undefined }),
      });
      refetch();
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : "Rewrite failed");
    } finally {
      setRewritingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const runRevise = async (chapterNum: number, mode: ReviseMode, brief: string) => {
    setRevisingChapters((prev) => [...prev, chapterNum]);
    try {
      await fetchJson(`/books/${bookId}/revise/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, brief: brief.trim() || undefined }),
      });
      refetch();
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : "Revision failed");
    } finally {
      setRevisingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const runSync = async (chapterNum: number, brief: string) => {
    setSyncingChapters((prev) => [...prev, chapterNum]);
    try {
      await fetchJson(`/books/${bookId}/resync/${chapterNum}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: brief.trim() || undefined }),
      });
      refetch();
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncingChapters((prev) => prev.filter((n) => n !== chapterNum));
    }
  };

  const approveChapter = async (chapterNum: number, why?: string) => {
    await postApi(`/books/${bookId}/chapters/${chapterNum}/approve`, why?.trim()
      ? { override: { who: "author", why: why.trim() } }
      : {});
  };

  const approveQueue = async (queue: ReadonlyArray<number>) => {
    const remaining = [...queue];
    let failed = 0;
    while (remaining.length > 0) {
      const chapterNum = remaining[0]!;
      try {
        await approveChapter(chapterNum);
        remaining.shift();
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/critical|须处理|APPROVE_BLOCKED/i.test(message) || /APPROVE_BLOCKED/.test(String(error))) {
          setOverridePrompt({ chapter: chapterNum, remaining: remaining.slice(1) });
          setOverrideValue("");
          return;
        }
        failed += 1;
        remaining.shift();
      }
    }
    if (failed > 0) {
      setActionMessage(`${failed} approve(s) failed`);
    }
    refetch();
  };

  const handleApprove = async (chapterNum: number) => {
    try {
      await approveChapter(chapterNum);
      refetch();
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      if (/critical|须处理|APPROVE_BLOCKED/i.test(message) || /APPROVE_BLOCKED/.test(String(e))) {
        setOverridePrompt({ chapter: chapterNum, remaining: [] });
        setOverrideValue("");
        return;
      }
      setActionMessage(e instanceof Error ? e.message : "Approve failed");
    }
  };

  const handleApproveAll = async () => {
    if (!data) return;
    await approveQueue(data.chapters.filter((ch) => ch.status === "ready-for-review").map((ch) => ch.number));
  };

  const confirmOverride = async () => {
    if (!overridePrompt) return;
    const why = overrideValue.trim();
    if (!why) return;
    const { chapter, remaining } = overridePrompt;
    setOverridePrompt(null);
    try {
      await approveChapter(chapter, why);
    } catch (retry) {
      setActionMessage(retry instanceof Error ? retry.message : "Approve failed");
      refetch();
      return;
    }
    if (remaining.length > 0) {
      await approveQueue(remaining);
      return;
    }
    refetch();
  };

  const runBookAction = async (key: string, action: () => Promise<string>) => {
    setBookActionPending(key);
    try {
      setActionMessage(await action());
      refetch();
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBookActionPending(null);
    }
  };

  const handleRepairState = async (chapterNum: number) => {
    await runBookAction(`repair-state-${chapterNum}`, async () => {
      await fetchJson(`/books/${bookId}/repair-state/${chapterNum}`, { method: "POST" });
      return data?.book.language === "en" ? `Chapter ${chapterNum} state repaired.` : `第 ${chapterNum} 章状态已修复。`;
    });
  };

  const confirmBrief = () => {
    if (!briefPrompt) return;
    const { kind, chapter, mode } = briefPrompt;
    const brief = briefValue;
    setBriefPrompt(null);
    setBriefValue("");
    if (kind === "rewrite") void runRewrite(chapter, brief);
    else if (kind === "revise" && mode) void runRevise(chapter, mode, brief);
    else if (kind === "sync") void runSync(chapter, brief);
  };

  const bookIsZh = data?.book.language !== "en";
  const briefCopy = (kind: BriefKind) => {
    if (kind === "rewrite") {
      return bookIsZh
        ? { title: t("book.rewrite"), message: "可选：输入这次重写要遵循的补充想法。留空则沿用现有 focus。" }
        : { title: t("book.rewrite"), message: "Optional rewrite brief for this run only. Leave blank to use existing focus." };
    }
    if (kind === "sync") {
      return bookIsZh
        ? { title: t("book.syncTruth"), message: "可选：输入这次同步时要遵循的补充说明。留空则直接按正文同步。" }
        : { title: t("book.syncTruth"), message: "Optional sync brief for interpreting the edited chapter body. Leave blank to sync directly from the text." };
    }
    return bookIsZh
      ? { title: t("book.reviseWith"), message: "可选：输入这次修订要遵循的补充想法。留空则沿用现有 focus。" }
      : { title: t("book.reviseWith"), message: "Optional revise brief for this run only. Leave blank to use existing focus." };
  };

  if (loading && !data) return (
    <div className="flex flex-col items-center justify-center py-32 space-y-4">
      <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
    </div>
  );

  if (error) return <div className="text-destructive p-8 bg-destructive/5 rounded-xl border border-destructive/20">Error: {error}</div>;
  if (!data) return null;

  const { book, chapters } = data;
  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);
  const reviewCount = chapters.filter((ch) => ch.status === "ready-for-review").length;

  const preflightOk = preflight?.ok !== false;
  const showSkip = hasPreviousChapterUnapprovedReason(preflight?.reasons ?? []);
  const isZh = book.language !== "en";
  const emptyCopy = writeEmptyCopy({
    hasOutline: stage?.stage === "write" || Boolean(stage?.steps.weave === "done"),
    previousUnapproved: showSkip ? (preflight?.reasons.find((reason) => reason.chapterNumber)?.chapterNumber) : undefined,
    isZh,
  });

  const exportHref = bookManuscriptExportPath(bookId, exportFormat, exportApprovedOnly);
  const briefDialog = briefPrompt ? briefCopy(briefPrompt.kind) : null;

  return (
    <div className="write-workspace-page">


      {(writing || drafting || activity.lastError || actionMessage || (typeof bookActionPending === "string" && bookActionPending.startsWith("saved:"))) && (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            activity.lastError
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-border bg-card text-foreground"
          }`}
        >
          {activity.lastError ? (
            <span>{t("book.pipelineFailed")}: {activity.lastError}</span>
          ) : writing ? (
            <span>{t("book.pipelineWriting")}</span>
          ) : drafting ? (
            <span>{t("book.pipelineDrafting")}</span>
          ) : actionMessage ? (
            <span className="whitespace-pre-wrap">{actionMessage}</span>
          ) : (
            <span>{t("common.exportSuccess")}</span>
          )}
        </div>
      )}

      <div className="write-directory-control"><button type="button" className="btn-ghost inline-flex items-center gap-2" aria-expanded={directoryOpen} onClick={() => setDirectoryOpen((value) => !value)}><List size={16} />{t("write.directory")}</button></div>
      <div className={`one-workspace ${!directoryOpen ? "directory-collapsed" : ""}`}>
        <nav className="one-directory" hidden={!directoryOpen} aria-label={t("write.directory")}>
          {chapters.length > 0 && (
            chapters.map((ch) => (
              <div key={ch.number} className="flex items-start gap-1">
                <button
                  type="button"
                  className={`dir-item ${(writeChapter ?? data.nextChapter) === ch.number ? "active" : ""}`}
                  disabled={chapterSwitchPending}
                  aria-current={(writeChapter ?? data.nextChapter) === ch.number ? "page" : undefined}
                  onClick={() => void switchWriteChapter(ch.number)}
                >
                  {ch.title || t("chapter.label").replace("{n}", String(ch.number))}
                  <small className={statusTone(ch.status)}>
                    <StageDot state={statusDotState(ch.status)} />
                    {" "}{translateChapterStatus(ch.status, t)} · {(ch.wordCount ?? 0).toLocaleString()} {t("book.words")}
                  </small>
                </button>
                {(writeChapter ?? data.nextChapter) === ch.number ? <DropdownMenu>
                  <DropdownMenuTrigger
                    data-testid={`chapter-more-${ch.number}`}
                    aria-label={isZh ? "当前章节工具" : "Current chapter tools"}
                    className="btn-ghost inline-flex h-8 w-8 items-center justify-center"
                  >
                    <MoreHorizontal size={14} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-44">
                    {ch.status === "ready-for-review" ? <DropdownMenuItem data-testid={`chapter-approve-${ch.number}`} onClick={() => void handleApprove(ch.number)}>{t("book.approve")}</DropdownMenuItem> : null}
                    <DropdownMenuItem onClick={() => nav.toChapter(bookId, ch.number)}>
                      {t("reader.preview")}
                    </DropdownMenuItem>
                    {ch.status === "ready-for-review" && (
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={async () => {
                          try { await postApi(`/books/${bookId}/chapters/${ch.number}/reject`); refetch(); }
                          catch (e) { setActionMessage(e instanceof Error ? e.message : "Reject failed"); }
                        }}
                      >
                        {t("book.rollbackChapter")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onClick={async () => {
                        try {
                          const auditResult = await fetchJson<{ passed?: boolean; issues?: unknown[] }>(`/books/${bookId}/audit/${ch.number}`, { method: "POST" });
                          setActionMessage(auditResult.passed
                            ? (isZh ? "审校已通过" : "Audit passed")
                            : (isZh ? `审校未过：${auditResult.issues?.length ?? 0} 条` : `Audit failed: ${auditResult.issues?.length ?? 0} issues`));
                          refetch();
                        } catch (e) {
                          setActionMessage(e instanceof Error ? e.message : "Audit failed");
                        }
                      }}
                    >
                      {t("book.audit")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={rewritingChapters.includes(ch.number)}
                      onClick={() => {
                        setBriefPrompt({ kind: "rewrite", chapter: ch.number });
                        setBriefValue("");
                      }}
                    >
                      {t("book.rewrite")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={syncingChapters.includes(ch.number) || ch.number !== latestPersistedChapter}
                      onClick={() => {
                        setBriefPrompt({ kind: "sync", chapter: ch.number });
                        setBriefValue("");
                      }}
                    >
                      {t("book.syncTruth")}
                    </DropdownMenuItem>
                    {ch.status === "state-degraded" && (
                      <DropdownMenuItem
                        disabled={bookActionPending === `repair-state-${ch.number}`}
                        onClick={() => void handleRepairState(ch.number)}
                      >
                        {t("book.repairState")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>{t("book.reviseWith")}</DropdownMenuLabel>
                    {([
                      ["spot-fix", t("book.spotFix")],
                      ["polish", t("book.polish")],
                      ["rewrite", t("book.rewrite")],
                      ["rework", t("book.rework")],
                      ["anti-detect", t("book.antiDetect")],
                    ] as const).map(([mode, label]) => (
                      <DropdownMenuItem
                        key={mode}
                        disabled={revisingChapters.includes(ch.number)}
                        onClick={() => {
                          setBriefPrompt({ kind: "revise", chapter: ch.number, mode });
                          setBriefValue("");
                        }}
                      >
                        {label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu> : null}
              </div>
            ))
          )}
          <div className="write-directory-next">
            <button type="button" className={`dir-item ${(writeChapter ?? data.nextChapter) === data.nextChapter ? "active" : ""}`} disabled={chapterSwitchPending} onClick={() => void switchWriteChapter(data.nextChapter)}>
              {isZh ? `第 ${data.nextChapter} 章 · 新章` : `Chapter ${data.nextChapter} · New`}
            </button>
          </div>
        </nav>
        <div className="one-document">
          <AuthoringWritePanel
            key={`${bookId}:${writeChapter ?? data.nextChapter}`}
            bookId={bookId}
            chapterNumber={writeChapter ?? data.nextChapter}
            chapterTitle={data.chapters.find((item) => item.number === (writeChapter ?? data.nextChapter))?.title}
            isZh={isZh}
            onChanged={() => refetch()}
            onRegisterBeforeLeave={registerWriteGuard}
          />
          {stage && chapters.length === 0 && (emptyCopy.target === "weave" || (emptyCopy.target === "write" && showSkip)) && (
            <LiteraryEmpty
              title={emptyCopy.title}
              subtitle={emptyCopy.subtitle}
              action={emptyCopy.target === "weave" || (emptyCopy.target === "write" && showSkip) ? emptyCopy.action : undefined}
              onAction={() => {
                if (emptyCopy.target === "weave") {
                  nav.toOutline(bookId);
                  return;
                }
                const chapter = preflight?.reasons.find((reason) => reason.chapterNumber)?.chapterNumber;
                if (chapter) nav.toChapter(bookId, chapter);
              }}
              className="px-6 py-14 sm:px-8"
              testId="write-empty"
            />
          )}
        </div>
      </div>

        <details className="write-legacy" data-testid="write-legacy-tools">
          <summary>{isZh ? "连续创作与作品工具" : "Serial writing and book tools"}</summary>
          <p className="my-3 text-sm text-muted-foreground">{book.genre} · {chapters.length} {t("dash.chapters")} · {formatStudyWords(totalWords, isZh)}</p>
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger className="btn-secondary inline-flex items-center gap-1.5">
              <Download size={14} />
              {t("book.exportMenu")}
              <ChevronDown size={14} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 p-3 space-y-3">
              {(["txt", "md", "epub"] as const).map((format) => (
                <label key={format} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="export-format"
                    checked={exportFormat === format}
                    onChange={() => setExportFormat(format)}
                  />
                  {format.toUpperCase()}
                </label>
              ))}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={exportApprovedOnly} onChange={(e) => setExportApprovedOnly(e.target.checked)} />
                {t("book.approvedOnly")}
              </label>
              <div className="flex flex-col gap-1 pt-1">
                <a href={exportHref} download data-testid="book-export-manuscript" className="btn-secondary text-center">
                  {t("book.download")}
                </a>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const exported = await fetchJson<{ path?: string; chapters?: number }>(`/books/${bookId}/export-save`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ format: exportFormat, approvedOnly: exportApprovedOnly }),
                      });
                      setBookActionPending(`saved:${exported.path ?? ""}`);
                    } catch (e) {
                      setBookActionPending(e instanceof Error ? e.message : "Export failed");
                    }
                  }}
                  className="btn-ghost w-full"
                >
                  {t("book.exportSave")}
                </button>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="inline-flex overflow-hidden rounded-[10px] bg-primary text-primary-foreground">
            <button
              type="button"
              onClick={handleWriteNext}
              disabled={writing || drafting || !preflightOk}
              className="inline-flex h-10 items-center gap-2 px-5 text-[14px] font-medium disabled:opacity-40"
              data-testid="write-next-primary"
            >
              {writing ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Feather size={16} />}
              {writing ? t("dash.writing") : t("cockpit.writeNext")}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger className="border-l border-primary-foreground/20 px-2">
                <ChevronDown size={14} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void handleDraft()}>{t("book.draftOnly")}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleToggleReviewMode()}>
                  {reviewMode === "manual" ? t("book.reviewManual") : t("book.reviewAuto")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

      <SerialCockpitStrip
        bookId={bookId}
        isZh={isZh}
        skipPreviousApproval={skipPreviousApproval}
        onSkipChange={setSkipPreviousApproval}
        showSkip={showSkip}
        onJumpOutline={() => nav.toOutline(bookId)}
        onJumpReview={(chapterNumber) => {
          if (chapterNumber) nav.toChapter(bookId, chapterNumber);
        }}
      />

      {reviewQueue.length > 0 && (
        <div className="rounded-2xl border border-border bg-mark-soft px-4 py-3 space-y-2" data-testid="review-queue">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">{isZh ? "等你过目" : "Review queue"}</div>
            {reviewCount > 0 && (
              <button type="button" onClick={() => void handleApproveAll()} className="btn-secondary h-8 px-3 text-[13px]">
                {t("book.approveAll")} ({reviewCount})
              </button>
            )}
          </div>
          <ul className="space-y-1 text-sm">
            {reviewQueue.slice(0, 12).flatMap((item, index) => {
              const copy = formatReviewIssueCopy(item, isZh);
              if (!copy) return [];
              return [(
                <li key={`${item.chapterNumber}-${item.category}-${index}`}>
                  <span className={isMustFixSeverity(item.severity) ? "text-seal-text font-medium" : "text-mark-text"}>
                    {copy.severity}
                  </span>{" "}
                  {isZh ? "第" : "Ch."}{item.chapterNumber} · {copy.category}: {copy.description}
                </li>
              )];
            })}
          </ul>
        </div>
      )}

        </details>

      <ConfirmDialog
        open={Boolean(briefPrompt)}
        title={briefDialog?.title ?? ""}
        message={briefDialog?.message ?? ""}
        confirmLabel={isZh ? "继续" : "Continue"}
        cancelLabel={t("common.cancel")}
        onCancel={() => { setBriefPrompt(null); setBriefValue(""); }}
        onConfirm={confirmBrief}
      >
        <input
          data-testid="chapter-brief-input"
          value={briefValue}
          onChange={(event) => setBriefValue(event.target.value)}
          className="mt-3 w-full rounded-[10px] border border-border-strong bg-card px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(overridePrompt)}
        title={t("reader.stillApprove")}
        message={overridePrompt
          ? (isZh
            ? `第 ${overridePrompt.chapter} 章仍有须处理的问题。写下原因后仍可通过。`
            : `Chapter ${overridePrompt.chapter} still has must-fix issues. Type a reason to approve anyway.`)
          : ""}
        confirmLabel={t("book.approve")}
        cancelLabel={t("common.cancel")}
        onCancel={() => { setOverridePrompt(null); setOverrideValue(""); }}
        onConfirm={() => void confirmOverride()}
      >
        <input
          data-testid="approve-override-input"
          value={overrideValue}
          onChange={(event) => setOverrideValue(event.target.value)}
          placeholder={t("reader.overrideWhy")}
          className="mt-3 w-full rounded-[10px] border border-border-strong bg-card px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
      </ConfirmDialog>
    </div>
  );
}
