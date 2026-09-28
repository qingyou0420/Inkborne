/**
 * 落笔系统提示词：角色要求 + 本书文风 + 网文写法 + 禁语。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { loadDefaultCraftPatterns } from "../craft/load-craft-rules.js";

const WEB_NOVEL_CRAFT = [
  "网文通用写法：",
  "- 用这一章人物的眼睛看，少做作者旁白，不要对读者解释剧情。",
  "- 段落短，适合手机一屏一屏往下读。",
  "- 设定和规矩从动作、对话里带出来，不要整段说明书。",
  "- 章末留一个钩子：没说完的事、刚听见的声音，或一个还没落地的决定。",
  "- 对白要像这个人会说的话。",
].join("\n");

function banLine(): string {
  const words: string[] = [];
  const seen = new Set<string>();
  for (const pattern of loadDefaultCraftPatterns()) {
    if (pattern.language === "en") continue;
    const samples = [
      ...(pattern.words ?? []),
      ...(pattern.contains ? [pattern.contains] : []),
    ];
    for (const word of samples) {
      const trimmed = word.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      words.push(trimmed);
      if (words.length >= 16) break;
    }
    if (words.length >= 16) break;
  }
  if (words.length === 0) return "禁语：不要写出作者说教、全场震惊、分析报告腔。出现了就算没写好。";
  return `禁语：不要写出这些词或腔调：${words.join("、")}。出现了就算没写好。`;
}

function hasSectionHeading(text: string, heading: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed === heading || trimmed.startsWith(`${heading}：`) || trimmed.startsWith(`${heading}:`);
  });
}

/** Four blocks the writing role always sees, even when the author added their own instructions. */
export function composeWriteSystemPrompt(instructions: string, voice?: string): string {
  const role = instructions.trim();
  const parts = [role];
  if (!hasSectionHeading(role, "本书文风")) {
    const style = voice?.trim();
    parts.push(style
      ? `本书文风：${style}`
      : "本书文风：按已采用正典里的视角和文风写。正典没写文风时，保持这一章已经有的口气。");
  }
  if (!hasSectionHeading(role, "网文通用写法")) parts.push(WEB_NOVEL_CRAFT);
  if (!hasSectionHeading(role, "禁语")) parts.push(banLine());
  return parts.filter(Boolean).join("\n\n");
}
