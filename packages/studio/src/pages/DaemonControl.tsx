import { useApi, postApi, putApi } from "../hooks/use-api";
import { useEffect, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import { useI18n, type TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import { shouldRefetchDaemonStatus } from "../hooks/use-book-activity";
import { formatActivityEvent } from "../lib/activity-copy";
import { showToast } from "../lib/toast";

interface Nav {
  toDashboard: () => void;
}

export function DaemonControl({ nav: _nav, theme: _theme, t, sse }: { nav: Nav; theme: Theme; t: TFunction; sse: { messages: ReadonlyArray<SSEMessage> } }) {
  const { lang } = useI18n();
  const isZh = lang !== "en";
  const { data, refetch } = useApi<{ running: boolean }>("/daemon");
  const { data: reviewMode, refetch: refetchReviewMode } = useApi<{ mode: "auto" | "manual" }>("/project/chapter-review-mode");
  const { data: booksData } = useApi<{ books: ReadonlyArray<{ id: string; title: string }> }>("/books");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!shouldRefetchDaemonStatus(recent)) return;
    void refetch();
  }, [refetch, sse.messages]);

  const books = booksData?.books ?? [];
  const daemonLines = sse.messages
    .filter((m) => m.event.startsWith("daemon:") || m.event === "log")
    .map((msg) => formatActivityEvent(msg, books, isZh))
    .filter((line): line is NonNullable<typeof line> => line !== null)
    .slice(-20);

  const handleStart = async () => {
    setLoading(true);
    try {
      await postApi("/daemon/start");
      refetch();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      await postApi("/daemon/stop");
      refetch();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setLoading(false);
    }
  };

  const isRunning = data?.running ?? false;
  const reviewIsManual = reviewMode?.mode === "manual";
  const setReviewMode = async (mode: "auto" | "manual") => {
    try {
      await putApi("/project/chapter-review-mode", { mode });
      await refetchReviewMode();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "审稿方式没有改成", "error");
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="font-serif text-[32px] font-medium leading-10">{t("daemon.title")}</h1>
          <p className="mt-2 max-w-xl text-[15px] leading-[26px] text-muted-foreground">
            {isZh
              ? "自动模式会自己按顺序往下写。平时写下一章，请回书房用落笔。自动模式记下的人物和伏笔，落笔写后面的章时会按章号补进来。已经用落笔采用的章，以落笔账本为准。"
              : "Auto mode writes the next chapters on its own. For a chapter you are writing now, go back to 落笔. Hooks and character notes from auto mode are merged by chapter number when 落笔 continues. Chapters adopted in 落笔 keep the 落笔 ledger."}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm" data-testid="chapter-review-mode">
            <span className="text-muted-foreground">{isZh ? "审稿方式" : "Review"}</span>
            <button
              type="button"
              className={`rounded-lg border px-3 py-1.5 ${reviewIsManual ? "border-border" : "border-primary bg-primary text-primary-foreground"}`}
              onClick={() => void setReviewMode("auto")}
            >
              {isZh ? "自动" : "Auto"}
            </button>
            <button
              type="button"
              className={`rounded-lg border px-3 py-1.5 ${reviewIsManual ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
              onClick={() => void setReviewMode("manual")}
            >
              {isZh ? "人工" : "Manual"}
            </button>
            <span className="text-muted-foreground">
              {isZh
                ? "自动：写完按审稿结果继续。人工：写完停下来等你看。"
                : "Auto continues after review. Manual stops when the chapter is drafted."}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-[13px] font-medium ${isRunning ? "text-foreground" : "text-muted-foreground"}`}>
            {isRunning ? t("daemon.running") : t("daemon.stopped")}
          </span>
          {isRunning ? (
            <button
              onClick={handleStop}
              disabled={loading}
              className="btn-danger disabled:opacity-50"
            >
              {loading ? t("daemon.stopping") : t("daemon.stop")}
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={loading}
              className="btn-primary disabled:opacity-50"
            >
              {loading ? t("daemon.starting") : t("daemon.start")}
            </button>
          )}
        </div>
      </div>

      <div>
        <div className="mb-3 text-[13px] font-medium text-muted-foreground">{t("daemon.eventLog")}</div>
        {daemonLines.length > 0 ? (
          <div className="space-y-2 text-[15px] leading-[26px]" data-testid="daemon-event-lines">
            {daemonLines.map((line, i) => (
              <div key={`${line.time}-${line.text}-${i}`} className="flex gap-3 text-muted-foreground">
                <span className="w-12 shrink-0 tabular-nums">{line.time}</span>
                <span>{line.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[15px] leading-[26px] text-muted-foreground py-8">
            {isRunning ? t("daemon.waitingEvents") : t("daemon.schedulerIdle")}
          </p>
        )}
      </div>
    </div>
  );
}
