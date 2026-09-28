/**
 * Persist authoring artifacts, reports, runs, and workflow manifest.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { quarantineCorruptFile } from "../utils/quarantine-corrupt.js";
import { z } from "zod";
import {
  ensureWorkflowIndex,
  filterWorkflowArtifacts,
  noteWorkflowArtifact,
  noteWorkflowReport,
  noteWorkflowRun,
  type WorkflowIndex,
} from "./workflow-index.js";
import {
  AuthoringArtifactMetaSchema,
  AuthoringReviewReportSchema,
  AuthoringRunRecordSchema,
  SettingsCatalogSchema,
  WorkflowManifestSchema,
  type AuthoringArtifactMeta,
  type AuthoringReviewReport,
  type AuthoringRunRecord,
  type AuthoringStage,
  type SettingsCatalog,
  type WorkflowManifest,
} from "./types.js";

export interface AuthoringStoreRoot {
  readonly projectRoot: string;
  readonly bookId?: string;
  readonly draftId?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string, parse: (raw: unknown) => T): Promise<T | undefined> {
  if (!(await exists(path))) return undefined;
  const raw = await readFile(path, "utf-8");
  if (!raw.trim()) return undefined;
  return parse(JSON.parse(raw) as unknown);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function renderManifest(manifest: z.input<typeof WorkflowManifestSchema> | WorkflowManifest): string {
  return `${JSON.stringify(WorkflowManifestSchema.parse({ ...manifest, updatedAt: nowIso() }), null, 2)}\n`;
}

export function authoringRootDir(root: AuthoringStoreRoot): string {
  if (root.bookId) {
    return join(root.projectRoot, "books", root.bookId, "story", "workflow");
  }
  const draftId = root.draftId ?? "untitled";
  return join(root.projectRoot, ".inkos", "authoring-drafts", draftId, "workflow");
}

export function bookStoryDir(root: AuthoringStoreRoot): string | undefined {
  if (!root.bookId) return undefined;
  return join(root.projectRoot, "books", root.bookId, "story");
}

export function emptyManifest(root: AuthoringStoreRoot): WorkflowManifest {
  return WorkflowManifestSchema.parse({
    version: 1,
    bookId: root.bookId,
    draftId: root.draftId,
    adopted: { ground: [], write: {} },
    candidates: { ground: [], write: {} },
    coverage: {},
    watches: [],
    updatedAt: nowIso(),
  });
}

function newerArtifact(left: AuthoringArtifactMeta, right: AuthoringArtifactMeta): AuthoringArtifactMeta {
  if (left.version !== right.version) return left.version > right.version ? left : right;
  return left.createdAt >= right.createdAt ? left : right;
}

function pickNewest(items: readonly AuthoringArtifactMeta[]): AuthoringArtifactMeta | undefined {
  return items.reduce<AuthoringArtifactMeta | undefined>((best, item) => (
    best ? newerArtifact(best, item) : item
  ), undefined);
}

/** Rebuild the workflow ledger from artifact meta when manifest.json cannot be parsed. */
export async function rebuildManifestFromArtifacts(root: AuthoringStoreRoot): Promise<WorkflowManifest> {
  const artifactsDir = join(authoringRootDir(root), "artifacts");
  const ids = await readdir(artifactsDir).catch(() => [] as string[]);
  const metas: AuthoringArtifactMeta[] = [];
  for (const id of ids) {
    const meta = await readJson(
      join(artifactsDir, id, "meta.json"),
      (raw) => AuthoringArtifactMetaSchema.parse(raw),
    ).catch(() => undefined);
    if (meta) metas.push(meta);
  }
  const ask = metas.filter((item) => item.stage === "ask");
  const weave = metas.filter((item) => item.stage === "weave");
  const groundAdopted = metas.filter((item) => item.stage === "ground" && item.status === "adopted").map((item) => item.artifactId);
  const groundCandidates = metas
    .filter((item) => item.stage === "ground" && (item.status === "candidate" || item.status === "draft"))
    .map((item) => item.artifactId);
  const adoptedAsk = pickNewest(ask.filter((item) => item.status === "adopted"));
  const candidateAsk = pickNewest(ask.filter((item) => item.status === "candidate" || item.status === "draft")) ?? pickNewest(ask);
  const adoptedWeave = pickNewest(weave.filter((item) => item.status === "adopted"));
  const candidateWeave = pickNewest(weave.filter((item) => item.status === "candidate" || item.status === "draft")) ?? pickNewest(weave);
  const adoptedWrite: Record<string, string> = {};
  const candidateWrite: Record<string, string> = {};
  const byChapter = new Map<string, AuthoringArtifactMeta[]>();
  for (const meta of metas) {
    if (meta.stage !== "write") continue;
    const match = /^chapter:(\d+)$/.exec(meta.scope);
    if (!match?.[1]) continue;
    const list = byChapter.get(match[1]) ?? [];
    list.push(meta);
    byChapter.set(match[1], list);
  }
  for (const [chapter, items] of byChapter) {
    const adopted = pickNewest(items.filter((item) => item.status === "adopted"));
    const candidate = pickNewest(items.filter((item) => item.status === "candidate" || item.status === "draft"))
      ?? pickNewest(items.filter((item) => item.status !== "archived"))
      ?? pickNewest(items);
    if (adopted) adoptedWrite[chapter] = adopted.artifactId;
    if (candidate) candidateWrite[chapter] = candidate.artifactId;
  }
  return WorkflowManifestSchema.parse({
    ...emptyManifest(root),
    adopted: {
      ...(adoptedAsk ? { ask: adoptedAsk.artifactId } : {}),
      ground: groundAdopted,
      ...(adoptedWeave ? { weave: adoptedWeave.artifactId } : {}),
      write: adoptedWrite,
    },
    candidates: {
      ...(candidateAsk ? { ask: candidateAsk.artifactId } : {}),
      ground: groundCandidates,
      ...(candidateWeave ? { weave: candidateWeave.artifactId } : {}),
      write: candidateWrite,
    },
    coverage: {
      settingsAdopted: groundAdopted.length,
      chaptersWrittenAdopted: Object.keys(adoptedWrite).length,
    },
  });
}

