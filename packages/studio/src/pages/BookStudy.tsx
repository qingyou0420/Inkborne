/**
 * 本书: attention list, volume arrive, four-step overview.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { fetchJson, useApi } from "../hooks/use-api";
import type { AuthoringWorkspace } from "../lib/authoring-workspace";
import { workspaceQuery } from "../lib/authoring-workspace";
import { useEffect, useMemo, useState } from "react";
import type { BookWorkspaceNavTarget } from "../components/BookWorkspaceNav";
import { stageStateLabel } from "../components/StageDot";
import type { WritePreflightEvaluation } from "../components/SerialCockpitStrip";
import { TruthProposalCard, type PendingTruthProposal } from "../components/TruthProposalCard";
import { assembleCockpitSnapshot, type CockpitDueHook, type CockpitReviewItem } from "../lib/serial-cockpit";
import { deriveBookActivity, shouldRefetchBookView } from "../hooks/use-book-activity";
import { useBookStage } from "../hooks/use-book-stage";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import type { BookStepState } from "../lib/book-stage";
import {
  formatVolumeArriveCopy,
  stripEngineTokens,
} from "../lib/copy-map";
import { formatStartedOn, fourStepCopy } from "../lib/stage-copy";
import { filledChapterNumbers, lockedNamedVolumeCount, resolveOutlineWeaveStep } from "../lib/volume-map-tree";

function formatStudyWords(total: number, isZh: boolean): string {
  if (!isZh) return `${total.toLocaleString()} words`;
  if (total >= 10000) {
    const wan = total / 10000;
    const label = Number.isInteger(wan) ? String(wan) : wan.toFixed(1).replace(/\.0$/, "");
    return `${label} 万字`;
  }
  return `${total.toLocaleString()} 字`;
}

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
}

interface BookData {
  readonly book: {
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly status: string;
    readonly language?: string;
    readonly createdAt?: string;
    readonly targetChapters?: number;
  };
  readonly chapters: ReadonlyArray<ChapterMeta>;
  readonly nextChapter: number;
}

interface Nav extends BookWorkspaceNavTarget {
  toDashboard: () => void;
  toChapter: (bookId: string, num: number) => void;
  toTruth: (bookId: string) => void;
}

function statusLabel(status: string, isZh: boolean): string {
  const map: Record<string, [string, string]> = {
    "ready-for-review": ["待审稿", "ready for review"],
    approved: ["已通过", "approved"],
    "audit-failed": ["须处理", "must fix"],
    drafted: ["草稿", "drafted"],
    "needs-revision": ["需修订", "needs revision"],
    imported: ["已导入", "imported"],
    "state-degraded": ["状态待修", "state needs repair"],
  };
  const pair = map[status];
  return pair ? (isZh ? pair[0] : pair[1]) : status;
}

function goStage(
  nav: Nav,
  bookId: string,
  target: "ask" | "ground" | "weave" | "write",
): void {
  if (target === "ask") nav.toAsk(bookId);
  else if (target === "ground") (nav.toGround ?? nav.toTruth ?? nav.toBook)(bookId);
  else if (target === "weave") (nav.toWeave ?? nav.toOutline)(bookId);
  else (nav.toWrite ?? nav.toBookSettings)(bookId);
}

export function BookStudy({
  bookId,
  nav,
  theme: _theme,
  t,
  sse,
}: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse: { messages: ReadonlyArray<SSEMessage> };
}) {
  const { data, loading, error, refetch } = useApi<BookData>(`/books/${bookId}`);
  const { data: authoring } = useApi<AuthoringWorkspace>(`/authoring/workspace?${workspaceQuery(bookId)}`);
  const [preflight, setPreflight] = useState<WritePreflightEvaluation | null>(null);
  const [hooks, setHooks] = useState<ReadonlyArray<CockpitDueHook>>([]);
  const [reviewQueue, setReviewQueue] = useState<ReadonlyArray<CockpitReviewItem>>([]);
  const [proposals, setProposals] = useState<ReadonlyArray<PendingTruthProposal>>([]);
  const [volumeMap, setVolumeMap] = useState("");
  const stage = useBookStage(bookId);
  const [volumeExpanded, setVolumeExpanded] = useState(false);
  const [canonOpen, setCanonOpen] = useState(false);
  const [roleCount, setRoleCount] = useState(0);

  const activity = useMemo(() => deriveBookActivity(sse.messages, bookId), [bookId, sse.messages]);
  const isZh = data?.book.language !== "en";

  const refreshAux = () => {
    void fetchJson<WritePreflightEvaluation>(`/books/${bookId}/write-preflight`)
      .then(setPreflight)
      .catch(() => setPreflight(null));
    void fetchJson<{ hooks?: CockpitDueHook[] }>(`/books/${bookId}/hooks/due`)
      .then((body) => setHooks(body.hooks ?? []))
      .catch(() => setHooks([]));
    void fetchJson<{ items?: CockpitReviewItem[] }>(`/books/${bookId}/review-queue`)
      .then((body) => setReviewQueue(body.items ?? []))
      .catch(() => setReviewQueue([]));
    void fetchJson<{ proposals?: PendingTruthProposal[] }>(`/books/${bookId}/truth-proposals`)
      .then((body) => setProposals(body.proposals ?? []))
      .catch(() => setProposals([]));
    void fetchJson<{ content?: string | null }>(`/books/${bookId}/truth/outline/volume_map.md`)
      .then((body) => setVolumeMap(body.content ?? ""))
      .catch(() => setVolumeMap(""));
    void fetchJson<{ files?: ReadonlyArray<{ name: string }> }>(`/books/${bookId}/truth`)
      .then((body) => {
        const files = body.files ?? [];
        setRoleCount(files.filter((file) => file.name.startsWith("roles/")).length);
      })
      .catch(() => setRoleCount(0));
  };

  useEffect(() => {
    refreshAux();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, data?.nextChapter]);

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;
    if (shouldRefetchBookView(recent, bookId)) {
      refetch();
      refreshAux();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, refetch, sse.messages]);

  const snapshot = useMemo(() => {
    if (!data || !preflight) return null;
    return assembleCockpitSnapshot({
      chapters: data.chapters,
      nextChapter: data.nextChapter,
      volumeMap,
      preflight,
      dueHooks: hooks,
      reviewQueue,
      pendingProposals: proposals,
      isZh,
    });
  }, [data, preflight, volumeMap, hooks, reviewQueue, proposals, isZh]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 space-y-4">
        <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
      </div>
    );
  }
  if (error) return <div className="text-destructive p-8">Error: {error}</div>;
  if (!data) return null;

  const book = data.book;
  const totalWords = data.chapters.reduce((sum, chapter) => sum + (chapter.wordCount ?? 0), 0);
  const target = book.targetChapters && book.targetChapters > 0 ? book.targetChapters : 0;
  const volumeCopy = snapshot?.volume?.okr
    ? formatVolumeArriveCopy(snapshot.volume.okr, isZh)
    : { arrive: "", mustLand: "" };
  const attentionItems: Array<{ key: string; label: string; onClick?: () => void }> = [];
  if (snapshot?.volumeClose) {
    attentionItems.push({
      key: "volume-close",
      label: isZh ? "本卷已收" : "Volume closed",
      onClick: () => goStage(nav, bookId, "weave"),
    });
  }
  if (snapshot?.lastChapter?.blocked) {
    attentionItems.push({
      key: `review-${snapshot.lastChapter.number}`,
      label: isZh
        ? `第 ${snapshot.lastChapter.number} 章 ${statusLabel(snapshot.lastChapter.status, true)}`
        : `Chapter ${snapshot.lastChapter.number} ${statusLabel(snapshot.lastChapter.status, false)}`,
      onClick: () => nav.toChapter(bookId, snapshot.lastChapter!.number),
    });
  }
  if (snapshot && snapshot.pendingProposalCount > 0) {
    attentionItems.push({
      key: "canon",
      label: isZh
        ? `正典变更 ${snapshot.pendingProposalCount} 处 → 查看`
        : `${snapshot.pendingProposalCount} canon changes → view`,
      onClick: () => setCanonOpen((open) => !open),
    });
  }
  for (const watch of authoring?.manifest?.watches ?? []) {
    if (watch.acknowledged) continue;
    attentionItems.push({
      key: `watch-${watch.id}`,
      label: watch.label,
      onClick: () => goStage(nav, bookId, watch.stage === "ground" || watch.stage === "weave" || watch.stage === "write" || watch.stage === "ask" ? watch.stage : "ground"),
    });
  }
  for (const hook of snapshot?.overdueHooks ?? []) {
    attentionItems.push({
      key: `hook-${hook.hookId}`,
      label: isZh
        ? `伏笔「${stripEngineTokens(hook.hookId)}」${hook.targetChapter ? `目标第 ${hook.targetChapter} 章` : ""}，已逾期`
        : `Hook ${stripEngineTokens(hook.hookId)} overdue`,
      onClick: () => goStage(nav, bookId, "weave"),
    });
  }
  const lockedVolumes = snapshot ? lockedNamedVolumeCount(snapshot.tree) : 0;
  const targetForWeave = book.targetChapters && book.targetChapters > 0 ? book.targetChapters : 200;
  const planned = snapshot ? filledChapterNumbers(snapshot.tree).length : 0;
  const outlineDone = snapshot
    ? resolveOutlineWeaveStep(snapshot.tree, targetForWeave, volumeMap) === "done"
    : false;
  const stepCopy = fourStepCopy({
    askDone: stage?.steps.ask === "done",
    grounded: Boolean(stage?.workflow?.groundConfirmedAt),
    roleCount,
    lockedVolumes,
    outlineDone,
    plannedChapters: planned,
    writtenChapters: data.chapters.length,
    targetChapters: target,
    weaveReady: Boolean(snapshot),
  }, isZh);

  return (
    <div className="space-y-8 fade-in" data-testid="serial-cockpit-home">
      <header className="space-y-2">
        <p className="text-[13px] text-muted-foreground">{isZh ? "本书" : "This book"}</p>
        <h1 className="font-serif text-[32px] font-medium leading-10">{book.title}</h1>
        <p className="text-sm text-muted-foreground">
          {[
            book.genre,
            formatStartedOn(book.createdAt, isZh),
            formatStudyWords(totalWords, isZh),
          ].filter(Boolean).join(" · ")}
        </p>
      </header>

      {snapshot?.volume && (
        <section className="space-y-2" data-testid="cockpit-volume-okr">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">
              {isZh ? "本卷要抵达" : "This volume should arrive at"}
              {" — "}
              {snapshot.volume.name}
            </div>
            <div className="text-xs text-muted-foreground">{snapshot.volume.progressLabel}</div>
          </div>
          {(volumeCopy.arrive || snapshot.volume.okr) && (
            <button
              type="button"
              onClick={() => setVolumeExpanded((open) => !open)}
              className="block w-full text-left text-sm leading-6 text-muted-foreground"
            >
              {volumeExpanded
                ? (
                  <span className="whitespace-pre-wrap">
                    {volumeCopy.arrive || stripEngineTokens(snapshot.volume.okr ?? "")}
                    {volumeCopy.mustLand ? `\n${isZh ? "卷末必须落下：" : "Must land: "}${volumeCopy.mustLand}` : ""}
                  </span>
                )
                : (
                  <span className="line-clamp-1">
                    {volumeCopy.arrive || stripEngineTokens(snapshot.volume.okr ?? "")}
                  </span>
                )}
            </button>
          )}
        </section>
      )}

      {attentionItems.length > 0 && (
        <section className="space-y-2" data-testid="cockpit-attention">
          <div className="text-sm font-medium">{isZh ? "等你过目" : "Waiting for you"}</div>
          <ul className="space-y-1 text-sm">
            {attentionItems.map((item) => (
              <li key={item.key}>
                {item.onClick ? (
                  <button type="button" className="underline-offset-2 hover:underline" onClick={item.onClick}>
                    {item.label}
                    {isZh ? " → 去看" : " → Open"}
                  </button>
                ) : item.label}
              </li>
            ))}
          </ul>
        </section>
      )}

      {canonOpen && snapshot && snapshot.pendingProposalCount > 0 && (
        <section className="space-y-2" data-testid="cockpit-proposals">
          {snapshot.pendingProposals.map((proposal) => (
            <TruthProposalCard
              key={proposal.id}
              bookId={bookId}
              proposal={proposal}
              isZh={isZh}
              onResolved={refreshAux}
            />
          ))}
        </section>
      )}

      <section className="space-y-4 border-t border-border pt-6" data-testid="study-four-steps">
        <div className="text-sm font-medium">{isZh ? "四步一览" : "Four steps"}</div>
        <ul className="grid gap-y-3 text-sm sm:grid-cols-2 sm:gap-x-8" data-testid="study-four-steps-grid">
          <StepLine
            state={stage?.steps.ask}
            label={isZh ? "问心" : "Ask"}
            status={stepCopy.ask}
            onClick={() => goStage(nav, bookId, "ask")}
            testId="study-step-ask"
            isZh={isZh}
          />
          <StepLine
            state={stage?.steps.ground}
            label={isZh ? "研墨" : "Ground"}
            status={
              authoring?.manifest?.coverage?.settingsTarget
                ? `${stepCopy.ground} · ${isZh ? "已采用" : "adopted"} ${authoring.manifest.coverage.settingsAdopted ?? 0}/${authoring.manifest.coverage.settingsTarget}`
                : stepCopy.ground
            }
            onClick={() => goStage(nav, bookId, "ground")}
            testId="study-step-ground"
            isZh={isZh}
          />
          <StepLine
            state={stage?.steps.weave}
            label={isZh ? "织卷" : "Weave"}
            status={
              authoring?.manifest?.coverage?.chaptersTarget
                ? `${stepCopy.weave} · ${isZh ? "已生成" : "generated"} ${authoring.manifest.coverage.chaptersGenerated ?? 0}/${authoring.manifest.coverage.chaptersTarget}`
                : stepCopy.weave
            }
            onClick={() => goStage(nav, bookId, "weave")}
            testId="study-step-weave"
            isZh={isZh}
          />
          <StepLine
            state={stage?.steps.write}
            label={isZh ? "落笔" : "Write"}
            status={stepCopy.write}
            onClick={() => goStage(nav, bookId, "write")}
            testId="study-step-write"
            isZh={isZh}
          />
        </ul>
      </section>

      {activity.lastError && (
        <div className="ink-notice text-sm" data-tone="danger">
          {`${t("book.pipelineFailed")}: ${activity.lastError}`}
        </div>
      )}
    </div>
  );
}

function StepLine({
  state,
  label,
  status,
  onClick,
  testId,
  isZh,
}: {
  readonly state: BookStepState | undefined;
  readonly label: string;
  readonly status: string;
  readonly onClick: () => void;
  readonly testId: string;
  readonly isZh: boolean;
}) {
  const stateText = stageStateLabel(state ?? "todo", isZh, label === "落笔" || label === "Write");
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onClick}
        data-testid={testId}
        className="grid w-full grid-cols-[3.5rem_4rem_minmax(0,1fr)] items-center gap-x-3 text-left leading-6 hover:text-foreground"
      >
        <span className="whitespace-nowrap text-[18px] font-medium">{label}</span>
        <span className="whitespace-nowrap text-muted-foreground">{stateText}</span>
        <span className="truncate text-muted-foreground" title={status}>{status}</span>
      </button>
    </li>
  );
}

export { BookStudy as SerialCockpit };
