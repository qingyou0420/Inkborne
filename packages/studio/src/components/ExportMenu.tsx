/**
 * Manuscript export menu. Owns format, approved-only, and TXT layout state.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useRef, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { buildApiUrl, fetchJson } from "../hooks/use-api";
import { useI18n } from "../hooks/use-i18n";
import { normalizeRange } from "../lib/export-range";
import { fanqieRangeProblem } from "../lib/fanqie-range";
import { bookManuscriptExportPath, filenameFromContentDisposition, type FanqieExportQuery } from "../lib/work-export";
import { FanqieExportFields } from "./FanqieExportFields";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export type ExportFormat = "txt" | "md" | "epub";

export function ExportMenu({
  bookId,
  isZh,
  onSaved,
  onError,
  variant = "toolbar",
  label,
  chapterCount = 0,
  currentChapter,
  currentChapterReady = false,
}: {
  readonly bookId: string;
  readonly isZh: boolean;
  readonly onSaved: (path: string) => void;
  readonly onError: (message: string) => void;
  readonly variant?: "toolbar" | "manuscript";
  readonly label?: string;
  /** Highest chapter number in the index. 0 means the total is unknown. */
  readonly chapterCount?: number;
  /** Write page only. Other callers omit this and the single-chapter block stays hidden. */
  readonly currentChapter?: { readonly number: number; readonly title?: string };
  readonly currentChapterReady?: boolean;
}) {
  const { t } = useI18n();
  const [format, setFormat] = useState<ExportFormat>("txt");
  const [approvedOnly, setApprovedOnly] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [layout, setLayout] = useState<"combined" | "per-chapter">("combined");
  const [blankLine, setBlankLine] = useState(true);
  const [indent, setIndent] = useState(false);
  const [rangeSwapped, setRangeSwapped] = useState(false);
  const [downloadingChapter, setDownloadingChapter] = useState(false);
  const chapterDownloadLock = useRef(false);
  const showCurrentChapter = variant === "manuscript" && currentChapter !== undefined;
  const settled = normalizeRange(from, to, chapterCount);
  const rangeProblem = format === "txt" ? fanqieRangeProblem(settled.from, settled.to, chapterCount, isZh) : "";
  const textQuery: FanqieExportQuery | undefined = format === "txt" ? {
    fromChapter: positiveChapter(settled.from),
    toChapter: positiveChapter(settled.to),
    layout,
    blankLine,
    indent,
  } : undefined;
  const href = bookManuscriptExportPath(bookId, format, approvedOnly, textQuery);
  const currentHref = showCurrentChapter && currentChapter
    ? bookManuscriptExportPath(bookId, format, approvedOnly, format === "txt" ? {
      chapter: currentChapter.number,
      blankLine,
      indent,
    } : { chapter: currentChapter.number })
    : "";
  const buttonLabel = label ?? (variant === "manuscript" ? (isZh ? "导出" : "Export") : t("book.exportMenu"));
  const formatLabel: Record<ExportFormat, string> = {
    txt: isZh ? "TXT（纯文本）" : "TXT (plain text)",
    md: "Markdown",
    epub: "EPUB",
  };

  const commitRange = (patch: { from?: string; to?: string }) => {
    const next = normalizeRange(patch.from ?? from, patch.to ?? to, chapterCount);
    setFrom(next.from);
    setTo(next.to);
    setRangeSwapped(next.swapped);
  };

  const save = async () => {
    const next = normalizeRange(from, to, chapterCount);
    setFrom(next.from);
    setTo(next.to);
    setRangeSwapped(next.swapped);
    const problem = format === "txt" ? fanqieRangeProblem(next.from, next.to, chapterCount, isZh) : "";
    if (problem) {
      onError(problem);
      return;
    }
    try {
      const exported = await fetchJson<{ path?: string; chapters?: number }>(`/books/${bookId}/export-save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          approvedOnly,
          ...(format === "txt" ? {
            fromChapter: positiveChapter(next.from),
            toChapter: positiveChapter(next.to),
            layout,
            blankLine,
            indent,
          } : {}),
        }),
      });
      onSaved(exported.path ?? "");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Export failed");
    }
  };

  const saveCurrent = async () => {
    if (!currentChapter || !currentChapterReady) {
      onError(t("book.exportCurrentChapterDisabled"));
      return;
    }
    try {
      const exported = await fetchJson<{ path?: string; chapters?: number }>(`/books/${bookId}/export-save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          approvedOnly,
          chapter: currentChapter.number,
          ...(format === "txt" ? { layout: "combined" as const, blankLine, indent } : {}),
        }),
      });
      onSaved(exported.path ?? "");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Export failed");
    }
  };

  // Fetch first. <a download> would save the JSON error (for example 仅已通过) as a file.
  // A successful download is not a save into the project, so this does not call onSaved.
  const downloadCurrent = async () => {
    const chapter = currentChapter;
    if (!chapter || !currentChapterReady || chapterDownloadLock.current) return;
    const url = buildApiUrl(currentHref);
    if (!url) {
      onError(t("book.exportDownloadFailed"));
      return;
    }
    chapterDownloadLock.current = true;
    setDownloadingChapter(true);
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        onError(await readDownloadError(res, t("book.exportDownloadFailed")));
        return;
      }
      const blob = await res.blob();
      const extension = format === "md" ? "md" : format === "epub" ? "epub" : "txt";
      const fileName = filenameFromContentDisposition(
        res.headers.get("Content-Disposition"),
        `第${chapter.number}章.${extension}`,
      );
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      onError(t("book.exportDownloadFailed"));
    } finally {
      chapterDownloadLock.current = false;
      setDownloadingChapter(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={variant === "manuscript" ? undefined : "btn-secondary inline-flex items-center gap-1.5"}
        data-testid={variant === "manuscript" ? "write-export-button" : undefined}
      >
        <Download size={14} />
        {buttonLabel}
        {variant === "toolbar" ? <ChevronDown size={14} /> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-80 p-3 space-y-3"
        data-testid={variant === "manuscript" ? "write-export-menu" : undefined}
        onKeyDown={(event) => {
          const target = event.target;
          if (
            target instanceof HTMLInputElement
            || target instanceof HTMLTextAreaElement
            || target instanceof HTMLSelectElement
          ) {
            event.stopPropagation();
          }
        }}
      >
        {(["txt", "md", "epub"] as const).map((item) => (
          <label key={item} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="export-format"
              checked={format === item}
              onChange={() => setFormat(item)}
            />
            {formatLabel[item]}
          </label>
        ))}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={approvedOnly}
            onChange={(event) => setApprovedOnly(event.target.checked)}
          />
          {t("book.approvedOnly")}
        </label>
        {format === "txt" ? (
          <FanqieExportFields
            isZh={isZh}
            showRange
            from={from}
            to={to}
            layout={layout}
            blankLine={blankLine}
            indent={indent}
            chapterCount={chapterCount}
            swapped={rangeSwapped}
            onCommit={commitRange}
            onChange={(patch) => {
              if (patch.from !== undefined) {
                setFrom(patch.from);
                setRangeSwapped(false);
              }
              if (patch.to !== undefined) {
                setTo(patch.to);
                setRangeSwapped(false);
              }
              if (patch.layout !== undefined) setLayout(patch.layout);
              if (patch.blankLine !== undefined) setBlankLine(patch.blankLine);
              if (patch.indent !== undefined) setIndent(patch.indent);
            }}
          />
        ) : null}
        {rangeProblem ? <p className="text-xs text-destructive">{rangeProblem}</p> : null}
        <div className="flex flex-col gap-1 pt-1">
          <p className="text-xs text-muted-foreground">{t("book.exportScope")}</p>
          <a
            href={rangeProblem ? undefined : href}
            download
            data-testid="book-export-manuscript"
            className={`btn-secondary text-center ${rangeProblem ? "pointer-events-none opacity-40" : ""}`}
            aria-disabled={rangeProblem ? true : undefined}
            onClick={(event) => {
              const next = normalizeRange(from, to, chapterCount);
              setFrom(next.from);
              setTo(next.to);
              setRangeSwapped(next.swapped);
              const problem = format === "txt" ? fanqieRangeProblem(next.from, next.to, chapterCount, isZh) : "";
              if (problem) {
                event.preventDefault();
                onError(problem);
                return;
              }
              event.currentTarget.href = bookManuscriptExportPath(bookId, format, approvedOnly, format === "txt" ? {
                fromChapter: positiveChapter(next.from),
                toChapter: positiveChapter(next.to),
                layout,
                blankLine,
                indent,
              } : undefined);
            }}
          >
            {t("book.download")}
          </a>
          <button type="button" onClick={() => void save()} className="btn-ghost w-full">
            {t("book.exportSave")}
          </button>
        </div>
        {showCurrentChapter ? (
          <div className="flex flex-col gap-1 border-t border-border/60 pt-2" data-testid="export-current-chapter">
            <p className="text-sm">{t("book.exportCurrentChapter")}</p>
            <button
              type="button"
              className="btn-secondary text-center"
              disabled={!currentChapterReady || downloadingChapter}
              data-testid="export-current-chapter-download"
              onClick={() => { void downloadCurrent(); }}
            >
              {t("book.download")}
            </button>
            <button
              type="button"
              className="btn-ghost w-full"
              disabled={!currentChapterReady}
              data-testid="export-current-chapter-save"
              onClick={() => void saveCurrent()}
            >
              {t("book.exportSave")}
            </button>
            {currentChapterReady ? null : (
              <p className="text-xs leading-5 text-muted-foreground" data-testid="export-current-chapter-hint">
                {t("book.exportCurrentChapterDisabled")}
              </p>
            )}
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

async function readDownloadError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = await res.json() as { error?: unknown };
    if (payload && typeof payload.error === "string" && payload.error.trim()) return payload.error.trim();
  } catch {
    // Body was not JSON. The caller shows the generic line.
  }
  return fallback;
}

function positiveChapter(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return undefined;
  return Number(trimmed);
}
