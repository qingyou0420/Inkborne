/**
 * Browser-safe book cover types, limits, and display URL.
 * Image bytes live under the book directory; Studio serves them at
 * GET /api/v1/books/:id/cover (not /project/files/books/...).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const BOOK_COVER_MAX_BYTES = 6 * 1024 * 1024;
export const BOOK_COVER_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
export const BOOK_COVER_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

const COVER_RELATIVE_RE = /^(?:assets\/)?cover\.(png|jpe?g|webp|gif)$/i;

export function filenameExtension(filename: string): string {
  const name = filename.split(/[/\\]/u).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function bookCoverExtensionFor(mime: string, filename = ""): string | null {
  const ext = filenameExtension(filename);
  if (mime === "image/png" || ext === ".png") return "png";
  if (mime === "image/webp" || ext === ".webp") return "webp";
  if (mime === "image/gif" || ext === ".gif") return "gif";
  if (mime === "image/jpeg" || ext === ".jpg" || ext === ".jpeg") return "jpg";
  return null;
}

export function bookCoverContentType(ext: string): string {
  const normalized = ext.replace(/^\./u, "").toLowerCase();
  if (normalized === "png") return "image/png";
  if (normalized === "webp") return "image/webp";
  if (normalized === "gif") return "image/gif";
  return "image/jpeg";
}

export function isSafeBookCoverRelative(rel: string): boolean {
  const trimmed = rel.trim();
  return Boolean(trimmed)
    && !trimmed.includes("\0")
    && !trimmed.includes("\\")
    && !trimmed.split("/").includes("..")
    && COVER_RELATIVE_RE.test(trimmed);
}

export function bookCoverApiPath(bookId: string, updatedAt?: string): string {
  const encoded = encodeURIComponent(bookId);
  const stamp = updatedAt?.trim();
  return stamp
    ? `/api/v1/books/${encoded}/cover?v=${encodeURIComponent(stamp)}`
    : `/api/v1/books/${encoded}/cover`;
}

export function studioBookCoverSrc(
  bookId: string,
  coverImagePath: string | undefined,
  updatedAt?: string,
): string | undefined {
  if (!coverImagePath?.trim()) return undefined;
  return bookCoverApiPath(bookId, updatedAt);
}

export function withStudioCoverSrc<T extends {
  readonly id: string;
  readonly coverImagePath?: string;
  readonly updatedAt?: string;
}>(book: T): T {
  return {
    ...book,
    coverImagePath: studioBookCoverSrc(book.id, book.coverImagePath, book.updatedAt),
  };
}

export function validateBookCoverFile(
  file: { readonly type: string; readonly size: number; readonly name?: string },
  isZh: boolean,
): string | null {
  const ext = bookCoverExtensionFor(file.type, file.name ?? "");
  if (!ext) {
    return isZh
      ? "封面只支持 png / jpg / jpeg / webp / gif"
      : "Cover must be png, jpg, jpeg, webp, or gif";
  }
  if (file.size > BOOK_COVER_MAX_BYTES) {
    return isZh ? "封面不能超过 6 MB" : "Cover must be 6 MB or smaller";
  }
  return null;
}
