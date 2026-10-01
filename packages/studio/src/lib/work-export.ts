export type ManuscriptExportFormat = "txt" | "md";

export interface FanqieExportQuery {
  readonly fromChapter?: number;
  readonly toChapter?: number;
  /** Export this one chapter. Omits from/to and per-chapter layout. */
  readonly chapter?: number;
  readonly layout?: "combined" | "per-chapter";
  readonly blankLine?: boolean;
  readonly indent?: boolean;
}

export function bookManuscriptExportPath(
  bookId: string,
  format: ManuscriptExportFormat | "epub" = "txt",
  approvedOnly = false,
  fanqie?: FanqieExportQuery,
): string {
  const params = new URLSearchParams({ format });
  if (approvedOnly) params.set("approvedOnly", "true");
  const chapter = fanqie?.chapter;
  if (chapter !== undefined && Number.isInteger(chapter) && chapter >= 1) {
    params.set("chapter", String(chapter));
    if (format === "txt") {
      if (fanqie?.blankLine === false) params.set("blankLine", "0");
      if (fanqie?.indent) params.set("indent", "1");
    }
    return `/api/v1/books/${encodeURIComponent(bookId)}/export?${params.toString()}`;
  }
  appendFanqieQuery(params, format === "txt" ? fanqie : undefined);
  return `/api/v1/books/${encodeURIComponent(bookId)}/export?${params.toString()}`;
}

export function shortManuscriptExportPath(
  shortId: string,
  format: ManuscriptExportFormat = "txt",
  fanqie?: FanqieExportQuery,
): string {
  const params = new URLSearchParams({ format });
  appendFanqieQuery(params, format === "txt" ? fanqie : undefined);
  return `/api/v1/shorts/${encodeURIComponent(shortId)}/export?${params.toString()}`;
}

function appendFanqieQuery(params: URLSearchParams, fanqie: FanqieExportQuery | undefined): void {
  if (!fanqie) return;
  if (fanqie.fromChapter) params.set("from", String(fanqie.fromChapter));
  if (fanqie.toChapter) params.set("to", String(fanqie.toChapter));
  if (fanqie.layout === "per-chapter") params.set("layout", "per-chapter");
  if (fanqie.blankLine === false) params.set("blankLine", "0");
  if (fanqie.indent) params.set("indent", "1");
}

export function manuscriptToPlainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function continueShortPrompt(title: string, storyId: string): { zh: string; en: string } {
  return {
    zh: `继续这篇短篇「${title}」（storyId: ${storyId}）。从当前进度接着写完。`,
    en: `Continue the short story "${title}" (storyId: ${storyId}) from its current progress.`,
  };
}