export async function loadManifest(root: AuthoringStoreRoot): Promise<WorkflowManifest> {
  const path = join(authoringRootDir(root), "manifest.json");
  if (!(await exists(path))) return emptyManifest(root);
  try {
    const raw = await readFile(path, "utf-8");
    if (!raw.trim()) return emptyManifest(root);
    return WorkflowManifestSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    await quarantineCorruptFile(path).catch(() => undefined);
    const rebuilt = await rebuildManifestFromArtifacts(root);
    await saveManifest(root, rebuilt);
    return rebuilt;
  }
}

export async function saveManifest(root: AuthoringStoreRoot, manifest: z.input<typeof WorkflowManifestSchema> | WorkflowManifest): Promise<void> {
  await writeFileAtomic(join(authoringRootDir(root), "manifest.json"), renderManifest(manifest));
}

export async function saveRun(root: AuthoringStoreRoot, run: z.input<typeof AuthoringRunRecordSchema> | AuthoringRunRecord): Promise<void> {
  const parsed = AuthoringRunRecordSchema.parse({ ...run, updatedAt: nowIso() });
  const rootDir = authoringRootDir(root);
  await writeFileAtomic(
    join(rootDir, "runs", `${parsed.runId}.json`),
    `${JSON.stringify(parsed, null, 2)}\n`,
  );
  await noteWorkflowRun(rootDir, parsed);
}

export async function loadRun(root: AuthoringStoreRoot, runId: string): Promise<AuthoringRunRecord | undefined> {
  return readJson(join(authoringRootDir(root), "runs", `${runId}.json`), (raw) => AuthoringRunRecordSchema.parse(raw));
}

