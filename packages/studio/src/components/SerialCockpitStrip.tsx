import { fetchJson } from "../hooks/use-api";
import { useEffect, useState } from "react";
import { stripEngineTokens } from "../lib/copy-map";
import { findChapterNode, parseVolumeMapTree } from "../lib/volume-map-tree";

export interface WritePreflightReason {
  readonly code: string;
  readonly message: string;
  readonly messageZh: string;
  readonly jumpTo?: "outline" | "intent" | "review";
  readonly chapterNumber?: number;
}

export interface WritePreflightEvaluation {
  readonly ok: boolean;
  readonly chapterNumber: number;
  readonly reasons: ReadonlyArray<WritePreflightReason>;
  readonly message: string;
}

export interface DueHook {
  readonly hookId: string;
  readonly dueState?: string;
  readonly targetChapter?: number;
  readonly status?: string;
  readonly label?: string;
}

export function SerialCockpitStrip({
  bookId,
  isZh,
  onJumpOutline,
  onJumpReview,
  skipPreviousApproval,
  onSkipChange,
  showSkip = true,
}: {
  readonly bookId: string;
  readonly isZh: boolean;
  readonly onJumpOutline?: () => void;
  readonly onJumpReview?: (chapterNumber?: number) => void;
  readonly skipPreviousApproval: boolean;
  readonly onSkipChange: (next: boolean) => void;
  readonly showSkip?: boolean;
}) {
  const [preflight, setPreflight] = useState<WritePreflightEvaluation | null>(null);
  const [hooks, setHooks] = useState<ReadonlyArray<DueHook>>([]);
  const [openHooks, setOpenHooks] = useState<ReadonlyArray<DueHook>>([]);
  const [volumeMap, setVolumeMap] = useState("");

  useEffect(() => {
    const query = skipPreviousApproval ? "?skipPreviousApproval=1" : "";
    void fetchJson<WritePreflightEvaluation>(`/books/${bookId}/write-preflight${query}`)
      .then(setPreflight)
      .catch(() => setPreflight(null));
    void fetchJson<{ hooks?: DueHook[]; openHooks?: DueHook[] }>(`/books/${bookId}/hooks/due`)
      .then((body) => {
        setHooks(body.hooks ?? []);
        setOpenHooks(body.openHooks ?? []);
      })
      .catch(() => {
        setHooks([]);
        setOpenHooks([]);
      });
    void fetchJson<{ content?: string | null }>(`/books/${bookId}/truth/outline/volume_map.md`)
      .then((body) => setVolumeMap(body.content ?? ""))
      .catch(() => setVolumeMap(""));
  }, [bookId, skipPreviousApproval]);

  const nextTitle = (() => {
    const chapterNumber = preflight?.chapterNumber;
    if (!chapterNumber || !volumeMap) return "";
    return findChapterNode(parseVolumeMapTree(volumeMap), chapterNumber)?.title ?? "";
  })();

  const blocked = preflight !== null && !preflight.ok;
  const chapterNumber = preflight?.chapterNumber;
  const titleLine = chapterNumber != null
    ? (isZh
      ? `下一章 · 第 ${chapterNumber} 章${nextTitle ? ` ${nextTitle}` : ""}`
      : `Next · Ch. ${chapterNumber}${nextTitle ? ` ${nextTitle}` : ""}`)
    : (isZh ? "下一章" : "Next chapter");

  return (
    <div className="space-y-2" data-testid="serial-cockpit">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[15px] leading-[26px] font-medium" data-testid="serial-next-line">
          {titleLine}
        </div>
        {showSkip && (
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <input
            type="checkbox"
            checked={skipPreviousApproval}
            onChange={(event) => onSkipChange(event.target.checked)}
          />
          {isZh ? "上一章未通过，仍要继续" : "Previous chapter is unapproved, continue anyway"}
        </label>
        )}
      </div>
      {hooks.length > 0 && (
        <div className="text-[13px] text-mark-text">
          {isZh ? "到期/逾期伏笔：" : "Due/overdue hooks: "}
          {hooks.map((hook) => `${stripEngineTokens(hook.label || hook.hookId)}${hook.dueState === "overdue" ? (isZh ? "（逾期）" : " (overdue)") : ""}`).join(" · ")}
        </div>
      )}
      {openHooks.length > 0 && (
        <div className="text-[13px] text-mark-text" data-testid="open-hooks-line">
          {isZh ? "待收伏笔：" : "Open threads: "}
          {openHooks.map((hook) => stripEngineTokens(hook.label || hook.hookId)).join(" · ")}
        </div>
      )}
      {blocked && (
        <ul className="space-y-1 text-[13px] text-muted-foreground">
          {preflight.reasons.map((reason) => (
            <li key={reason.code} className="flex gap-2">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-seal" aria-hidden="true" />
              <span>
              {isZh ? reason.messageZh : reason.message}
              {reason.jumpTo === "outline" && onJumpOutline && (
                <button type="button" className="ml-2 underline decoration-[color-mix(in_oklch,var(--foreground)_35%,transparent)] hover:decoration-seal" onClick={onJumpOutline}>
                  {isZh ? "去织卷" : "Open weave"}
                </button>
              )}
              {reason.jumpTo === "review" && onJumpReview && (
                <button type="button" className="ml-2 underline decoration-[color-mix(in_oklch,var(--foreground)_35%,transparent)] hover:decoration-seal" onClick={() => onJumpReview(reason.chapterNumber)}>
                  {isZh ? "去审稿" : "Open review"}
                </button>
              )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


