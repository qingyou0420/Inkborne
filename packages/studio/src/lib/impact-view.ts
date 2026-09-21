/**
 * Pure helpers for P0 canon-impact UI: filters, banners, and regenerate notes.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type {
  AuthoringImpactItem,
  AuthoringImpactSummary,
  AuthoringIssue,
  AuthoringWorkspace,
} from "./authoring-workspace";

export type ImpactCatalogFilter = "needs-review" | "all";

export type AuthoringWatch = NonNullable<NonNullable<AuthoringWorkspace["manifest"]>["watches"]>[number];

export type AuthoringRunLike = {
  readonly runId?: string;
  readonly stage?: string;
  readonly operation?: string;
  readonly scope?: string;
  readonly status?: string;
};

export function isImpactTriageRun(run?: AuthoringRunLike | null): boolean {
  return Boolean(run?.stage === "ask" && run.operation === "review" && run.scope?.startsWith("impact:"));
}

export function findImpactTriageRun(runs: ReadonlyArray<AuthoringRunLike> | undefined): AuthoringRunLike | undefined {
  const matched = (runs ?? []).filter(isImpactTriageRun);
  return matched.find((run) => run.status === "running" || run.status === "pausing") ?? matched.at(-1);
}

export function impactVersionSpan(
  from?: { readonly version: number },
  to?: { readonly version: number },
): string {
  if (!from || !to) return "正典";
  return `正典 v${from.version}→v${to.version}`;
}

export function openImpactItems(
  impact: AuthoringImpactSummary | undefined | null,
  stage?: "ground" | "weave",
): AuthoringImpactItem[] {
  return (impact?.items ?? []).filter((item) => item.status === "open" && (!stage || item.stage === stage));
}

export function impactOpenTotal(impact: AuthoringImpactSummary | undefined | null): number {
  if (!impact) return 0;
  return impact.openCount.ground + impact.openCount.weave;
}

export function shouldShowImpactFilter(openCount: number, authoringBook?: boolean): boolean {
  return authoringBook !== false && openCount > 0;
}

export function defaultImpactFilter(openCount: number): ImpactCatalogFilter {
  return openCount > 0 ? "needs-review" : "all";
}

export function openGroundItemForEntry(
  impact: AuthoringImpactSummary | undefined | null,
  entryId: string | undefined,
): AuthoringImpactItem | undefined {
  if (!entryId) return undefined;
  return openImpactItems(impact, "ground").find((item) => item.targetId === entryId || item.key === `ground:${entryId}`);
}

export function openCatalogImpact(impact: AuthoringImpactSummary | undefined | null): AuthoringImpactItem | undefined {
  return openImpactItems(impact, "ground").find((item) => item.key === "ground:catalog" || item.targetId === "catalog");
}

export function openStructureImpact(impact: AuthoringImpactSummary | undefined | null): AuthoringImpactItem | undefined {
  return openImpactItems(impact, "weave").find((item) => item.key === "weave:structure" || item.targetId === "structure");
}

export function chapterNumberFromImpactKey(key: string): number | undefined {
  const match = /^weave:chapter:(\d+)$/.exec(key);
  return match ? Number(match[1]) : undefined;
}

export function weaveNodeMatchesItem(
  item: AuthoringImpactItem,
  nodeId?: string | null,
  chapterNumber?: number,
  endChapter?: number,
): boolean {
  if (item.stage !== "weave") return false;
  if (item.key === "weave:structure" || item.targetId === "structure") {
    return nodeId === "weave-book" || nodeId === "structure";
  }
  if (nodeId && (item.targetId === nodeId || item.key === `weave:${nodeId}`)) return true;
  const chapter = chapterNumberFromImpactKey(item.key);
  if (chapter != null && chapterNumber != null) {
    if (endChapter != null && endChapter !== chapterNumber) {
      return chapter >= chapterNumber && chapter <= endChapter;
    }
    return chapter === chapterNumber;
  }
  const range = /^weave:range:(\d+)-(\d+)$/.exec(item.key);
  if (range && chapterNumber != null) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    const nodeEnd = endChapter ?? chapterNumber;
    return chapterNumber <= end && nodeEnd >= start;
  }
  return false;
}

export function openWeaveItemForNode(
  impact: AuthoringImpactSummary | undefined | null,
  nodeId?: string | null,
  chapterNumber?: number,
  endChapter?: number,
): AuthoringImpactItem | undefined {
  return openImpactItems(impact, "weave").find((item) => weaveNodeMatchesItem(item, nodeId, chapterNumber, endChapter));
}

export function openWeaveItemForChapter(
  impact: AuthoringImpactSummary | undefined | null,
  chapterNumber: number | undefined,
): AuthoringImpactItem | undefined {
  if (chapterNumber == null) return undefined;
  return openWeaveItemForNode(impact, `chapter:${chapterNumber}`, chapterNumber);
}

export function filterGroundEntries<T extends { readonly id: string }>(
  entries: ReadonlyArray<T>,
  impact: AuthoringImpactSummary | undefined | null,
  filter: ImpactCatalogFilter,
): T[] {
  if (filter !== "needs-review") return [...entries];
  const openIds = new Set(openImpactItems(impact, "ground").map((item) => item.targetId));
  return entries.filter((entry) => openIds.has(entry.id));
}

export function truncateImpactReason(reason: string, max = 60): string {
  const trimmed = reason.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

export function impactRegenerateRequirements(
  items: ReadonlyArray<AuthoringImpactItem>,
  isZh = true,
): string {
  const lines = items
    .filter((item) => item.status === "open")
    .map((item) => {
      const hint = item.hint?.trim();
      return hint ? `${item.reason.trim()}；${hint}` : item.reason.trim();
    })
    .filter(Boolean);
  if (!lines.length) return "";
  const header = isZh ? "对照新正典的影响：" : "Canon impact to address:";
  return [header, ...lines.map((line) => `- ${line}`)].join("\n");
}

export function weaveReviseRangeFromIssues(issues: ReadonlyArray<AuthoringIssue>): {
  readonly startChapter?: number;
  readonly endChapter?: number;
  readonly structure: boolean;
} {
  const numbers = issues.flatMap((issue) => {
    const value = Number(issue.target);
    return Number.isInteger(value) && value > 0 ? [value] : [];
  });
  const structure = issues.some((issue) => issue.target === "structure");
  if (!numbers.length) return { structure };
  return {
    startChapter: Math.min(...numbers),
    endChapter: Math.max(...numbers),
    structure,
  };
}

export function isLegacyCanonWatch(watch: AuthoringWatch): boolean {
  return !watch.acknowledged && !watch.impactReportId;
}

export function legacyCanonWatches(watches: ReadonlyArray<AuthoringWatch> | undefined): AuthoringWatch[] {
  return (watches ?? []).filter(isLegacyCanonWatch);
}

export type WriteImpactBanner = {
  readonly kind: "running" | "open" | "degraded" | "legacy";
  readonly text: string;
  readonly chapterText?: string;
  readonly actions: ReadonlyArray<"ground" | "weave" | "chapter" | "recompute" | "ack">;
};

export function writeImpactBanner(input: {
  readonly impact?: AuthoringImpactSummary | null;
  readonly watches?: ReadonlyArray<AuthoringWatch>;
  readonly chapterNumber?: number;
  readonly triageRunning?: boolean;
  readonly authoringBook?: boolean;
  readonly isZh: boolean;
}): WriteImpactBanner | null {
  if (input.authoringBook === false) return null;
  if (input.triageRunning) {
    return {
      kind: "running",
      text: input.isZh ? "正在分辨正典改动的影响…" : "Resolving how the canon change affects this book…",
      actions: [],
    };
  }
  const impact = input.impact;
  const open = impact ? impactOpenTotal(impact) : 0;
  if (impact && open > 0) {
    const span = impactVersionSpan(impact.from, impact.to);
    const ground = impact.openCount.ground;
    const weave = impact.openCount.weave;
    const parts = input.isZh
      ? [
        ground > 0 ? `设定 ${ground} 条` : "",
        weave > 0 ? `章概要 ${weave} 章` : "",
      ].filter(Boolean).join("、")
      : [
        ground > 0 ? `${ground} settings` : "",
        weave > 0 ? `${weave} summaries` : "",
      ].filter(Boolean).join(", ");
    const chapterItem = openWeaveItemForChapter(impact, input.chapterNumber);
    const actions: Array<"ground" | "weave" | "chapter"> = [];
    if (ground > 0) actions.push("ground");
    if (weave > 0) actions.push("weave");
    if (chapterItem) actions.push("chapter");
    return {
      kind: "open",
      text: input.isZh
        ? `${span} 影响未核对完：${parts}`
        : `${span}: ${parts} still need review`,
      chapterText: chapterItem
        ? (input.isZh
          ? `本章概要被标记受影响：${chapterItem.reason}`
          : `This chapter summary is marked affected: ${chapterItem.reason}`)
        : undefined,
      actions,
    };
  }
  if (impact?.degraded) {
    return {
      kind: "degraded",
      text: input.isZh
        ? `影响分辨失败，可重算${impact.degraded.reason ? `：${impact.degraded.reason}` : ""}`
        : `Impact triage failed${impact.degraded.reason ? `: ${impact.degraded.reason}` : ""}. Recompute when ready.`,
      actions: ["recompute", "ack"],
    };
  }
  if (!impact && legacyCanonWatches(input.watches).length > 0) {
    return {
      kind: "legacy",
      text: input.isZh ? "上游正典有过变更，尚未分辨影响" : "The adopted canon changed before impact triage existed.",
      actions: ["recompute", "ack"],
    };
  }
  return null;
}

export function writeImpactActionLabel(action: WriteImpactBanner["actions"][number], isZh: boolean): string {
  if (action === "ground") return isZh ? "去研墨" : "Go to Ground";
  if (action === "weave") return isZh ? "去织卷" : "Go to Weave";
  if (action === "chapter") return isZh ? "去织卷看这章" : "Open this chapter in Weave";
  if (action === "recompute") return isZh ? "重算" : "Recompute";
  return isZh ? "标为已核对" : "Mark reviewed";
}

export type StudyImpactAttention = {
  readonly key: string;
  readonly label: string;
  readonly groundOpen: number;
  readonly weaveOpen: number;
  readonly degraded?: boolean;
  readonly legacy?: boolean;
};

export function studyImpactAttention(input: {
  readonly impact?: AuthoringImpactSummary | null;
  readonly watches?: ReadonlyArray<AuthoringWatch>;
  readonly triageRunning?: boolean;
  readonly authoringBook?: boolean;
  readonly isZh: boolean;
}): StudyImpactAttention | null {
  if (input.authoringBook === false) return null;
  if (input.triageRunning) {
    return {
      key: "impact-running",
      label: input.isZh ? "正在分辨正典改动的影响…" : "Resolving how the canon change affects this book…",
      groundOpen: 0,
      weaveOpen: 0,
    };
  }
  const impact = input.impact;
  const open = impact ? impactOpenTotal(impact) : 0;
  if (impact && open > 0) {
    const span = impactVersionSpan(impact.from, impact.to);
    const ground = impact.openCount.ground;
    const weave = impact.openCount.weave;
    const parts = input.isZh
      ? [
        ground > 0 ? `设定 ${ground} 条` : "",
        weave > 0 ? `章概要 ${weave} 章` : "",
      ].filter(Boolean).join("、")
      : [
        ground > 0 ? `${ground} settings` : "",
        weave > 0 ? `${weave} summaries` : "",
      ].filter(Boolean).join(", ");
    return {
      key: `impact-${impact.impactId}`,
      label: input.isZh ? `${span}：${parts}待核对` : `${span}: ${parts} need review`,
      groundOpen: ground,
      weaveOpen: weave,
    };
  }
  if (impact?.degraded) {
    return {
      key: `impact-degraded-${impact.impactId}`,
      label: input.isZh
        ? `影响分辨失败，可重算${impact.degraded.reason ? `：${impact.degraded.reason}` : ""}`
        : `Impact triage failed${impact.degraded.reason ? `: ${impact.degraded.reason}` : ""}`,
      groundOpen: 0,
      weaveOpen: 0,
      degraded: true,
    };
  }
  if (!impact && legacyCanonWatches(input.watches).length > 0) {
    return {
      key: "impact-legacy",
      label: input.isZh ? "上游正典有过变更，尚未分辨影响" : "The adopted canon changed before impact triage existed.",
      groundOpen: 0,
      weaveOpen: 0,
      legacy: true,
    };
  }
  return null;
}

export function isCanonImpactWatch(watch: AuthoringWatch): boolean {
  return Boolean(watch.impactReportId) || /正典/.test(watch.label);
}

export function impactCompleteCopy(input: {
  readonly impact?: AuthoringImpactSummary | null;
  readonly isZh: boolean;
}): { readonly message: string; readonly stage: "ground" | "weave"; readonly action: string } | null {
  const impact = input.impact;
  if (!impact) return null;
  const ground = impact.openCount.ground;
  const weave = impact.openCount.weave;
  if (impact.degraded && ground + weave === 0) {
    return {
      message: input.isZh
        ? `影响分辨失败，可重算${impact.degraded.reason ? `：${impact.degraded.reason}` : ""}`
        : `Impact triage failed${impact.degraded.reason ? `: ${impact.degraded.reason}` : ""}`,
      stage: "ground",
      action: input.isZh ? "去研墨" : "Go to Ground",
    };
  }
  if (ground + weave === 0) return null;
  const parts = input.isZh
    ? [
      ground > 0 ? `设定 ${ground} 条` : "",
      weave > 0 ? `章概要 ${weave} 章` : "",
    ].filter(Boolean).join("、")
    : [
      ground > 0 ? `${ground} settings` : "",
      weave > 0 ? `${weave} summaries` : "",
    ].filter(Boolean).join(", ");
  return {
    message: input.isZh ? `影响分辨完成：${parts}需核对` : `Impact ready: ${parts} need review`,
    stage: ground >= weave ? "ground" : "weave",
    action: ground >= weave
      ? (input.isZh ? "去研墨" : "Go to Ground")
      : (input.isZh ? "去织卷" : "Go to Weave"),
  };
}

const IMPACT_FOCUS_KEY = "inkborne.impactFocus";

export function rememberImpactFocus(nodeId: string): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(IMPACT_FOCUS_KEY, nodeId);
}

export function takeImpactFocus(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  const value = sessionStorage.getItem(IMPACT_FOCUS_KEY);
  if (value) sessionStorage.removeItem(IMPACT_FOCUS_KEY);
  return value;
}
