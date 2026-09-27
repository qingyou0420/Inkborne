/**
 * Assemble the serialization-cockpit snapshot from existing P1 API payloads.
 * No new backend: book + write-preflight + hooks/due + review-queue +
 * truth-proposals + volume_map.md.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  findChapterNode,
  findVolumeForChapter,
  formatVolumeLabel,
  lastPlannedChapter,
  parseVolumeMapTree,
  plannedChapterCount,
  type VolumeMapTree,
  type VolumeMapVolumeNode,
} from "./volume-map-tree";

export interface CockpitChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount?: number;
}

export interface CockpitPreflightReason {
  readonly code: string;
  readonly message: string;
  readonly messageZh: string;
  readonly jumpTo?: "outline" | "intent" | "review";
  readonly chapterNumber?: number;
}

export interface CockpitPreflight {
  readonly ok: boolean;
  readonly chapterNumber: number;
  readonly reasons: ReadonlyArray<CockpitPreflightReason>;
}

export interface CockpitDueHook {
  readonly hookId: string;
  readonly dueState?: string;
  readonly targetChapter?: number;
  readonly status?: string;
}

export interface CockpitReviewItem {
  readonly chapterNumber: number;
  readonly severity: string;
  readonly category: string;
  readonly description: string;
}

export interface CockpitProposal {
  readonly id: string;
  readonly fileName: string;
  readonly status?: string;
  readonly unifiedDiff?: string;
}

export interface CockpitAssemblyInput {
  readonly chapters: ReadonlyArray<CockpitChapterMeta>;
  readonly nextChapter: number;
  readonly volumeMap: string;
  readonly preflight: CockpitPreflight;
  readonly dueHooks: ReadonlyArray<CockpitDueHook>;
  readonly reviewQueue: ReadonlyArray<CockpitReviewItem>;
  readonly pendingProposals: ReadonlyArray<CockpitProposal>;
  readonly skipPreviousApproval?: boolean;
  readonly isZh?: boolean;
}

export interface CockpitNextChapter {
  readonly number: number;
  readonly title: string | null;
  readonly volumePosition: string | null;
  readonly oneLine: string | null;
}

export interface CockpitVolumeProgress {
  readonly name: string;
  readonly okr: string | null;
  readonly written: number;
  readonly planned: number | null;
  readonly progressLabel: string;
  readonly closeReady: boolean;
}

export interface CockpitLastChapter {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly blocked: boolean;
}

export type WriteThisChapterKind = "write" | "view" | "disabled";

export interface WriteThisChapterAction {
  readonly kind: WriteThisChapterKind;
  readonly chapterNumber: number;
  readonly enabled: boolean;
  readonly reasons: ReadonlyArray<CockpitPreflightReason>;
}

export interface CockpitSnapshot {
  readonly nextChapter: CockpitNextChapter;
  readonly volume: CockpitVolumeProgress | null;
  readonly lastChapter: CockpitLastChapter | null;
  readonly writeNext: {
    readonly enabled: boolean;
    readonly reasons: ReadonlyArray<CockpitPreflightReason>;
    readonly jumpToOutline: boolean;
  };
  readonly dueHooks: ReadonlyArray<CockpitDueHook>;
  readonly overdueHooks: ReadonlyArray<CockpitDueHook>;
  readonly pendingProposalCount: number;
  readonly pendingProposals: ReadonlyArray<CockpitProposal>;
  readonly criticalReview: { readonly chapterNumber: number; readonly count: number } | null;
  readonly volumeClose: { readonly volumeName: string; readonly reason: string } | null;
  readonly tree: VolumeMapTree;
}

const WRITTEN_STATUSES = new Set([
  "approved",
  "published",
  "imported",
  "ready-for-review",
  "audit-failed",
  "needs-revision",
  "drafted",
  "state-degraded",
]);

const BLOCKING_LAST_STATUSES = new Set(["audit-failed", "ready-for-review", "needs-revision", "state-degraded"]);

function isWritten(status: string | undefined): boolean {
  return Boolean(status && WRITTEN_STATUSES.has(status));
}

function writtenInVolume(
  chapters: ReadonlyArray<CockpitChapterMeta>,
  volume: VolumeMapVolumeNode,
): number {
  return chapters.filter((chapter) => {
    if (!isWritten(chapter.status)) return false;
    if (volume.startChapter != null && volume.endChapter != null) {
      return chapter.number >= volume.startChapter && chapter.number <= volume.endChapter;
    }
    return volume.chapters.some((node) => {
      const end = node.endChapter ?? node.chapterNumber;
      return chapter.number >= node.chapterNumber && chapter.number <= end;
    });
  }).length;
}

function volumePositionLabel(
  volume: VolumeMapVolumeNode | undefined,
  chapterNumber: number,
  isZh: boolean,
): string | null {
  if (!volume) return null;
  const name = formatVolumeLabel(volume.volumeNumber, volume.title, isZh);
  const planned = plannedChapterCount(volume);
  if (planned && volume.startChapter != null) {
    const index = chapterNumber - volume.startChapter + 1;
    return isZh ? `${name} · 第 ${index}/${planned} 章` : `${name} · ch. ${index}/${planned}`;
  }
  if (volume.chapters.length > 0) {
    const ordered = [...volume.chapters].sort((a, b) => a.chapterNumber - b.chapterNumber);
    const index = ordered.findIndex((node) => {
      const end = node.endChapter ?? node.chapterNumber;
      return chapterNumber >= node.chapterNumber && chapterNumber <= end;
    });
    if (index >= 0) {
      return isZh
        ? `${name} · 第 ${index + 1}/${ordered.length} 章`
        : `${name} · ch. ${index + 1}/${ordered.length}`;
    }
  }
  return name;
}

function notNextReason(nextChapter: number, isZh: boolean): CockpitPreflightReason {
  return {
    code: "not_next_chapter",
    message: `Write this chapter is sequential. Write chapter ${nextChapter} first.`,
    messageZh: `请先落笔第 ${nextChapter} 章，不能跳章。`,
    jumpTo: "outline",
    chapterNumber: nextChapter,
  };
}

export function resolveWriteThisChapterAction(input: {
  readonly selectedChapter: number;
  readonly nextChapter: number;
  readonly written: boolean;
  readonly preflight: CockpitPreflight;
  readonly isZh?: boolean;
}): WriteThisChapterAction {
  const isZh = input.isZh !== false;
  if (input.written) {
    return {
      kind: "view",
      chapterNumber: input.selectedChapter,
      enabled: true,
      reasons: [],
    };
  }
  if (input.selectedChapter === input.nextChapter) {
    return {
      kind: "write",
      chapterNumber: input.selectedChapter,
      enabled: input.preflight.ok,
      reasons: input.preflight.ok ? [] : input.preflight.reasons,
    };
  }
  if (input.selectedChapter > input.nextChapter) {
    return {
      kind: "disabled",
      chapterNumber: input.selectedChapter,
      enabled: false,
      reasons: [notNextReason(input.nextChapter, isZh)],
    };
  }
  return {
    kind: "disabled",
    chapterNumber: input.selectedChapter,
    enabled: false,
    reasons: [notNextReason(input.nextChapter, isZh)],
  };
}

function lastChapterBlocked(
  last: CockpitChapterMeta | undefined,
  reviewQueue: ReadonlyArray<CockpitReviewItem>,
): boolean {
  if (!last) return false;
  if (last.status === "audit-failed") return true;
  if (!BLOCKING_LAST_STATUSES.has(last.status)) return false;
  return reviewQueue.some((item) => item.chapterNumber === last.number && item.severity === "critical");
}

export function assembleCockpitSnapshot(input: CockpitAssemblyInput): CockpitSnapshot {
  const isZh = input.isZh !== false;
  const tree = parseVolumeMapTree(input.volumeMap);
  const nextNumber = input.preflight.chapterNumber || input.nextChapter;
  const chapterNode = findChapterNode(tree, nextNumber);
  const volume = findVolumeForChapter(tree, nextNumber);
  const title = chapterNode?.title || null;
  const oneLine = (chapterNode?.summary || chapterNode?.title || "").trim() || null;

  const last = input.chapters
    .filter((chapter) => chapter.number === nextNumber - 1)
    .at(0);
  const lastBlocked = lastChapterBlocked(last, input.reviewQueue);
  const criticalForLast = last
    ? input.reviewQueue.filter((item) => item.chapterNumber === last.number && item.severity === "critical")
    : [];
  const criticalAnywhere = input.reviewQueue.filter((item) => item.severity === "critical");
  const criticalReview = lastBlocked && last
    ? { chapterNumber: last.number, count: Math.max(criticalForLast.length, 1) }
    : criticalAnywhere[0]
      ? { chapterNumber: criticalAnywhere[0].chapterNumber, count: criticalAnywhere.length }
      : null;

  const pending = input.pendingProposals.filter((item) => !item.status || item.status === "pending");
  const overdueHooks = input.dueHooks.filter((hook) => hook.dueState === "overdue");

  const volumeProgress = volume
    ? assembleVolumeProgress(volume, input.chapters, nextNumber, isZh, tree)
    : null;

  const jumpToOutline = input.preflight.reasons.some((reason) => reason.jumpTo === "outline");

  return {
    nextChapter: {
      number: nextNumber,
      title,
      volumePosition: volumePositionLabel(volume, nextNumber, isZh),
      oneLine,
    },
    volume: volumeProgress,
    lastChapter: last
      ? {
          number: last.number,
          title: last.title,
          status: last.status,
          blocked: lastBlocked,
        }
      : null,
    writeNext: {
      enabled: input.preflight.ok,
      reasons: input.preflight.ok ? [] : input.preflight.reasons,
      jumpToOutline,
    },
    dueHooks: input.dueHooks,
    overdueHooks,
    pendingProposalCount: pending.length,
    pendingProposals: pending,
    criticalReview,
    volumeClose: volumeProgress?.closeReady
      ? {
          volumeName: volumeProgress.name,
          reason: isZh
            ? `${volumeProgress.name} 已写完。过卷是里程碑：用织卷起草下一卷 OKR，确认后写入 volume_map。`
            : `${volumeProgress.name} is complete. Volume close is a milestone: use 织卷 to draft the next volume OKR.`,
        }
      : null,
    tree,
  };
}

function assembleVolumeProgress(
  volume: VolumeMapVolumeNode,
  chapters: ReadonlyArray<CockpitChapterMeta>,
  nextChapter: number,
  isZh: boolean,
  tree: VolumeMapTree,
): CockpitVolumeProgress {
  const planned = plannedChapterCount(volume);
  const written = writtenInVolume(chapters, volume);
  const lastPlanned = lastPlannedChapter(volume);
  const lastOfVolume = lastPlanned
    ? chapters.find((chapter) => chapter.number === lastPlanned)
    : undefined;
  const volumeIndex = tree.volumes.findIndex((item) => item.id === volume.id);
  const nextVolume = volumeIndex >= 0 ? tree.volumes[volumeIndex + 1] : undefined;
  const nextVolumeHasChapters = Boolean(nextVolume && (nextVolume.chapters.length > 0 || nextVolume.okr));
  const reachedEnd = lastPlanned != null && nextChapter > lastPlanned;
  const lastSettled = lastOfVolume?.status === "approved"
    || lastOfVolume?.status === "published"
    || lastOfVolume?.status === "imported";
  const closeReady = Boolean(reachedEnd && lastSettled && !nextVolumeHasChapters && lastPlanned != null);

  const name = formatVolumeLabel(volume.volumeNumber, volume.title, isZh);
  const progressLabel = planned
    ? (isZh ? `${written}/${planned} 章` : `${written}/${planned} ch.`)
    : (isZh ? `已写 ${written} 章` : `${written} written`);

  return {
    name,
    okr: volume.okr || null,
    written,
    planned,
    progressLabel,
    closeReady,
  };
}

export function writeDisableReasonCodes(snapshot: CockpitSnapshot): ReadonlyArray<string> {
  return snapshot.writeNext.reasons.map((reason) => reason.code);
}
