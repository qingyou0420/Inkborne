/**
 * Shared manuscript export menu for the write page.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ChevronDown, Download } from "lucide-react";
import { fetchJson } from "../hooks/use-api";
import type { TFunction } from "../hooks/use-i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export type ExportFormat = "txt" | "md" | "epub";

export function ExportMenu({
  bookId,
  t,
  exportFormat,
  exportApprovedOnly,
  exportHref,
  onFormatChange,
  onApprovedOnlyChange,
  onSaved,
  onError,
}: {
  readonly bookId: string;
  readonly t: TFunction;
  readonly exportFormat: ExportFormat;
  readonly exportApprovedOnly: boolean;
  readonly exportHref: string;
  readonly onFormatChange: (format: ExportFormat) => void;
  readonly onApprovedOnlyChange: (value: boolean) => void;
  readonly onSaved: (path: string) => void;
  readonly onError: (message: string) => void;
}) {
  return (
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
              onChange={() => onFormatChange(format)}
            />
            {format.toUpperCase()}
          </label>
        ))}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={exportApprovedOnly} onChange={(event) => onApprovedOnlyChange(event.target.checked)} />
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
                onSaved(exported.path ?? "");
              } catch (error) {
                onError(error instanceof Error ? error.message : "Export failed");
              }
            }}
            className="btn-ghost w-full"
          >
            {t("book.exportSave")}
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
