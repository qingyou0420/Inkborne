/** Preserve full confirmation requirements; the story card is only a preview.
 * SPDX-License-Identifier: AGPL-3.0-only */
import type { ChatActionPayload } from "../store/chat/types";
import { createBookInstruction, type StoryCardDraft } from "./story-card";

export interface AskCreateProposal {
  readonly instruction?: string;
  readonly actionPayload?: ChatActionPayload;
  readonly requestedSkills?: ReadonlyArray<string>;
}

export function buildAskCreateRequest(input: {
  readonly card: StoryCardDraft;
  readonly isZh: boolean;
  readonly proposal?: AskCreateProposal | null;
  readonly edits?: Partial<StoryCardDraft>;
}): { instruction: string; actionPayload: ChatActionPayload; requestedSkills?: ReadonlyArray<string> } {
  const original = input.proposal?.actionPayload?.createBook;
  const field = (key: keyof StoryCardDraft, originalValue?: string): string | undefined => {
    const edited = input.edits?.[key];
    return (edited !== undefined ? edited : originalValue ?? input.card[key])?.trim();
  };
  const confirmed: StoryCardDraft = {
    workingTitle: field("workingTitle", original?.title) ?? "",
    oneLine: field("oneLine", original?.oneLine) ?? "",
    synopsis: field("synopsis", original?.synopsis) ?? "",
    genre: field("genre", original?.genre),
    tone: field("tone", original?.tone),
  };
  const createBook = {
    ...original,
    title: confirmed.workingTitle,
    oneLine: confirmed.oneLine,
    synopsis: confirmed.synopsis,
    genre: confirmed.genre || undefined,
    tone: confirmed.tone || undefined,
    language: original?.language ?? (input.isZh ? "zh" as const : "en" as const),
  };
  const originalInstruction = input.proposal?.instruction;
  return {
    instruction: [
      originalInstruction ? (input.isZh ? "【原提案完整要求】" : "[Complete original proposal]") : "",
      originalInstruction,
      input.isZh
        ? "【本次确认】下列明确修改的字段优先于原提案；未修改的故事约定全部保留，不得由卡片摘要替换问心原文。"
        : "[Current confirmation] Explicit edits below override the original proposal. Preserve all other story requirements; the card summary does not replace the Ask conversation.",
      createBookInstruction(confirmed, input.isZh),
    ].filter(Boolean).join("\n\n"),
    actionPayload: { ...input.proposal?.actionPayload, createBook },
    ...(input.proposal?.requestedSkills ? { requestedSkills: [...input.proposal.requestedSkills] } : {}),
  };
}
