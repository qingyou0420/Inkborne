/**
 * 墨生万象 four-agent authoring workflow types.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { z } from "zod";

export const AuthoringStageSchema = z.enum(["ask", "ground", "weave", "write"]);
export type AuthoringStage = z.infer<typeof AuthoringStageSchema>;

export const AuthoringRoleIdSchema = z.enum([
  "ask.main",
  "ask.review",
  "ground.main",
  "ground.review",
  "weave.main",
  "weave.review",
  "write.main",
  "write.review",
]);
export type AuthoringRoleId = z.infer<typeof AuthoringRoleIdSchema>;

export const AUTHORING_ROLE_IDS: readonly AuthoringRoleId[] = AuthoringRoleIdSchema.options;

export const AUTHORING_ROLE_META: Readonly<Record<AuthoringRoleId, {
  readonly stage: AuthoringStage;
  readonly kind: "main" | "review";
  readonly zh: string;
  readonly en: string;
}>> = {
  "ask.main": { stage: "ask", kind: "main", zh: "问心 · 创作", en: "Ask · Main" },
  "ask.review": { stage: "ask", kind: "review", zh: "问心 · 审查", en: "Ask · Review" },
  "ground.main": { stage: "ground", kind: "main", zh: "研墨 · 创作", en: "Ground · Main" },
  "ground.review": { stage: "ground", kind: "review", zh: "研墨 · 审查", en: "Ground · Review" },
  "weave.main": { stage: "weave", kind: "main", zh: "织卷 · 创作", en: "Weave · Main" },
  "weave.review": { stage: "weave", kind: "review", zh: "织卷 · 审查", en: "Weave · Review" },
  "write.main": { stage: "write", kind: "main", zh: "落笔 · 创作", en: "Write · Main" },
  "write.review": { stage: "write", kind: "review", zh: "落笔 · 审查", en: "Write · Review" },
};

export const AuthoringRoleConfigSchema = z.object({
  serviceRef: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  thinkingBudget: z.number().int().min(0).optional(),
  apiFormat: z.enum(["chat", "responses"]).optional(),
  extra: z.record(z.unknown()).optional(),
  instructions: z.string().optional(),
  instructionsVersion: z.number().int().min(1).optional(),
  lastTestStatus: z.enum(["untested", "ok", "failed"]).optional(),
  lastTestError: z.string().optional(),
});
export type AuthoringRoleConfig = z.infer<typeof AuthoringRoleConfigSchema>;

export const AuthoringRolesSchema = z.object({
  "ask.main": AuthoringRoleConfigSchema.optional(),
  "ask.review": AuthoringRoleConfigSchema.optional(),
  "ground.main": AuthoringRoleConfigSchema.optional(),
  "ground.review": AuthoringRoleConfigSchema.optional(),
  "weave.main": AuthoringRoleConfigSchema.optional(),
  "weave.review": AuthoringRoleConfigSchema.optional(),
  "write.main": AuthoringRoleConfigSchema.optional(),
  "write.review": AuthoringRoleConfigSchema.optional(),
}).partial();
export type AuthoringRoles = z.infer<typeof AuthoringRolesSchema>;

export const ArtifactSourceSchema = z.enum(["generate", "hand", "import", "revise", "compat"]);
export type ArtifactSource = z.infer<typeof ArtifactSourceSchema>;

export const ArtifactStatusSchema = z.enum(["draft", "candidate", "adopted", "archived"]);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const InputRefSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  version: z.number().int().min(1).optional(),
  usage: z.enum(["index", "full", "excerpt"]).optional(),
  reason: z.string().optional(),
  snippet: z.string().optional(),
});
export type InputRef = z.infer<typeof InputRefSchema>;

export const AuthoringArtifactMetaSchema = z.object({
  artifactId: z.string().min(1),
  stage: AuthoringStageSchema,
  scope: z.string().min(1),
  version: z.number().int().min(1),
  parentVersion: z.number().int().min(1).optional(),
  parentArtifactId: z.string().min(1).optional(),
  source: ArtifactSourceSchema,
  status: ArtifactStatusSchema,
  bodyPath: z.string().min(1),
  inputRefs: z.array(InputRefSchema).default([]),
  createdAt: z.string().min(1),
  runId: z.string().optional(),
  label: z.string().optional(),
  title: z.string().optional(),
});
export type AuthoringArtifactMeta = z.infer<typeof AuthoringArtifactMetaSchema>;

export const ReviewIssueSeveritySchema = z.enum(["priority", "improve", "style"]);
export type ReviewIssueSeverity = z.infer<typeof ReviewIssueSeveritySchema>;

export const ReviewIssueSchema = z.object({
  issueId: z.string().min(1),
  title: z.string().min(1),
  severity: ReviewIssueSeveritySchema,
  target: z.string().optional(),
  evidence: z.string().optional(),
  sources: z.array(z.string()).default([]),
  reason: z.string().optional(),
  suggestion: z.string().optional(),
  suggestedScope: z.string().optional(),
});
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

export const AuthoringReviewReportSchema = z.object({
  reportId: z.string().min(1),
  stage: AuthoringStageSchema,
  targetRefs: z.array(z.string()).min(1),
  coverage: z.string().min(1),
  inputRefs: z.array(InputRefSchema).default([]),
  actualReviewModel: z.string().min(1),
  createdAt: z.string().min(1),
  summary: z.string().min(1),
  issues: z.array(ReviewIssueSchema).default([]),
  stale: z.boolean().default(false),
  staleReason: z.string().optional(),
  incomplete: z.boolean().default(false),
  runId: z.string().optional(),
});
export type AuthoringReviewReport = z.infer<typeof AuthoringReviewReportSchema>;

export const AuthoringRunStatusSchema = z.enum([
  "running",
  "pausing",
  "paused",
  "completed",
  "partial",
  "failed",
  "cancelled",
  "reconnecting",
]);
export type AuthoringRunStatus = z.infer<typeof AuthoringRunStatusSchema>;

export const AuthoringRunCheckpointSchema = z.object({
  requirements: z.string().optional(),
  completedThrough: z.number().int().min(0).optional(),
  remainingStart: z.number().int().min(1).optional(),
  remainingEnd: z.number().int().min(1).optional(),
  requestedStart: z.number().int().min(1).optional(),
  requestedEnd: z.number().int().min(1).optional(),
  missingChapters: z.array(z.number().int().min(1)).default([]),
  completedChapters: z.array(z.number().int().min(1)).default([]),
  producedScope: z.string().optional(),
  targetChapters: z.number().int().min(1).optional(),
  revisionArtifactId: z.string().optional(),
  revisionIssueIds: z.array(z.string()).optional(),
  revisionReuseStale: z.boolean().optional(),
});
export type AuthoringRunCheckpoint = z.infer<typeof AuthoringRunCheckpointSchema>;

export const AuthoringRunRecordSchema = z.object({
  runId: z.string().min(1),
  stage: AuthoringStageSchema,
  operation: z.enum(["generate", "review", "revise", "adopt", "settle"]),
  roleId: AuthoringRoleIdSchema,
  status: AuthoringRunStatusSchema,
  bookId: z.string().optional(),
  draftId: z.string().optional(),
  scope: z.string().optional(),
  progressDone: z.number().int().min(0).default(0),
  progressTotal: z.number().int().min(0).optional(),
  progressLabel: z.string().optional(),
  error: z.string().optional(),
  producedArtifactIds: z.array(z.string()).default([]),
  reportId: z.string().optional(),
  modelSnapshot: z.record(z.unknown()),
  checkpoint: AuthoringRunCheckpointSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type AuthoringRunRecord = z.infer<typeof AuthoringRunRecordSchema>;

export const DependencyWatchSchema = z.object({
  id: z.string().min(1),
  stage: AuthoringStageSchema,
  sourceKind: z.string().min(1),
  sourceId: z.string().min(1),
  fromVersion: z.number().int().min(1).optional(),
  toVersion: z.number().int().min(1).optional(),
  fromArtifactId: z.string().min(1).optional(),
  toArtifactId: z.string().min(1).optional(),
  impactReportId: z.string().min(1).optional(),
  openCount: z.number().int().min(0).optional(),
  label: z.string().min(1),
  acknowledged: z.boolean().default(false),
});
export type DependencyWatch = z.infer<typeof DependencyWatchSchema>;

export const ImpactItemSchema = z.object({
  key: z.string().min(1),
  stage: z.enum(["ground", "weave"]),
  targetId: z.string().min(1),
  label: z.string().min(1),
  verdict: z.enum(["affected", "maybe"]),
  fields: z.array(z.string()).default([]),
  reason: z.string().min(1),
  hint: z.string().optional(),
  method: z.enum(["llm", "heuristic", "rule"]),
  snapshot: z.string().optional(),
  status: z.enum(["open", "reviewed", "regenerated", "dismissed"]).default("open"),
  resolvedAt: z.string().optional(),
  resolvedArtifactId: z.string().optional(),
});
export type ImpactItem = z.infer<typeof ImpactItemSchema>;

export const ImpactGlobalNoteSchema = z.object({
  field: z.string().min(1),
  note: z.string().min(1),
});
export type ImpactGlobalNote = z.infer<typeof ImpactGlobalNoteSchema>;

export const ImpactChangeSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
  before: z.string(),
  after: z.string(),
});
export type ImpactChange = z.infer<typeof ImpactChangeSchema>;

export const ImpactReportSchema = z.object({
  impactId: z.string().min(1),
  createdAt: z.string().min(1),
  runId: z.string().optional(),
  from: z.object({
    artifactId: z.string().min(1),
    version: z.number().int().min(1),
  }),
  to: z.object({
    artifactId: z.string().min(1),
    version: z.number().int().min(1),
  }),
  changes: z.array(ImpactChangeSchema).default([]),
  globals: z.array(ImpactGlobalNoteSchema).default([]),
  groundReportId: z.string().optional(),
  weaveReportId: z.string().optional(),
  items: z.array(ImpactItemSchema).default([]),
  unmapped: z.array(z.object({
    target: z.string(),
    reason: z.string(),
  })).default([]),
  method: z.enum(["llm", "heuristic", "mixed"]),
  degraded: z.object({ reason: z.string().min(1) }).optional(),
  partial: z.boolean().optional(),
  supersededBy: z.string().optional(),
});
export type ImpactReport = z.infer<typeof ImpactReportSchema>;

export const WorkflowManifestSchema = z.object({
  version: z.literal(1),
  bookId: z.string().optional(),
  draftId: z.string().optional(),
  adopted: z.object({
    ask: z.string().optional(),
    ground: z.array(z.string()).default([]),
    weave: z.string().optional(),
    write: z.record(z.string()).default({}),
  }).default({ ground: [], write: {} }),
  candidates: z.object({
    ask: z.string().optional(),
    ground: z.array(z.string()).default([]),
    weave: z.string().optional(),
    write: z.record(z.string()).default({}),
  }).default({ ground: [], write: {} }),
  coverage: z.object({
    settingsGenerated: z.number().int().min(0).default(0),
    settingsAdopted: z.number().int().min(0).default(0),
    settingsTarget: z.number().int().min(0).default(0),
    chaptersGenerated: z.number().int().min(0).default(0),
    chaptersAdopted: z.number().int().min(0).default(0),
    chaptersTarget: z.number().int().min(0).default(0),
    chaptersWrittenAdopted: z.number().int().min(0).default(0),
  }).default({}),
  watches: z.array(DependencyWatchSchema).default([]),
  impactBaseline: z.object({
    ask: z.string().optional(),
  }).optional(),
  lastRunId: z.string().optional(),
  updatedAt: z.string().min(1),
});
export type WorkflowManifest = z.infer<typeof WorkflowManifestSchema>;

export const AuthoringDraftRecordSchema = z.object({
  draftId: z.string().min(1),
  sessionId: z.string().optional(),
  bookId: z.string().optional(),
  title: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type AuthoringDraftRecord = z.infer<typeof AuthoringDraftRecordSchema>;

export const CanonDocumentSchema = z.object({
  title: z.string().min(1),
  genre: z.string().optional(),
  targetChapters: z.number().int().min(1).optional(),
  chapterWordCount: z.number().int().min(100).optional(),
  oneLine: z.string().default(""),
  proposition: z.string().default(""),
  protagonist: z.string().default(""),
  conflict: z.string().default(""),
  voice: z.string().default(""),
  boundaries: z.string().default(""),
  direction: z.string().default(""),
  openQuestions: z.array(z.string()).default([]),
});
export type CanonDocument = z.infer<typeof CanonDocumentSchema>;

export const SettingsCatalogEntrySchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  name: z.string().min(1),
  file: z.string().min(1),
  adoptedArtifactId: z.string().optional(),
  candidateArtifactId: z.string().optional(),
  archived: z.boolean().default(false),
});
export type SettingsCatalogEntry = z.infer<typeof SettingsCatalogEntrySchema>;

export const SettingsCatalogSchema = z.object({
  categories: z.array(z.string()).default([]),
  entries: z.array(SettingsCatalogEntrySchema).default([]),
});
export type SettingsCatalog = z.infer<typeof SettingsCatalogSchema>;

export interface ResolvedAuthoringRole {
  readonly roleId: AuthoringRoleId;
  readonly serviceRef: string;
  readonly modelId: string;
  readonly stream: boolean;
  readonly temperature: number;
  readonly thinkingBudget: number;
  readonly apiFormat: "chat" | "responses";
  readonly extra?: Record<string, unknown>;
  readonly instructions: string;
  readonly instructionsVersion: number;
  readonly llm: import("../models/project.js").LLMConfig;
  readonly snapshot: Record<string, unknown>;
}

export interface AuthoringLlmCall {
  readonly roleId: AuthoringRoleId;
  readonly messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>;
  readonly snapshot: Record<string, unknown>;
}

export type AuthoringLlmFn = (call: AuthoringLlmCall) => Promise<string>;
