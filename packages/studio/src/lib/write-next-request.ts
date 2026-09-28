/**
 * Free-text "write the next chapter" belongs in 落笔, not the old pipeline.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const WRITE_NEXT = new Set([
  "写下一章",
  "写下章",
  "写一章",
  "再写一章",
  "继续写下一章",
  "续写下一章",
  "请写下一章",
  "帮我写下一章",
  "往下写一章",
  "写下一章吧",
]);

export function isWriteNextRequest(text: string): boolean {
  const compact = text.trim().replace(/[\s。！？!?,，]/g, "");
  return WRITE_NEXT.has(compact);
}
