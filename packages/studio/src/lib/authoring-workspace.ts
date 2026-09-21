/**
 * Shared types for the four-agent authoring workspace.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export interface AuthoringArtifact {
  readonly artifactId: string;
  readonly stage: "ask" | "ground" | "weave" | "write";
  readonly scope: string;
  readonly version: number;
  readonly status: "draft" | "candidate" | "adopted" | "archived";
  readonly label?: string;
  readonly parentVersion?: number;
  readonly parentArtifactId?: string;
}

export interface AuthoringIssue {
  readonly issueId: string;
  readonly title: string;
  readonly severity: "priority" | "improve" | "style" | string;
  readonly target?: string;
  readonly evidence?: string;
  readonly suggestion?: string;
  readonly reason?: string;
}

export interface AuthoringReport {
  readonly reportId: string;
  readonly stage: string;
  readonly coverage: string;
  readonly actualReviewModel: string;
  readonly summary: string;
  readonly stale?: boolean;
  readonly staleReason?: string;
  readonly incomplete?: boolean;
  readonly createdAt?: string;
  readonly targetRefs: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<AuthoringIssue>;
}

export interface AuthoringCatalogEntry {
  readonly id: string;
  readonly category: string;
  readonly name: string;
  readonly file: string;
  readonly adoptedArtifactId?: string;
  readonly candidateArtifactId?: string;
  readonly archived?: boolean;
}

export interface AuthoringImpactItem {
  readonly key: string;
  readonly stage: "ground" | "weave";
  readonly targetId: string;
  readonly label: string;
  readonly verdict: "affected" | "maybe";
  readonly fields: ReadonlyArray<string>;
  readonly reason: string;
  readonly hint?: string;
  readonly method: "llm" | "heuristic" | "rule";
  readonly snapshot?: string;
  readonly status: "open" | "reviewed" | "regenerated" | "dismissed";
  readonly resolvedAt?: string;
  readonly resolvedArtifactId?: string;
}

export interface AuthoringImpactSummary {
  readonly impactId: string;
  readonly from: { readonly artifactId: string; readonly version: number };
  readonly to: { readonly artifactId: string; readonly version: number };
  readonly openCount: { readonly ground: number; readonly weave: number };
  readonly items: ReadonlyArray<AuthoringImpactItem>;
  readonly globals: ReadonlyArray<{ readonly field: string; readonly note: string }>;
  readonly method: "llm" | "heuristic" | "mixed";
  readonly degraded?: { readonly reason: string };
  readonly partial?: boolean;
  readonly runId?: string;
  readonly groundReportId?: string;
  readonly weaveReportId?: string;
}

export interface AuthoringWorkspace {
  readonly impact?: AuthoringImpactSummary;
  readonly canon?: {
    readonly title?: string;
    readonly oneLine?: string;
    readonly proposition?: string;
    readonly protagonist?: string;
    readonly conflict?: string;
    readonly voice?: string;
    readonly boundaries?: string;
    readonly direction?: string;
    readonly openQuestions?: string[];
    readonly targetChapters?: number;
    readonly chapterWordCount?: number;
  };
  readonly canonSource?: string;
  readonly adoptedAskId?: string;
  readonly candidateAsk?: {
    readonly artifactId: string;
    readonly version: number;
    readonly status: string;
    readonly body: string;
    readonly canon?: AuthoringWorkspace["canon"];
  };
  readonly candidateWeave?: {
    readonly artifactId: string;
    readonly version: number;
    readonly status: string;
    readonly body: string;
    readonly scope?: string;
  };
  readonly runs?: ReadonlyArray<{
    readonly runId: string;
    readonly stage: string;
    readonly status: string;
    readonly operation?: string;
    readonly scope?: string;
    readonly progressDone?: number;
    readonly progressTotal?: number;
    readonly progressLabel?: string;
    readonly error?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly producedArtifactIds?: ReadonlyArray<string>;
    readonly checkpoint?: {
      readonly requestedStart?: number;
      readonly requestedEnd?: number;
      readonly missingChapters?: ReadonlyArray<number>;
    };
  }>;
  readonly catalog?: {
    readonly categories: ReadonlyArray<string>;
    readonly entries: ReadonlyArray<AuthoringCatalogEntry>;
  };
  readonly authoringBook?: boolean;
  readonly writeStateRefs?: Readonly<Record<string, string>>;
  readonly artifacts?: ReadonlyArray<AuthoringArtifact>;
  readonly reports?: ReadonlyArray<AuthoringReport>;
  readonly manifest?: {
    readonly adopted?: {
      readonly ask?: string;
      readonly ground?: ReadonlyArray<string>;
      readonly weave?: string;
      readonly write?: Record<string, string>;
    };
    readonly candidates?: {
      readonly ask?: string;
      readonly ground?: ReadonlyArray<string>;
      readonly weave?: string;
      readonly write?: Record<string, string>;
    };
    readonly coverage?: {
      readonly settingsGenerated?: number;
      readonly settingsAdopted?: number;
      readonly settingsTarget?: number;
      readonly chaptersGenerated?: number;
      readonly chaptersAdopted?: number;
      readonly chaptersTarget?: number;
      readonly chaptersWrittenAdopted?: number;
    };
    readonly watches?: ReadonlyArray<{
      readonly id: string;
      readonly stage: string;
      readonly label: string;
      readonly acknowledged?: boolean;
      readonly fromArtifactId?: string;
      readonly toArtifactId?: string;
      readonly impactReportId?: string;
      readonly openCount?: number;
    }>;
  };
}

export function workspaceQuery(bookId?: string, draftId?: string): string {
  if (bookId) return `bookId=${encodeURIComponent(bookId)}`;
  if (draftId) return `draftId=${encodeURIComponent(draftId)}`;
  return "";
}

export function reportForArtifact(
  reports: ReadonlyArray<AuthoringReport> | undefined,
  artifactId: string | undefined,
): AuthoringReport | undefined {
  if (!artifactId) return undefined;
  return (reports ?? []).find((item) => item.targetRefs.includes(artifactId));
}

export function reportById(
  reports: ReadonlyArray<AuthoringReport> | undefined,
  reportId: string | undefined,
): AuthoringReport | undefined {
  if (!reportId) return undefined;
  return (reports ?? []).find((item) => item.reportId === reportId);
}

export function latestArtifact(
  artifacts: ReadonlyArray<AuthoringArtifact> | undefined,
  stage: AuthoringArtifact["stage"],
  scope?: string,
): AuthoringArtifact | undefined {
  const matched = (artifacts ?? []).filter((item) => item.stage === stage && (!scope || item.scope === scope));
  return matched.at(-1);
}

export function currentWriteArtifact(
  workspace: AuthoringWorkspace | null | undefined,
  chapterNumber: number,
): AuthoringArtifact | undefined {
  const selectedId = workspace?.manifest?.candidates?.write?.[String(chapterNumber)];
  if (selectedId) {
    const selected = workspace?.artifacts?.find((item) => item.artifactId === selectedId);
    if (selected) return selected;
  }
  return latestArtifact(workspace?.artifacts, "write", `chapter:${chapterNumber}`);
}

export function resolveAdoptArtifactId(
  persistedId: string | undefined,
  candidateId: string | undefined,
): string {
  const artifactId = persistedId ?? candidateId;
  if (!artifactId) throw new Error("没有可采用的稿件");
  return artifactId;
}

export function severityLabel(severity: string, isZh: boolean): string {
  if (severity === "priority") return isZh ? "优先处理" : "Priority";
  if (severity === "style") return isZh ? "风格建议" : "Style";
  return isZh ? "可改善" : "Improve";
}
