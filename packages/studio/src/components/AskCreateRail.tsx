/**
 * Right rail on #/book/new: live story card + confirm dialog → create_book.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useMemo, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { AskStoryCard } from "./AskStoryCard";
import {
  extractStoryCardDraft,
  storyCardReady,
  type StoryCardDraft,
} from "../lib/story-card";
import { buildAskCreateRequest } from "../lib/ask-create-request";
import { showToast } from "../lib/toast";
import { chatSelectors, useChatStore } from "../store/chat";
import { getProposedActionDetails, type ProposedActionDetails } from "./chat/ToolExecutionSteps";

export function AskCreateRail({ isZh }: { readonly isZh: boolean }) {
  const sessionId = useChatStore((state) => state.activeSessionId);
  return <AskCreateSessionRail key={sessionId ?? "pending"} isZh={isZh} />;
}

function AskCreateSessionRail({ isZh }: { readonly isZh: boolean }) {
  const messages = useChatStore(chatSelectors.activeMessages);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const createSession = useChatStore((state) => state.createSession);
  const [local, setLocal] = useState<Partial<StoryCardDraft>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmCard, setConfirmCard] = useState<StoryCardDraft | null>(null);
  const [confirmProposal, setConfirmProposal] = useState<ProposedActionDetails | null>(null);
  const [confirmEdits, setConfirmEdits] = useState<Partial<StoryCardDraft>>({});
  const [pending, setPending] = useState(false);

  const proposed = useMemo(() => {
    const execs = messages.flatMap((message) => message.toolExecutions ?? []);
    for (let i = execs.length - 1; i >= 0; i -= 1) {
      if (execs[i]!.status !== "completed") continue;
      const details = getProposedActionDetails(execs[i]!);
      if (details?.action === "create_book") {
        return details;
      }
    }
    return null;
  }, [messages]);

  const card = extractStoryCardDraft({
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    proposed: proposed ? { ...proposed.actionPayload?.createBook, title: proposed.actionPayload?.createBook?.title ?? proposed.title } : null,
    local,
  });

  const openConfirm = () => {
    if (!storyCardReady(card)) return;
    setConfirmCard(card);
    setConfirmProposal(proposed);
    setConfirmEdits({ ...local });
    setConfirmOpen(true);
  };

  const editConfirmation = (key: keyof StoryCardDraft, value: string) => {
    setConfirmCard((prev) => prev ? { ...prev, [key]: value } : prev);
    setConfirmEdits((prev) => ({ ...prev, [key]: value }));
  };

  const confirmCreate = async () => {
    const next = confirmCard;
    if (!next || !storyCardReady(next)) return;
    setPending(true);
    try {
      let sessionId = activeSessionId;
      if (!sessionId) {
        sessionId = await createSession(null, "book-create");
      }
      const request = buildAskCreateRequest({ card: next, isZh, proposal: confirmProposal, edits: confirmEdits });
      await sendMessage(sessionId, request.instruction, {
        sessionKind: "book-create",
        actionSource: "button",
        requestedIntent: "create_book",
        actionPayload: request.actionPayload,
        requestedSkills: request.requestedSkills,
      });
      setConfirmOpen(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : (isZh ? "建书失败" : "Create failed"), "error");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex h-full w-[min(22rem,38%)] shrink-0 flex-col border-l border-border/40 bg-background/40 p-4">
      <AskStoryCard
        card={card}
        editable
        isZh={isZh}
        confirmEnabled
        confirmPending={pending}
        onChange={(patch) => setLocal((prev) => ({ ...prev, ...patch }))}
        onConfirm={openConfirm}
      />
      <ConfirmDialog
        open={confirmOpen}
        title={isZh ? "建书并整理正典" : "Create book and prepare canon"}
        message={isZh ? "保留完整问心约定，按本次修改建书并整理候选正典，待你核对采用。" : "Preserve the full Ask requirements, apply these edits, and prepare a canon candidate for your review and adoption."}
        confirmLabel={pending ? (isZh ? "整理正典中…" : "Preparing canon…") : (isZh ? "建书并整理正典" : "Create and prepare canon")}
        cancelLabel={isZh ? "再改改" : "Edit more"}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void confirmCreate()}
      >
        {confirmCard && (
          <div className="mt-4 space-y-3">
            <ConfirmField
              label={isZh ? "暂定书名" : "Title"}
              value={confirmCard.workingTitle}
              onChange={(value) => editConfirmation("workingTitle", value)}
              testId="confirm-card-title"
            />
            <ConfirmField
              label={isZh ? "一句话故事" : "One-liner"}
              value={confirmCard.oneLine}
              onChange={(value) => editConfirmation("oneLine", value)}
              testId="confirm-card-one-line"
            />
            <ConfirmField
              label={isZh ? "初步梗概" : "Synopsis"}
              value={confirmCard.synopsis}
              multiline
              onChange={(value) => editConfirmation("synopsis", value)}
              testId="confirm-card-synopsis"
            />
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

function ConfirmField({
  label,
  value,
  multiline,
  onChange,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly multiline?: boolean;
  readonly onChange: (value: string) => void;
  readonly testId: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {multiline ? (
        <textarea
          data-testid={testId}
          value={value}
          rows={4}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
        />
      ) : (
        <input
          data-testid={testId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
        />
      )}
    </label>
  );
}
