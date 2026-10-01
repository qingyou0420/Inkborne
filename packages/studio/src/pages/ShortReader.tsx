/**
 * 短篇 — short-fiction chrome around the existing staged manuscript.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { cjk } from "@streamdown/cjk";
import { AlertCircle, Copy, Download, Feather, Loader2, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { Streamdown } from "streamdown";
import { FanqieExportFields } from "../components/FanqieExportFields";
import { normalizeRange } from "../lib/export-range";
import { fanqieRangeProblem } from "../lib/fanqie-range";
import { LiteraryEmpty } from "../components/LiteraryEmpty";
import { StageDot } from "../components/StageDot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { useApi } from "../hooks/use-api";
import { useI18n, type TFunction } from "../hooks/use-i18n";
import type { Theme } from "../hooks/use-theme";
import { tr } from "../lib/app-language";
import { deriveShortStudy, shortStudyCtaLabel } from "../lib/short-study";
import { copyToClipboard, describeFanqieManuscript, renderFanqieManuscript } from "../lib/fanqie-text";
import { showToast } from "../lib/toast";
import { continueShortPrompt, shortManuscriptExportPath, type FanqieExportQuery } from "../lib/work-export";
import type { StudioShortDetail } from "../shared/short-works";
import { useChatStore } from "../store/chat";

const streamdownPlugins = { cjk };

interface Nav {
  toDashboard: () => void;
  toChat?: () => void;
  toShort?: (id: string) => void;
  toShortSettings?: (id: string) => void;
  toShortAnalytics?: (id: string) => void;
}

const STEPS = [
  { id: "ask" as const, zh: "问心", en: "Ask", clickable: true },
  { id: "weave" as const, zh: "织卷", en: "Weave", clickable: false },
  { id: "write" as const, zh: "落笔", en: "Write", clickable: false },
];

export function ShortReader({ storyId, nav, theme: _theme, t }: {
  storyId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
}) {
  const { lang } = useI18n();
  const isZh = lang !== "en";
  const [fanqieFrom, setFanqieFrom] = useState("");
  const [fanqieTo, setFanqieTo] = useState("");
  const [fanqieLayout, setFanqieLayout] = useState<"combined" | "per-chapter">("combined");
  const [fanqieBlankLine, setFanqieBlankLine] = useState(true);
  const [fanqieIndent, setFanqieIndent] = useState(false);
  const { data, loading, error } = useApi<StudioShortDetail>(`/shorts/${encodeURIComponent(storyId)}`);
  const study = data
    ? deriveShortStudy({
      status: data.status,
      contentKind: data.contentKind,
      hasDirection: Boolean(data.direction?.trim()),
    })
    : null;
  const createDraftSession = useChatStore((state) => state.createDraftSession);
  const setInput = useChatStore((state) => state.setInput);
  const activateSession = useChatStore((state) => state.activateSession);
  const sessions = useChatStore((state) => state.sessions);

  const openAsk = () => {
    if (!data) return;
    const existing = Object.values(sessions).find((session) => session.sessionKind === "short");
    if (existing) {
      activateSession(existing.sessionId);
      nav.toChat?.();
      return;
    }
    const sessionId = createDraftSession(null, "short");
    activateSession(sessionId);
    nav.toChat?.();
  };

  const continueTalk = () => {
    if (!data) return;
    const sessionId = createDraftSession(null, "short");
    const prompt = continueShortPrompt(data.title, storyId);
    setInput(isZh ? prompt.zh : prompt.en);
    activateSession(sessionId);
    nav.toChat?.();
  };

  const onPrimary = () => {
    if (!study || !data) return;
    if (study.primaryCta === "export") {
      window.location.assign(shortManuscriptExportPath(storyId));
      return;
    }
    if (study.primaryCta === "ask") {
      openAsk();
      return;
    }
    continueTalk();
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8" data-testid="short-study">
      <div className="flex flex-wrap items-center justify-between gap-3" data-testid="short-study-chrome">
        <button
          type="button"
          data-testid="short-study-home"
          onClick={() => nav.toShort?.(storyId)}
          className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-[14px] font-medium text-primary-foreground"
        >
          {isZh ? "书房" : "Study"}
        </button>
        {study && (
          <ol className="flex items-center gap-1" data-testid="short-stage-strip">
            {STEPS.map((step, index) => {
              const state = study.steps[step.id];
              const label = isZh ? step.zh : step.en;
              const inner = (
                <>
                  <StageDot state={state} />
                  {label}
                </>
              );
              return (
                <li key={step.id} className="flex items-center gap-1 text-[13px]">
                  {index > 0 && <span className="h-px w-4 bg-border" aria-hidden="true" />}
                  {step.clickable ? (
                    <button
                      type="button"
                      data-testid={`short-step-${step.id}`}
                      data-state={state}
                      onClick={openAsk}
                      className={`inline-flex items-center gap-1.5 ${state === "current" ? "font-medium" : "text-muted-foreground"}`}
                    >
                      {inner}
                    </button>
                  ) : (
                    <span
                      data-testid={`short-step-${step.id}`}
                      data-state={state}
                      className={`inline-flex items-center gap-1.5 ${state === "current" ? "font-medium" : "text-muted-foreground"}`}
                    >
                      {inner}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger data-testid="short-more" className="btn-ghost inline-flex h-8 w-8 items-center justify-center">
            <MoreHorizontal size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => nav.toShortSettings?.(storyId)}>{t("short.settings")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => nav.toShortAnalytics?.(storyId)}>{t("book.analytics")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.location.assign(shortManuscriptExportPath(storyId))}>
              {t("book.export")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 size={18} className="animate-spin" />
          {tr("正在打开短篇…", "Opening short…")}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {data && study && (
        <>
          <header className="space-y-3">
            <div className="literary-kicker">{isZh ? "短篇" : "Short"}</div>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <h1 className="font-serif text-[32px] font-medium leading-10">{data.title}</h1>
              {data.coverImagePath ? (
                <img
                  src={data.coverImagePath}
                  alt=""
                  className="h-[213px] w-[160px] rounded-lg border border-border/50 object-cover"
                />
              ) : null}
            </div>
            <button
              type="button"
              data-testid="short-primary-cta"
              onClick={onPrimary}
              className="btn-primary"
            >
              <Feather size={16} />
              {shortStudyCtaLabel(study.primaryCta, isZh)}
            </button>
            {data.content.trim() ? (
              <ShortPlainTextBar
                storyId={storyId}
                title={data.title}
                content={data.content}
                isZh={isZh}
                from={fanqieFrom}
                to={fanqieTo}
                layout={fanqieLayout}
                blankLine={fanqieBlankLine}
                indent={fanqieIndent}
                onChange={(patch) => {
                  if (patch.from !== undefined) setFanqieFrom(patch.from);
                  if (patch.to !== undefined) setFanqieTo(patch.to);
                  if (patch.layout !== undefined) setFanqieLayout(patch.layout);
                  if (patch.blankLine !== undefined) setFanqieBlankLine(patch.blankLine);
                  if (patch.indent !== undefined) setFanqieIndent(patch.indent);
                }}
              />
            ) : null}
          </header>
          {data.content.trim() ? (
            <article className="prose prose-neutral dark:prose-invert max-w-none text-[16px] leading-8 prose-headings:font-semibold prose-h1:text-[26px] prose-h2:text-[22px] prose-h3:text-[19px] prose-p:my-4">
              <Streamdown plugins={streamdownPlugins} mode="static">
                {data.content}
              </Streamdown>
            </article>
          ) : (
            <LiteraryEmpty
              title={isZh ? "还没有可阅读的正文" : "Nothing on the page yet"}
              subtitle={isZh ? "从问心或织卷接着往下。" : "Continue from Ask or Weave."}
              action={shortStudyCtaLabel(study.primaryCta === "export" ? "write" : study.primaryCta, isZh)}
              onAction={onPrimary}
              testId="short-empty"
            />
          )}
        </>
      )}
    </div>
  );
}

function positiveChapter(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const number = Number(value);
  return number >= 1 ? number : undefined;
}

function ShortPlainTextBar({
  storyId,
  title,
  content,
  isZh,
  from,
  to,
  layout,
  blankLine,
  indent,
  onChange,
}: {
  readonly storyId: string;
  readonly title: string;
  readonly content: string;
  readonly isZh: boolean;
  readonly from: string;
  readonly to: string;
  readonly layout: "combined" | "per-chapter";
  readonly blankLine: boolean;
  readonly indent: boolean;
  readonly onChange: (patch: { from?: string; to?: string; layout?: "combined" | "per-chapter"; blankLine?: boolean; indent?: boolean }) => void;
}) {
  const shape = describeFanqieManuscript(content, title);
  const chapterCount = shape.chapters.length;
  const [rangeSwapped, setRangeSwapped] = useState(false);
  const settled = normalizeRange(from, to, chapterCount);
  const rangeProblem = fanqieRangeProblem(settled.from, settled.to, chapterCount, isZh);
  const queryFor = (bounds: { from: string; to: string }): FanqieExportQuery => {
    const problem = fanqieRangeProblem(bounds.from, bounds.to, chapterCount, isZh);
    if (problem) return { layout, blankLine, indent };
    return {
      ...(positiveChapter(bounds.from) ? { fromChapter: positiveChapter(bounds.from) } : {}),
      ...(positiveChapter(bounds.to) ? { toChapter: positiveChapter(bounds.to) } : {}),
      layout,
      blankLine,
      indent,
    };
  };
  const query = queryFor(settled);
  const commitRange = (patch: { from?: string; to?: string } = {}) => {
    const next = normalizeRange(patch.from ?? from, patch.to ?? to, chapterCount);
    setRangeSwapped(next.swapped);
    onChange({ from: next.from, to: next.to });
    return next;
  };
  const copyPlain = () => {
    const next = commitRange();
    const problem = fanqieRangeProblem(next.from, next.to, chapterCount, isZh);
    if (problem) {
      showToast(problem, "error");
      return;
    }
    const chosen = queryFor(next);
    try {
      const manuscript = renderFanqieManuscript({
        title,
        markdown: content,
        style: { blankLine, indent },
        fromChapter: chosen.fromChapter,
        toChapter: chosen.toChapter,
      });
      void copyToClipboard(manuscript.combined)
        .then(() => showToast(isZh ? "纯文本已复制。标题只留了一行。" : "Plain text copied. The title is one line.", "success"))
        .catch((error) => showToast(error instanceof Error ? error.message : "复制失败", "error"));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "复制失败", "error");
    }
  };
  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-border/60 p-3" data-testid="short-fanqie-export">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" data-testid="short-copy-plain" onClick={copyPlain}>
          <Copy size={14} />
          {shape.numbered && shape.chapters.length > 1 ? (isZh ? "复制所选纯文本" : "Copy selection") : (isZh ? "复制纯文本" : "Copy plain text")}
        </button>
        {rangeProblem ? <p className="text-xs text-destructive" data-testid="fanqie-range-error">{rangeProblem}</p> : null}
        <a
          className={`btn-secondary ${rangeProblem ? "pointer-events-none opacity-40" : ""}`}
          data-testid="short-fanqie-download"
          href={rangeProblem ? undefined : shortManuscriptExportPath(storyId, "txt", query)}
          aria-disabled={rangeProblem ? true : undefined}
          download
          onClick={(event) => {
            const next = commitRange();
            const problem = fanqieRangeProblem(next.from, next.to, chapterCount, isZh);
            if (problem) {
              event.preventDefault();
              showToast(problem, "error");
              return;
            }
            event.currentTarget.href = shortManuscriptExportPath(storyId, "txt", queryFor(next));
          }}
        >
          <Download size={14} />
          {isZh ? "下载 TXT" : "Download TXT"}
        </a>
      </div>
      <FanqieExportFields
        isZh={isZh}
        showRange={shape.numbered && shape.chapters.length > 1}
        from={from}
        to={to}
        layout={layout}
        blankLine={blankLine}
        indent={indent}
        chapterCount={chapterCount}
        swapped={rangeSwapped}
        onCommit={commitRange}
        onChange={(patch) => {
          if (patch.from !== undefined || patch.to !== undefined) setRangeSwapped(false);
          onChange(patch);
        }}
      />
    </div>
  );
}
