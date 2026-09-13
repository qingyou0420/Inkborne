/**
 * Right rail on #/book/new: live story card + confirm dialog → create_book.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useMemo, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { AskStoryCard } from "./AskStoryCard";
import {
  createBookInstruction,
  extractStoryCardDraft,
  mergeStoryCard,
  storyCardReady,
  type StoryCardDraft,
} from "../lib/story-card";
import { showToast } from "../lib/toast";
import { chatSelectors, useChatStore } from "../store/chat";
import { getProposedActionDetails } from "./chat/ToolExecutionSteps";

export function AskCreateRail({ isZh }: { readonly isZh: boolean }) {
  const messages = useChatStore(chatSelectors.activeMessages);
  const activeSession = useChatStore(chatSelectors.activeSession);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const createSession = useChatStore((state) => state.createSession);
  const [local, setLocal] = useState<Partial<StoryCardDraft>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmCard, setConfirmCard] = useState<StoryCardDraft | null>(null);
  const [pending, setPending] = useState(false);

  const proposed = useMemo(() => {
    const execs = messages.flatMap((message) => message.toolExecutions ?? []);
    for (let i = execs.length - 1; i >= 0; i -= 1) {
      const details = getProposedActionDetails(execs[i]!);
      if (details?.action === "create_book") {
        const payload = details.actionPayload?.createBook;
        return {
          title: payload?.title ?? details.title,
          genre: payload?.genre,
          oneLine: payload?.oneLine,
          synopsis: payload?.synopsis,
          tone: payload?.tone,
        };
      }
    }
    return null;
  }, [messages]);

  const card = extractStoryCardDraft({
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    proposed,
    local,
  });

  const openConfirm = () => {
    if (!storyCardReady(card)) return;
    setConfirmCard(card);
    setConfirmOpen(true);
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
      await sendMessage(sessionId, createBookInstruction(next, isZh), {
        sessionKind: "book-create",
        actionSource: "button",
        requestedIntent: "create_book",
        actionPayload: {
          createBook: {
            title: next.workingTitle,
            ...(next.genre ? { genre: next.genre } : {}),
            language: isZh ? "zh" : "en",
            oneLine: next.oneLine,
            synopsis: next.synopsis,
            ...(next.tone ? { tone: next.tone } : {}),
          },
        },
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
        onChange={(patch) => setLocal((prev) => mergeStoryCard({ ...card, ...prev }, patch))}
        onConfirm={openConfirm}
      />
      <ConfirmDialog
        open={confirmOpen}
        title={isZh ? "就此建书" : "Create this book"}
        message={isZh ? "确认后会按这三项建书，并写入故事卡。" : "Confirm to create the book from these three fields."}
        confirmLabel={pending ? (isZh ? "建书中…" : "Creating…") : (isZh ? "确认建书" : "Confirm")}
        cancelLabel={isZh ? "再改改" : "Edit more"}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void confirmCreate()}
      >
        {confirmCard && (
          <div className="mt-4 space-y-3">
            <ConfirmField
              label={isZh ? "暂定书名" : "Title"}
              value={confirmCard.workingTitle}
              onChange={(value) => setConfirmCard((prev) => prev ? { ...prev, workingTitle: value } : prev)}
              testId="confirm-card-title"
            />
            <ConfirmField
              label={isZh ? "一句话故事" : "One-liner"}
              value={confirmCard.oneLine}
              onChange={(value) => setConfirmCard((prev) => prev ? { ...prev, oneLine: value } : prev)}
              testId="confirm-card-one-line"
            />
            <ConfirmField
              label={isZh ? "初步梗概" : "Synopsis"}
              value={confirmCard.synopsis}
              multiline
              onChange={(value) => setConfirmCard((prev) => prev ? { ...prev, synopsis: value } : prev)}
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