export async function listRuns(root: AuthoringStoreRoot): Promise<AuthoringRunRecord[]> {
  const index = await ensureWorkflowIndex(authoringRootDir(root));
  return [...index.runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export type AuthoringRunControl = "none" | "pause" | "cancel";

export async function saveRunControl(
  root: AuthoringStoreRoot,
  runId: string,
  action: AuthoringRunControl,
): Promise<void> {
  await writeFileAtomic(
    join(authoringRootDir(root), "runs", `${runId}.control.json`),
    `${JSON.stringify({ action, updatedAt: nowIso() }, null, 2)}\n`,
  );
}

export async function loadRunControl(root: AuthoringStoreRoot, runId: string): Promise<AuthoringRunControl> {
  const raw = await readJson(
    join(authoringRootDir(root), "runs", `${runId}.control.json`),
    (value) => value as { action?: string },
  );
  if (raw?.action === "pause" || raw?.action === "cancel") return raw.action;
  return "none";
}

export function newRunId(): string {
  return randomUUID();
}

export function newArtifactId(stage: AuthoringStage, scope: string): string {
  const safe = scope.replace(/[^\w\u4e00-\u9fff-]+/g, "-").slice(0, 40) || "item";
  return `${stage}-${safe}-${randomUUID().slice(0, 8)}`;
}

export async function saveArtifact(
  root: AuthoringStoreRoot,
  meta: AuthoringArtifactMeta,
  body: string,
): Promise<AuthoringArtifactMeta> {
  const parsed = AuthoringArtifactMetaSchema.parse(meta);
  const dir = join(authoringRootDir(root), "artifacts", parsed.artifactId);
  await commitAtomicFileSet({
    rootDir: dir,
    writes: [
      { relativePath: "body.md", content: body.endsWith("\n") ? body : `${body}\n` },
      { relativePath: "meta.json", content: `${JSON.stringify(parsed, null, 2)}\n` },
    ],
  });
  await noteWorkflowArtifact(authoringRootDir(root), parsed);
  return parsed;
}

export async function loadArtifact(
  root: AuthoringStoreRoot,
  artifactId: string,
): Promise<{ meta: AuthoringArtifactMeta; body: string } | undefined> {
  const dir = join(authoringRootDir(root), "artifacts", artifactId);
  const meta = await readJson(join(dir, "meta.json"), (raw) => AuthoringArtifactMetaSchema.parse(raw));
  if (!meta) return undefined;
  const body = await readFile(join(dir, "body.md"), "utf-8").catch(() => "");
  return { meta, body };
}

export async function listArtifacts(root: AuthoringStoreRoot, stage?: AuthoringStage): Promise<AuthoringArtifactMeta[]> {
  const index = await ensureWorkflowIndex(authoringRootDir(root));
  return filterWorkflowArtifacts(index, stage ? { stage } : {});
}

export async function saveReport(root: AuthoringStoreRoot, report: z.input<typeof AuthoringReviewReportSchema> | AuthoringReviewReport): Promise<void> {
  const parsed = AuthoringReviewReportSchema.parse(report);
  const rootDir = authoringRootDir(root);
  await writeFileAtomic(
    join(rootDir, "reviews", `${parsed.reportId}.json`),
    `${JSON.stringify(parsed, null, 2)}\n`,
  );
  await noteWorkflowReport(rootDir, parsed);
}

export async function loadReport(root: AuthoringStoreRoot, reportId: string): Promise<AuthoringReviewReport | undefined> {
  return readJson(join(authoringRootDir(root), "reviews", `${reportId}.json`), (raw) => AuthoringReviewReportSchema.parse(raw));
}

export async function listReports(root: AuthoringStoreRoot, stage?: AuthoringStage): Promise<AuthoringReviewReport[]> {
  const index = await ensureWorkflowIndex(authoringRootDir(root));
  return loadIndexedReports(root, index, (report) => (stage ? report.stage === stage : true));
}

async function loadIndexedReports(
  root: AuthoringStoreRoot,
  index: WorkflowIndex,
  include: (report: WorkflowIndex["reports"][number]) => boolean,
): Promise<AuthoringReviewReport[]> {
  const selected = index.reports.filter(include);
  const items = await Promise.all(selected.map((report) => loadReport(root, report.reportId)));
  return items
    .filter((report): report is AuthoringReviewReport => Boolean(report))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadAuthoringWorkspaceLists(
  root: AuthoringStoreRoot,
  query: {
    readonly chapter?: number;
    readonly stage?: AuthoringStage;
    readonly summary?: boolean;
  } = {},
): Promise<{
  readonly artifacts: AuthoringArtifactMeta[];
  readonly reports: AuthoringReviewReport[];
  readonly runs: AuthoringRunRecord[];
}> {
  const index = await ensureWorkflowIndex(authoringRootDir(root));
  const sortedRuns = () => index.runs.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (query.summary) {
    return { artifacts: [], reports: [], runs: sortedRuns() };
  }
  const chapter = query.chapter;
  const scopedChapter = Number.isInteger(chapter) && (chapter ?? 0) > 0;
  const artifacts = filterWorkflowArtifacts(index, scopedChapter
    ? { stage: "write", scope: `chapter:${chapter}` }
    : query.stage
      ? { stage: query.stage }
      : {});
  const ids = new Set(artifacts.map((item) => item.artifactId));
  const reports = await loadIndexedReports(root, index, (report) => {
    if (scopedChapter) return report.targetRefs.some((id) => ids.has(id));
    if (query.stage) return report.stage === query.stage;
    return true;
  });
  const runs = (scopedChapter
    ? index.runs.filter((run) => run.scope === `chapter:${chapter}` || run.producedArtifactIds.some((id) => ids.has(id)))
    : query.stage
      ? index.runs.filter((run) => run.stage === query.stage)
      : index.runs
  ).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { artifacts, reports, runs };
}

export function reportAppliesTo(report: AuthoringReviewReport, artifactId: string): boolean {
  return report.targetRefs.includes(artifactId);
}

async function markBoundReportsStale(
  root: AuthoringStoreRoot,
  artifactId: string,
  reason: string,
): Promise<void> {
  const index = await ensureWorkflowIndex(authoringRootDir(root));
  const matches = index.reports.filter((report) => !report.stale && report.targetRefs.includes(artifactId));
  for (const pointer of matches) {
    const report = await loadReport(root, pointer.reportId);
    if (!report || report.stale || !report.targetRefs.includes(artifactId)) continue;
    await saveReport(root, { ...report, stale: true, staleReason: reason });
  }
}

export async function markReportsStale(
  root: AuthoringStoreRoot,
  targetRef: string,
  reason: string,
): Promise<void> {
  const index = await ensureWorkflowIndex(authoringRootDir(root));
  const target = index.artifacts.find((item) => item.artifactId === targetRef);
  if (!target) return;
  const candidates = index.reports.filter((report) => !report.stale && !report.targetRefs.includes(targetRef));
  for (const pointer of candidates) {
    const sameScope = pointer.targetRefs.some((ref) => {
      const loaded = index.artifacts.find((item) => item.artifactId === ref);
      return loaded?.scope === target.scope && loaded.stage === target.stage;
    });
    if (!sameScope) continue;
    const report = await loadReport(root, pointer.reportId);
    if (!report || report.stale || report.targetRefs.includes(targetRef)) continue;
    await saveReport(root, { ...report, stale: true, staleReason: reason });
  }
}

export async function saveHandEditedArtifact(
  root: AuthoringStoreRoot,
  artifactId: string,
  body: string,
): Promise<AuthoringArtifactMeta> {
  const loaded = await loadArtifact(root, artifactId);
  if (!loaded) throw new Error("找不到要保存的稿件。");
  if (
    loaded.meta.stage === "write"
    && loaded.meta.source === "hand"
    && loaded.meta.status === "candidate"
  ) {
    await markBoundReportsStale(root, loaded.meta.artifactId, "手改覆盖了这份候选，原审查报告已过期。");
    return saveArtifact(root, loaded.meta, body);
  }
  const nextId = newArtifactId(loaded.meta.stage, loaded.meta.scope);
  const version = loaded.meta.version + 1;
  const meta = await saveArtifact(root, {
    ...loaded.meta,
    artifactId: nextId,
    version,
    parentVersion: loaded.meta.version,
    parentArtifactId: loaded.meta.artifactId,
    source: "hand",
    status: "candidate",
    createdAt: nowIso(),
    label: `${loaded.meta.label ?? loaded.meta.scope} v${version}`,
  }, body);
  const manifest = await loadManifest(root);
  if (loaded.meta.stage === "ask") {
    await saveManifest(root, { ...manifest, candidates: { ...manifest.candidates, ask: nextId } });
  } else if (loaded.meta.stage === "weave") {
    await saveManifest(root, { ...manifest, candidates: { ...manifest.candidates, weave: nextId } });
  } else if (loaded.meta.stage === "write") {
    const chapter = loaded.meta.scope.replace("chapter:", "");
    await saveManifest(root, {
      ...manifest,
      candidates: { ...manifest.candidates, write: { ...manifest.candidates.write, [chapter]: nextId } },
    });
  } else if (loaded.meta.stage === "ground") {
    const catalog = await loadSettingsCatalog(root).catch(() => undefined);
    if (catalog) {
      const entry = catalog.entries.find((item) => item.id === loaded.meta.scope);
      if (entry) {
        entry.candidateArtifactId = nextId;
        await saveSettingsCatalog(root, catalog);
      }
    }
  }
  return meta;
}

export async function loadSettingsCatalog(root: AuthoringStoreRoot): Promise<SettingsCatalog> {
  const story = bookStoryDir(root);
  if (!story) return SettingsCatalogSchema.parse({ categories: [], entries: [] });
  return (await readJson(join(story, "settings", "index.json"), (raw) => SettingsCatalogSchema.parse(raw)))
    ?? SettingsCatalogSchema.parse({ categories: [], entries: [] });
}

export async function saveSettingsCatalog(root: AuthoringStoreRoot, catalog: SettingsCatalog): Promise<void> {
  const story = bookStoryDir(root);
  if (!story) throw new Error("设定目录只能写在已建书的项目里。");
  await writeFileAtomic(
    join(story, "settings", "index.json"),
    `${JSON.stringify(SettingsCatalogSchema.parse(catalog), null, 2)}\n`,
  );
}

export async function adoptFiles(input: {
  readonly bookDir: string;
  readonly writes: ReadonlyArray<{ relativePath: string; content: string }>;
}): Promise<void> {
  await commitAtomicFileSet({
    rootDir: input.bookDir,
    writes: input.writes,
  });
}

export { writeJson, exists };
