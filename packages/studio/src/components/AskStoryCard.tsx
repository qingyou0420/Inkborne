/**
 * 问心故事卡 — live on create, read-only after the book exists.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { storyCardReady, STORY_CARD_SYNOPSIS_MAX, type StoryCardDraft } from "../lib/story-card";

export function AskStoryCard({
  card,
  editable,
  isZh,
  derivedFromCanon,
  confirmEnabled,
  confirmPending,
  onChange,
  onConfirm,
  onReopen,
  onEditTitle,
  hideConfirm,
}: {
  readonly card: StoryCardDraft;
  readonly editable: boolean;
  readonly isZh: boolean;
  readonly derivedFromCanon?: boolean;
  readonly confirmEnabled?: boolean;
  readonly confirmPending?: boolean;
  readonly onChange?: (patch: Partial<StoryCardDraft>) => void;
  readonly onConfirm?: () => void;
  readonly onReopen?: () => void;
  readonly onEditTitle?: () => void;
  readonly hideConfirm?: boolean;
}) {
  const ready = storyCardReady(card);

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col rounded-xl border border-border/60 bg-card p-5"
      data-testid="ask-story-card"
    >
      <div className="literary-kicker">{isZh ? "故事卡" : "Story card"}</div>
      {derivedFromCanon && (
        <p className="mt-1 text-[12px] text-muted-foreground">
          {isZh ? "由正典推得 · 可编辑书名" : "Derived from canon · title editable"}
        </p>
      )}
      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
        <Field
          label={isZh ? "暂定书名" : "Working title"}
          value={card.workingTitle}
          editable={editable}
          onChange={(value) => onChange?.({ workingTitle: value })}
          testId="story-card-title"
        />
        <Field
          label={isZh ? "一句话故事" : "One-liner"}
          value={card.oneLine}
          editable={editable}
          onChange={(value) => onChange?.({ oneLine: value })}
          testId="story-card-one-line"
        />
        <Field
          label={isZh ? "初步梗概" : "Synopsis"}
          value={card.synopsis}
          editable={editable}
          multiline
          maxLength={STORY_CARD_SYNOPSIS_MAX}
          onChange={(value) => onChange?.({ synopsis: value })}
          testId="story-card-synopsis"
        />
        {(card.genre || card.tone) && (
          <p className="text-[13px] text-muted-foreground">
            {[card.genre, card.tone].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>
      {editable && !hideConfirm ? (
        <button
          type="button"
          data-testid="create-book-from-card"
          disabled={!ready || !confirmEnabled || confirmPending}
          onClick={onConfirm}
          className="btn-primary mt-5"
        >
          {confirmPending ? (isZh ? "整理正典中…" : "Preparing canon…") : (isZh ? "建书并整理正典" : "Create and prepare canon")}
        </button>
      ) : !editable ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {onEditTitle && (
            <button
              type="button"
              data-testid="story-card-edit-title"
              onClick={onEditTitle}
              className="rounded-xl bg-secondary px-4 py-2.5 text-sm font-medium"
            >
              {isZh ? "编辑书名" : "Edit title"}
            </button>
          )}
          {onReopen && (
            <button
              type="button"
              data-testid="reopen-ask"
              onClick={onReopen}
              className="rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground"
            >
              {isZh ? "重开问心" : "Reopen Ask"}
            </button>
          )}
        </div>
      ) : null}
    </aside>
  );
}

function Field({
  label,
  value,
  editable,
  multiline,
  maxLength,
  onChange,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly editable: boolean;
  readonly multiline?: boolean;
  readonly maxLength?: number;
  readonly onChange?: (value: string) => void;
  readonly testId: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {editable ? (
        multiline ? (
          <textarea
            data-testid={testId}
            value={value}
            maxLength={maxLength}
            rows={5}
            onChange={(event) => onChange?.(event.target.value)}
            className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-primary/50"
          />
        ) : (
          <input
            data-testid={testId}
            value={value}
            onChange={(event) => onChange?.(event.target.value)}
            className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-primary/50"
          />
        )
      ) : (
        <div data-testid={testId} className="whitespace-pre-wrap text-[15px] leading-7">
          {value || "—"}
        </div>
      )}
    </label>
  );
}
