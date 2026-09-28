/**
 * Client-side entry for 番茄纯文本. Imports the core module directly so the
 * browser bundle does not pull the InkOS barrel.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export {
  describeFanqieManuscript,
  renderFanqieChapter,
  renderFanqieManuscript,
} from "../../../core/src/interaction/fanqie-text";

export async function copyToClipboard(text: string): Promise<void> {
  const value = text.trim();
  if (!value) throw new Error("没有可复制的正文。");
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the textarea path. Electron sometimes blocks the async clipboard.
    }
  }
  if (typeof document === "undefined") throw new Error("复制失败，请再试一次。");
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("复制失败，请再试一次。");
}
