/**
 * 研墨: catalog + setting entries, scoped generate/review/adopt.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assembleAuthoringContext, loadCanonDocument, serializeCanonBrief } from "../context.js";
import { asString, asStringArray, extractJsonObject } from "../json.js";
import { completeRole } from "../llm.js";
import { fillMissingAuthoringRoles, loadRoleApiKeys, resolveAuthoringRole } from "../model-config.js";
import { assertReportReusable, parseReviewPayload, reviewPrompt } from "../review.js";
import {
  loadArtifact,
  loadManifest,
  loadReport,
  loadSettingsCatalog,
  newArtifactId,
  newRunId,
  saveArtifact,
  saveManifest,
  saveReport,
  saveRun,
  saveSettingsCatalog,
  type AuthoringStoreRoot,
} from "../store.js";
import type { AuthoringLlmFn, AuthoringReviewReport, SettingsCatalog, SettingsCatalogEntry } from "../types.js";
import type { ProjectConfig } from "../../models/project.js";

const DEFAULT_CATEGORIES = ["世界与时代", "人物", "关系与势力", "地点", "规则与物品", "历史与其他"];

export interface GroundRuntime {
  readonly root: AuthoringStoreRoot;
  readonly project: ProjectConfig;
  readonly llm?: AuthoringLlmFn;
}

async function resolve(project: ProjectConfig, role: "ground.main" | "ground.review", projectRoot?: string) {
  return resolveAuthoringRole({
    roleId: role,
    baseLlm: project.llm,
    roles: fillMissingAuthoringRoles(project),
    apiKeys: projectRoot ? await loadRoleApiKeys(projectRoot) : undefined,
  });
}

function slug(name: string): string {
  return name.replace(/[^\w\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "item";
}

function uniqueCatalogToken(base: string, reserved: Set<string>): string {
  const seed = base || "item";
  if (!reserved.has(seed)) return seed;
  let n = 2;
  while (reserved.has(`${seed}-${n}`)) n += 1;
  return `${seed}-${n}`;
}

function normalizeCatalogFileKey(file: string): string {
  return file.replace(/\\/g, "/").replace(/\/+/g, "/").normalize("NFC").toLowerCase();
}

function uniqueCatalogFile(preferred: string, reservedKeys: Set<string>): string {
  const posix = preferred.replace(/\\/g, "/");
  const lastSlash = posix.lastIndexOf("/");
  const dir = lastSlash >= 0 ? posix.slice(0, lastSlash + 1) : "";
  const base = lastSlash >= 0 ? posix.slice(lastSlash + 1) : posix;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let n = 2;
  let candidate = posix;
  while (reservedKeys.has(normalizeCatalogFileKey(candidate))) {
    candidate = `${dir}${stem}-${n}${ext}`;
    n += 1;
  }
  return candidate;
}

function fileForEntry(entry: Pick<SettingsCatalogEntry, "category" | "name" | "id">): string {
  return entry.category === "人物"
    ? `story/roles/主要角色/${slug(entry.name)}.md`
    : `story/settings/${entry.id}.md`;
}

function mergeCatalogIdentities(
  proposed: readonly SettingsCatalogEntry[],
  existing: SettingsCatalog,
): SettingsCatalogEntry[] {
  const unused = [...existing.entries];
  const reservedIds = new Set(existing.entries.map((entry) => entry.id));
  const reservedFileKeys = new Set(existing.entries.map((entry) => normalizeCatalogFileKey(entry.file)));
  const takePrior = (match: (entry: SettingsCatalogEntry) => boolean): SettingsCatalogEntry | undefined => {
    const index = unused.findIndex(match);
    if (index < 0) return undefined;
    return unused.splice(index, 1)[0];
  };
  const merged: SettingsCatalogEntry[] = [];
  for (const entry of proposed) {
    const prior = takePrior((item) => item.category === entry.category && item.name === entry.name);
    if (prior) {
      merged.push({
        ...entry,
        id: prior.id,
        file: prior.file || entry.file,
        adoptedArtifactId: prior.adoptedArtifactId,
        candidateArtifactId: prior.candidateArtifactId,
        archived: prior.archived,
      });
      continue;
    }
    const id = reservedIds.has(entry.id) ? uniqueCatalogToken(entry.id, reservedIds) : entry.id;
    reservedIds.add(id);
    const file = uniqueCatalogFile(fileForEntry({ ...entry, id }), reservedFileKeys);
    reservedFileKeys.add(normalizeCatalogFileKey(file));
    merged.push({ ...entry, id, file, archived: false });
  }
  for (const prior of unused) {
    if (prior.archived || prior.adoptedArtifactId || prior.candidateArtifactId) merged.push(prior);
  }
  return merged;
}

export async function proposeSettingsCatalog(input: GroundRuntime): Promise<SettingsCatalog> {
  if (!input.root.bookId) throw new Error("研墨需要先采用正典并建书。");
  const existing = await loadSettingsCatalog(input.root);
  const { canon } = await loadCanonDocument(input.root);
  const resolved = await resolve(input.project, "ground.main", input.root.projectRoot);
  const text = await completeRole(resolved, [
    "根据正典拟定本书设定目录。只输出 JSON：{ categories: string[], entries: [{ id, category, name }] }。",
    "现实题材不要出现修炼体系。目录按小说需要增减。",
    serializeCanonBrief(canon),
  ].join("\n"), input.llm);
  const json = extractJsonObject(text);
  const categories = asStringArray(json.categories);
  const entriesRaw = Array.isArray(json.entries) ? json.entries : [];
  if (entriesRaw.length === 0) {
    throw new Error("设定目录结果不完整，已保留现有目录。");
  }
  const proposed: SettingsCatalogEntry[] = entriesRaw.map((item, index) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const name = asString(row.name) || `条目${index + 1}`;
    const category = asString(row.category) || categories[0] || existing.categories[0] || DEFAULT_CATEGORIES[0]!;
    const id = asString(row.id) || `${slug(category)}-${slug(name)}`;
    const file = category === "人物"
      ? `story/roles/主要角色/${slug(name)}.md`
      : `story/settings/${id}.md`;
    return { id, category, name, file, archived: false };
  });
  const catalog = {
    categories: categories.length ? categories : (existing.categories.length ? existing.categories : DEFAULT_CATEGORIES),
    entries: mergeCatalogIdentities(proposed, existing),
  };
  await saveSettingsCatalog(input.root, catalog);
  return catalog;
}

export async function generateGroundEntries(input: GroundRuntime & {
  readonly entryIds?: readonly string[];
  readonly regenerate?: boolean;
}): Promise<{ generated: string[]; failed: string[]; runId: string }> {
  if (!input.root.bookId) throw new Error("研墨需要已建的书。");
  const catalog = await loadSettingsCatalog(input.root);
  const targets = catalog.entries.filter((entry) => {
    if (entry.archived) return false;
    if (input.entryIds?.length) return input.entryIds.includes(entry.id);
    if (input.regenerate) return true;
    return !entry.adoptedArtifactId && !entry.candidateArtifactId;
  });
  const resolved = await resolve(input.project, "ground.main", input.root.projectRoot);
  const { canon } = await loadCanonDocument(input.root);
  const runId = newRunId();
  const generated: string[] = [];
  const failed: string[] = [];
  await saveRun(input.root, {
    runId,
    stage: "ground",
    operation: "generate",
    roleId: "ground.main",
    status: "running",
    bookId: input.root.bookId,
    progressDone: 0,
    progressTotal: targets.length,
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  for (const entry of targets) {
    try {
      const text = await completeRole(resolved, [
        `撰写设定条目「${entry.name}」（分类：${entry.category}）。输出 Markdown 正文，不要 JSON。`,
        serializeCanonBrief(canon),
        "只写这一条，不要改其他条目。",
      ].join("\n"), input.llm);
      const artifactId = newArtifactId("ground", entry.id);
      await saveArtifact(input.root, {
        artifactId,
        stage: "ground",
        scope: entry.id,
        version: 1,
        source: "generate",
        status: "candidate",
        bodyPath: entry.file,
        inputRefs: [{ kind: "canon", id: "canon" }],
        createdAt: new Date().toISOString(),
        runId,
        label: entry.name,
      }, text);
      entry.candidateArtifactId = artifactId;
      generated.push(entry.id);
    } catch (error) {
      failed.push(entry.id);
      void error;
    }
    await saveRun(input.root, {
      runId,
      stage: "ground",
      operation: "generate",
      roleId: "ground.main",
      status: failed.length && generated.length + failed.length >= targets.length
        ? (generated.length ? "partial" : "failed")
        : (generated.length + failed.length >= targets.length ? "completed" : "running"),
      bookId: input.root.bookId,
      progressDone: generated.length + failed.length,
      progressTotal: targets.length,
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: generated,
      error: failed.length ? `失败条目：${failed.join("、")}` : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  await saveSettingsCatalog(input.root, catalog);
  const manifest = await loadManifest(input.root);
  await saveManifest(input.root, {
    ...manifest,
    coverage: {
      ...manifest.coverage,
      settingsGenerated: catalog.entries.filter((entry) => entry.candidateArtifactId || entry.adoptedArtifactId).length,
      settingsAdopted: catalog.entries.filter((entry) => entry.adoptedArtifactId).length,
      settingsTarget: catalog.entries.filter((entry) => !entry.archived).length,
    },
    lastRunId: runId,
  });
  return { generated, failed, runId };
}

export async function reviewGroundEntries(input: GroundRuntime & {
  readonly entryIds: readonly string[];
}): Promise<AuthoringReviewReport> {
  const catalog = await loadSettingsCatalog(input.root);
  const chunks: string[] = [];
  const refs: string[] = [];
  for (const id of input.entryIds) {
    const entry = catalog.entries.find((item) => item.id === id);
    const artifactId = entry?.candidateArtifactId ?? entry?.adoptedArtifactId;
    if (!artifactId) continue;
    const loaded = await loadArtifact(input.root, artifactId);
    if (!loaded) continue;
    refs.push(artifactId);
    chunks.push(`# id:${entry?.id} name:${entry?.name}\n${loaded.body}`);
  }
  if (chunks.length === 0) throw new Error("没有可审查的设定条目。");
  const resolved = await resolve(input.project, "ground.review", input.root.projectRoot);
  const ctx = await assembleAuthoringContext(input.root, { stage: "ground" });
  const text = await completeRole(
    resolved,
    reviewPrompt("ground", `${chunks.length} 项设定`, chunks.join("\n\n"), `${ctx.text}\n\ntarget 必须填写条目 id。`),
    input.llm,
  );
  const report = parseReviewPayload(text, {
    stage: "ground",
    targetRefs: refs,
    coverage: `所选 ${chunks.length} 项设定`,
    model: resolved.modelId,
    inputRefs: refs.map((id) => ({ kind: "artifact", id })).concat(ctx.refs),
  });
  await saveReport(input.root, report);
  return report;
}

export async function adoptGroundEntries(input: GroundRuntime & {
  readonly entryIds: readonly string[];
}): Promise<{ adopted: string[] }> {
  if (!input.root.bookId) throw new Error("研墨采用需要已建的书。");
  const catalog = await loadSettingsCatalog(input.root);
  const bookDir = join(input.root.projectRoot, "books", input.root.bookId);
  const adopted: string[] = [];
  for (const id of input.entryIds) {
    const entry = catalog.entries.find((item) => item.id === id);
    if (!entry?.candidateArtifactId) continue;
    const loaded = await loadArtifact(input.root, entry.candidateArtifactId);
    if (!loaded) continue;
    const dest = join(bookDir, entry.file);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, loaded.body.endsWith("\n") ? loaded.body : `${loaded.body}\n`, "utf-8");
    await saveArtifact(input.root, { ...loaded.meta, status: "adopted" }, loaded.body);
    entry.adoptedArtifactId = entry.candidateArtifactId;
    adopted.push(id);
  }
  await saveSettingsCatalog(input.root, catalog);
  const manifest = await loadManifest(input.root);
  await saveManifest(input.root, {
    ...manifest,
    adopted: {
      ...manifest.adopted,
      ground: catalog.entries.map((entry) => entry.adoptedArtifactId).filter((id): id is string => Boolean(id)),
    },
    coverage: {
      ...manifest.coverage,
      settingsAdopted: catalog.entries.filter((entry) => entry.adoptedArtifactId).length,
      settingsTarget: catalog.entries.filter((entry) => !entry.archived).length,
    },
  });
  return { adopted };
}

export async function reviseGroundEntry(input: GroundRuntime & {
  readonly entryId?: string;
  readonly reportId: string;
  readonly selectedIssueIds: readonly string[];
  readonly reuseStale?: boolean;
}): Promise<{ artifactIds: string[]; entryIds: string[] }> {
  const catalog = await loadSettingsCatalog(input.root);
  const report = await loadReport(input.root, input.reportId);
  if (!report) throw new Error("修订需要条目和报告。");
  const selected = report.issues.filter((issue) => input.selectedIssueIds.includes(issue.issueId));
  if (selected.length === 0) throw new Error("先选择要处理的意见。");
  const groups = new Map<string, typeof selected>();
  for (const issue of selected) {
    const byTarget = catalog.entries.find((item) => item.id === issue.target || item.name === issue.target);
    const fallback = input.entryId ? catalog.entries.find((item) => item.id === input.entryId) : undefined;
    const entry = byTarget ?? (issue.target ? undefined : fallback);
    if (!entry) continue;
    const list = groups.get(entry.id) ?? [];
    list.push(issue);
    groups.set(entry.id, list);
  }
  if (groups.size === 0) throw new Error("选中的意见没有对应设定条目。");
  const resolved = await resolve(input.project, "ground.main", input.root.projectRoot);
  const artifactIds: string[] = [];
  const entryIds: string[] = [];
  for (const [entryId, issues] of groups) {
    const entry = catalog.entries.find((item) => item.id === entryId);
    const artifactId = entry?.candidateArtifactId ?? entry?.adoptedArtifactId;
    if (!entry || !artifactId) continue;
    const loaded = await loadArtifact(input.root, artifactId);
    if (!loaded) continue;
    assertReportReusable(report, loaded.meta.artifactId, input.reuseStale || report.targetRefs.includes(loaded.meta.artifactId));
    const text = await completeRole(resolved, [
      `按意见修改设定「${entry.name}」（id:${entry.id}）。只输出该条目 Markdown。不要改其他条目。`,
      ...issues.map((issue) => `- ${issue.title}: ${issue.suggestion ?? ""}`),
      loaded.body,
    ].join("\n"), input.llm);
    const nextId = newArtifactId("ground", entry.id);
    await saveArtifact(input.root, {
      artifactId: nextId,
      stage: "ground",
      scope: entry.id,
      version: loaded.meta.version + 1,
      parentVersion: loaded.meta.version,
      source: "revise",
      status: "candidate",
      bodyPath: entry.file,
      inputRefs: [{ kind: "report", id: report.reportId }],
      createdAt: new Date().toISOString(),
      label: entry.name,
    }, text);
    entry.candidateArtifactId = nextId;
    artifactIds.push(nextId);
    entryIds.push(entry.id);
  }
  await saveSettingsCatalog(input.root, catalog);
  return { artifactIds, entryIds };
}

export async function reviseGroundEntries(
  input: GroundRuntime & {
    readonly entryId?: string;
    readonly reportId: string;
    readonly selectedIssueIds: readonly string[];
    readonly reuseStale?: boolean;
  },
): Promise<{ artifactIds: string[]; entryIds: string[] }> {
  return reviseGroundEntry(input);
}
