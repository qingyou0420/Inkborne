/**
 * Old pipeline stage ids stay as the match key. Only the words on screen change.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const DISPLAY: Record<string, string> = {
  "生成最终真相文件": "生成最终设定档案",
  "校验真相文件变更": "校验设定档案变更",
  "Generate final truth files": "Generate final canon files",
  "Validate truth file changes": "Validate canon file changes",
};

export function displayProgressLabel(label: string): string {
  return DISPLAY[label] ?? label;
}
