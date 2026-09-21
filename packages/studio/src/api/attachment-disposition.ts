/**
 * Build a Content-Disposition value that stays inside the HTTP ByteString
 * (latin-1) header alphabet. Undici / fetch throw TypeError when a raw
 * non-ASCII filename is interpolated into `filename="…"`.
 *
 * ASCII fallback + RFC 5987 `filename*` so Chinese book titles download
 * with the real name in browsers that honor RFC 5987.
 */
export function attachmentDisposition(fileName: string): string {
  const safeAscii = fileName.replace(/[^A-Za-z0-9._-]+/g, "_") || "download";
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
