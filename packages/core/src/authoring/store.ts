/**
 * Persist authoring artifacts, reports, runs, and workflow manifest.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { z } from "zod";
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
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

export async function loadManifest(root: AuthoringStoreRoot): Promise<WorkflowManifest> {
  const path = join(authoringRootDir(root), "manifest.json");
  return (await readJson(path, (raw) => WorkflowManifestSchema.parse(raw))) ?? emptyManifest(root);
}

export async function saveManifest(root: AuthoringStoreRoot, manifest: z.input<typeof WorkflowManifestSchema> | WorkflowManifest): Promise<void> {
  const dir = authoringRootDir(root);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify(WorkflowManifestSchema.parse({ ...manifest, updatedAt: nowIso() }), null, 2)}\n`,
    "utf-8",
  );
}

export async function saveRun(root: AuthoringStoreRoot, run: z.input<typeof AuthoringRunRecordSchema> | AuthoringRunRecord): Promise<void> {
  const dir = join(authoringRootDir(root), "runs");
  await mkdir(dir, { recursive: true });
  const parsed = AuthoringRunRecordSchema.parse({ ...run, updatedAt: nowIso() });
  await writeFile(join(dir, `${parsed.runId}.json`), `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

export async function loadRun(root: AuthoringStoreRoot, runId: string): Promise<AuthoringRunRecord | undefined> {
  return readJson(join(authoringRootDir(root), "runs", `${runId}.json`), (raw) => AuthoringRunRecordSchema.parse(raw));
}

export async function listRuns(root: AuthoringStoreRoot): Promise<AuthoringRunRecord[]> {
  const dir = join(authoringRootDir(root), "runs");
  if (!(await exists(dir))) return [];
  const files = await readdir(dir);
  const items: AuthoringRunRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".control.json")) continue;
    const run = await readJson(join(dir, file), (raw) => AuthoringRunRecordSchema.parse(raw));
    if (run) items.push(run);
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export type AuthoringRunControl = "none" | "pause" | "cancel";

export async function saveRunControl(
  root: AuthoringStoreRoot,
  runId: string,
  action: AuthoringRunControl,
): Promise<void> {
  const path = join(authoringRootDir(root), "runs", `${runId}.control.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ action, updatedAt: nowIso() }, null, 2)}\n`, "utf-8");
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
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "body.md"), body.endsWith("\n") ? body : `${body}\n`, "utf-8");
  await writeFile(join(dir, "meta.json"), `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
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
  const dir = join(authoringRootDir(root), "artifacts");
  if (!(await exists(dir))) return [];
  const ids = await readdir(dir);
  const items: AuthoringArtifactMeta[] = [];
  for (const id of ids) {
    const meta = await readJson(join(dir, id, "meta.json"), (raw) => AuthoringArtifactMetaSchema.parse(raw));
    if (!meta) continue;
    if (stage && meta.stage !== stage) continue;
    items.push(meta);
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function saveReport(root: AuthoringStoreRoot, report: z.input<typeof AuthoringReviewReportSchema> | AuthoringReviewReport): Promise<void> {
  const dir = join(authoringRootDir(root), "reviews");
  await mkdir(dir, { recursive: true });
  const parsed = AuthoringReviewReportSchema.parse(report);
  await writeFile(join(dir, `${parsed.reportId}.json`), `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

export async function loadReport(root: AuthoringStoreRoot, reportId: string): Promise<AuthoringReviewReport | undefined> {
  return readJson(join(authoringRootDir(root), "reviews", `${reportId}.json`), (raw) => AuthoringReviewReportSchema.parse(raw));
}

export async function listReports(root: AuthoringStoreRoot, stage?: AuthoringStage): Promise<AuthoringReviewReport[]> {
  const dir = join(authoringRootDir(root), "reviews");
  if (!(await exists(dir))) return [];
  const files = await readdir(dir);
  const items: AuthoringReviewReport[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const report = await readJson(join(dir, file), (raw) => AuthoringReviewReportSchema.parse(raw));
    if (!report) continue;
    if (stage && report.stage !== stage) continue;
    items.push(report);
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function reportAppliesTo(report: AuthoringReviewReport, artifactId: string): boolean {
  return report.targetRefs.includes(artifactId);
}

export async function markReportsStale(
  root: AuthoringStoreRoot,
  targetRef: string,
  reason: string,
): Promise<void> {
  const reports = await listReports(root);
  const target = await loadArtifact(root, targetRef);
  for (const report of reports) {
    if (report.stale) continue;
    if (report.targetRefs.includes(targetRef)) continue;
    if (!target) continue;
    let sameScope = false;
    for (const ref of report.targetRefs) {
      const loaded = await loadArtifact(root, ref);
      if (loaded?.meta.scope === target.meta.scope && loaded.meta.stage === target.meta.stage) {
        sameScope = true;
        break;
      }
    }
    if (!sameScope) continue;
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
  const dir = join(story, "settings");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.json"), `${JSON.stringify(SettingsCatalogSchema.parse(catalog), null, 2)}\n`, "utf-8");
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
