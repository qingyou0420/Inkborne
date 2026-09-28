/**
 * Lightweight workflow index so chapter/study loads do not walk every artifact.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../utils/atomic-write.js";
import {
  AuthoringArtifactMetaSchema,
  AuthoringReviewReportSchema,
  AuthoringRunRecordSchema,
  AuthoringStageSchema,
  type AuthoringArtifactMeta,
  type AuthoringReviewReport,
  type AuthoringRunRecord,
  type AuthoringStage,
} from "./types.js";

const ReportPointerSchema = z.object({
  reportId: z.string().min(1),
  stage: AuthoringStageSchema,
  targetRefs: z.array(z.string()).default([]),
  createdAt: z.string().default(""),
  stale: z.boolean().optional(),
});

export type WorkflowReportPointer = z.infer<typeof ReportPointerSchema>;

const WorkflowIndexSchema = z.object({
  version: z.literal(1),
  artifacts: z.array(AuthoringArtifactMetaSchema).default([]),
  reports: z.array(ReportPointerSchema).default([]),
  runs: z.array(AuthoringRunRecordSchema).default([]),
});

export type WorkflowIndex = z.infer<typeof WorkflowIndexSchema>;

const queues = new Map<string, Promise<unknown>>();

function emptyIndex(): WorkflowIndex {
  return { version: 1, artifacts: [], reports: [], runs: [] };
}

function indexPath(rootDir: string): string {
  return join(rootDir, "index.json");
}

function enqueue<T>(rootDir: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(rootDir) ?? Promise.resolve();
  const run = previous.then(task, task);
  queues.set(rootDir, run.then(() => undefined, () => undefined));
  return run;
}

async function readIndex(rootDir: string): Promise<WorkflowIndex | undefined> {
  try {
    const raw = await readFile(indexPath(rootDir), "utf-8");
    if (!raw.trim()) return undefined;
    const parsed = WorkflowIndexSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function writeIndex(rootDir: string, index: WorkflowIndex): Promise<void> {
  await writeFileAtomic(indexPath(rootDir), `${JSON.stringify(index)}\n`);
}

async function readJsonFile<T>(path: string, parse: (raw: unknown) => T): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    if (!raw.trim()) return undefined;
    return parse(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

/** Directory walk used when a book has no index yet. Tests time this as the old cost. */
export async function scanWorkflowIndex(rootDir: string): Promise<WorkflowIndex> {
  const index = emptyIndex();
  const artifactsDir = join(rootDir, "artifacts");
  const reviewsDir = join(rootDir, "reviews");
  const runsDir = join(rootDir, "runs");

  const artifactIds = await readdir(artifactsDir).catch(() => [] as string[]);
  for (const id of artifactIds) {
    const meta = await readJsonFile(join(artifactsDir, id, "meta.json"), (raw) => AuthoringArtifactMetaSchema.parse(raw));
    if (meta) index.artifacts.push(meta);
  }

  const reviewFiles = await readdir(reviewsDir).catch(() => [] as string[]);
  for (const file of reviewFiles) {
    if (!file.endsWith(".json")) continue;
    const report = await readJsonFile(join(reviewsDir, file), (raw) => AuthoringReviewReportSchema.parse(raw));
    if (!report) continue;
    index.reports.push(pointerFromReport(report));
  }

  const runFiles = await readdir(runsDir).catch(() => [] as string[]);
  for (const file of runFiles) {
    if (!file.endsWith(".json") || file.endsWith(".control.json")) continue;
    const run = await readJsonFile(join(runsDir, file), (raw) => AuthoringRunRecordSchema.parse(raw));
    if (run) index.runs.push(run);
  }

  return index;
}

function pointerFromReport(report: AuthoringReviewReport): WorkflowReportPointer {
  return {
    reportId: report.reportId,
    stage: report.stage,
    targetRefs: [...report.targetRefs],
    createdAt: report.createdAt,
    ...(report.stale ? { stale: true } : {}),
  };
}

export async function loadWorkflowIndex(rootDir: string): Promise<WorkflowIndex> {
  const existing = await readIndex(rootDir);
  if (existing) return existing;
  return scanWorkflowIndex(rootDir);
}

export async function ensureWorkflowIndex(rootDir: string): Promise<WorkflowIndex> {
  const existing = await readIndex(rootDir);
  if (existing) return existing;
  return enqueue(rootDir, async () => {
    const again = await readIndex(rootDir);
    if (again) return again;
    const scanned = await scanWorkflowIndex(rootDir);
    await writeIndex(rootDir, scanned);
    return scanned;
  });
}

async function mutateIndex(rootDir: string, mutate: (index: WorkflowIndex) => void): Promise<void> {
  await enqueue(rootDir, async () => {
    let index = await readIndex(rootDir);
    if (!index) index = await scanWorkflowIndex(rootDir);
    mutate(index);
    await writeIndex(rootDir, index);
  });
}

export async function noteWorkflowArtifact(rootDir: string, meta: AuthoringArtifactMeta): Promise<void> {
  const parsed = AuthoringArtifactMetaSchema.parse(meta);
  await mutateIndex(rootDir, (index) => {
    const at = index.artifacts.findIndex((item) => item.artifactId === parsed.artifactId);
    if (at >= 0) index.artifacts[at] = parsed;
    else index.artifacts.push(parsed);
  });
}

export async function noteWorkflowReport(rootDir: string, report: AuthoringReviewReport): Promise<void> {
  const pointer = pointerFromReport(report);
  await mutateIndex(rootDir, (index) => {
    const at = index.reports.findIndex((item) => item.reportId === pointer.reportId);
    if (at >= 0) index.reports[at] = pointer;
    else index.reports.push(pointer);
  });
}

export async function noteWorkflowRun(rootDir: string, run: AuthoringRunRecord): Promise<void> {
  const parsed = AuthoringRunRecordSchema.parse(run);
  await mutateIndex(rootDir, (index) => {
    const at = index.runs.findIndex((item) => item.runId === parsed.runId);
    if (at >= 0) index.runs[at] = parsed;
    else index.runs.push(parsed);
  });
}

export function filterWorkflowArtifacts(
  index: WorkflowIndex,
  filter: { readonly stage?: AuthoringStage; readonly scope?: string },
): AuthoringArtifactMeta[] {
  return index.artifacts
    .filter((item) => (filter.stage ? item.stage === filter.stage : true))
    .filter((item) => (filter.scope ? item.scope === filter.scope : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
