/**
 * Manuscript export menu. Owns format, approved-only, and TXT layout state.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { fetchJson } from "../hooks/use-api";
import { useI18n } from "../hooks/use-i18n";
import { fanqieRangeProblem } from "../lib/fanqie-range";
import { bookManuscriptExportPath, type FanqieExportQuery } from "../lib/work-export";
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
}: {
  readonly bookId: string;
  readonly isZh: boolean;
  readonly onSaved: (path: string) => void;
  readonly onError: (message: string) => void;
  readonly variant?: "toolbar" | "manuscript";
  readonly label?: string;
}) {
  const { t } = useI18n();
  const [format, setFormat] = useState<ExportFormat>("txt");
  const [approvedOnly, setApprovedOnly] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [layout, setLayout] = useState<"combined" | "per-chapter">("combined");
  const [blankLine, setBlankLine] = useState(true);
  const [indent, setIndent] = useState(false);
  const rangeProblem = format === "txt" ? fanqieRangeProblem(from, to, 0, isZh) : "";
  const textQuery: FanqieExportQuery | undefined = format === "txt" ? {
    fromChapter: positiveChapter(from),
    toChapter: positiveChapter(to),
    layout,
    blankLine,
    indent,
  } : undefined;
  const href = bookManuscriptExportPath(bookId, format, approvedOnly, textQuery);
  const buttonLabel = label ?? (variant === "manuscript" ? (isZh ? "导出" : "Export") : t("book.exportMenu"));
  const formatLabel: Record<ExportFormat, string> = {
    txt: isZh ? "TXT（纯文本）" : "TXT (plain text)",
    md: "Markdown",
    epub: "EPUB",
  };

  const save = async () => {
    if (rangeProblem) {
      onError(rangeProblem);
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
            fromChapter: textQuery?.fromChapter,
            toChapter: textQuery?.toChapter,
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
            onChange={(patch) => {
              if (patch.from !== undefined) setFrom(patch.from);
              if (patch.to !== undefined) setTo(patch.to);
              if (patch.layout !== undefined) setLayout(patch.layout);
              if (patch.blankLine !== undefined) setBlankLine(patch.blankLine);
              if (patch.indent !== undefined) setIndent(patch.indent);
            }}
          />
        ) : null}
        {rangeProblem ? <p className="text-xs text-destructive">{rangeProblem}</p> : null}
        <div className="flex flex-col gap-1 pt-1">
          <a
            href={rangeProblem ? undefined : href}
            download
            data-testid="book-export-manuscript"
            className={`btn-secondary text-center ${rangeProblem ? "pointer-events-none opacity-40" : ""}`}
            aria-disabled={rangeProblem ? true : undefined}
            onClick={(event) => {
              if (rangeProblem) event.preventDefault();
            }}
          >
            {t("book.download")}
          </a>
          <button type="button" onClick={() => void save()} className="btn-ghost w-full">
            {t("book.exportSave")}
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function positiveChapter(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return undefined;
  return Number(trimmed);
}
