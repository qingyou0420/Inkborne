/**
 * Four-agent authoring HTTP API.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { join } from "node:path";
import type { Hono } from "hono";
import {
  AUTHORING_ROLE_IDS,
  AUTHORING_ROLE_META,
  adoptAskCanon,
  adoptChapterDraft,
  adoptGroundEntries,
  adoptWeave,
  copyRoleConfig,
  diffLines,
  ensureAuthoringDraft,
  fillMissingAuthoringRoles,
  generateAskCanon,
  generateChapterDraft,
  generateGroundEntries,
  generateWeaveRange,
  generateWeaveStructure,
  isLightweightAuthoringBook,
  listArtifacts,
  listReports,
  listRuns,
  loadArtifact,
  loadCanonDocument,
  loadManifest,
  loadReport,
  loadRun,
  loadSettingsCatalog,
  newRunId,
  saveRun,
  saveWriteBody,
  selectWriteCandidate,
  parseCanon,
  prepareAskCanon,
  proposeSettingsCatalog,
  loadRoleApiKeys,
  resolveAuthoringRole,
  reviewAskCanon,
  reviewChapterDraft,
  reviewGroundEntries,
  reviewWeave,
  reviseAskCanon,
  reviseChapterDraft,
  reviseGroundEntry,
  reviseWeave,
  saveHandEditedArtifact,
  saveRunControl,
  testAuthoringRole,
  type AuthoringRoleConfig,
  type AuthoringRoleId,
  type AuthoringStoreRoot,
  type ProjectConfig,
} from "@actalk/inkos-core";

interface AuthoringRouteDeps {
  readonly root: string;
  readonly loadProject: () => Promise<ProjectConfig>;
  readonly saveRoles: (roles: ProjectConfig["authoringRoles"]) => Promise<void>;
}

function storeRoot(projectRoot: string, body: { bookId?: string; draftId?: string }): AuthoringStoreRoot {
  return {
    projectRoot,
    bookId: body.bookId,
    draftId: body.bookId ? body.draftId : (body.draftId || undefined),
  };
}

async function recordWeaveFailure(root: AuthoringStoreRoot, runId: string, error: unknown): Promise<void> {
  const current = await loadRun(root, runId);
  if (current && (current.status === "running" || current.status === "pausing")) {
    await saveRun(root, {
      ...current,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    });
  }
}

function weaveRevisionError(error: unknown): string {
  return `织卷修订失败：${error instanceof Error ? error.message : String(error)}`;
}

export function registerAuthoringRoutes(app: Hono, deps: AuthoringRouteDeps): void {
  app.get("/api/v1/authoring/roles", async (c) => {
    const project = await deps.loadProject();
    const roles = fillMissingAuthoringRoles(project);
    return c.json({
      roles,
      meta: AUTHORING_ROLE_META,
      ids: AUTHORING_ROLE_IDS,
    });
  });

  app.put("/api/v1/authoring/roles/:roleId", async (c) => {
    const roleId = c.req.param("roleId") as AuthoringRoleId;
    if (!AUTHORING_ROLE_IDS.includes(roleId)) return c.json({ error: "未知角色" }, 400);
    const body = await c.req.json<Record<string, unknown>>();
    const project = await deps.loadProject();
    const roles = fillMissingAuthoringRoles(project);
    const previous = roles[roleId] ?? {};
    const serviceRef = typeof body.serviceRef === "string" ? body.serviceRef : previous.serviceRef;
    const serviceChanged = Boolean(serviceRef && serviceRef !== previous.serviceRef);
    const inheritProtocol = body.apiFormat === null || body.apiFormat === "inherit" || (serviceChanged && body.apiFormat !== "chat" && body.apiFormat !== "responses");
    const nextRole: AuthoringRoleConfig = {
      ...previous,
      serviceRef,
      modelId: typeof body.modelId === "string" ? body.modelId : previous.modelId,
      stream: typeof body.stream === "boolean" ? body.stream : previous.stream,
      temperature: typeof body.temperature === "number" ? body.temperature : previous.temperature,
      thinkingBudget: typeof body.thinkingBudget === "number" ? body.thinkingBudget : previous.thinkingBudget,
      instructions: typeof body.instructions === "string" ? body.instructions : previous.instructions,
      lastTestStatus: "untested",
    };
    if (body.apiFormat === "responses" || body.apiFormat === "chat") {
      nextRole.apiFormat = body.apiFormat;
    } else if (inheritProtocol) {
      delete nextRole.apiFormat;
    }
    roles[roleId] = nextRole;
    await deps.saveRoles(roles);
    return c.json({ ok: true, roleId, role: roles[roleId] });
  });

  app.post("/api/v1/authoring/roles/fill-missing", async (c) => {
    const project = await deps.loadProject();
    const roles = fillMissingAuthoringRoles(project);
    await deps.saveRoles(roles);
    return c.json({ ok: true, roles, filled: AUTHORING_ROLE_IDS.length });
  });

  app.post("/api/v1/authoring/roles/copy", async (c) => {
    const body = await c.req.json<{ source: AuthoringRoleId; targets: AuthoringRoleId[]; includeInstructions?: boolean }>();
    if (!AUTHORING_ROLE_IDS.includes(body.source)) return c.json({ error: "未知源角色" }, 400);
    const project = await deps.loadProject();
    const roles = fillMissingAuthoringRoles(project);
    const copied = copyRoleConfig(roles[body.source] ?? {}, { includeInstructions: body.includeInstructions });
    for (const target of body.targets ?? []) {
      if (!AUTHORING_ROLE_IDS.includes(target) || target === body.source) continue;
      roles[target] = { ...roles[target], ...copied };
    }
    await deps.saveRoles(roles);
    return c.json({ ok: true, roles });
  });

  app.post("/api/v1/authoring/drafts/ensure", async (c) => {
    const body = await c.req.json<{ sessionId?: string; draftId?: string }>().catch(() => ({} as { sessionId?: string; draftId?: string }));
    const draft = await ensureAuthoringDraft({
      projectRoot: deps.root,
      sessionId: body.sessionId,
      draftId: body.draftId,
    });
    return c.json(draft);
  });

  app.get("/api/v1/authoring/workspace", async (c) => {
    const bookId = c.req.query("bookId") || undefined;
    const draftId = c.req.query("draftId") || undefined;
    const root = storeRoot(deps.root, { bookId, draftId });
    const project = await deps.loadProject();
    const [manifest, artifacts, reports, canon, catalog, runs] = await Promise.all([
      loadManifest(root),
      listArtifacts(root),
      listReports(root),
      loadCanonDocument(root).catch(() => null),
      loadSettingsCatalog(root).catch(() => ({ categories: [], entries: [] })),
      listRuns(root).catch(() => []),
    ]);
    const candidateAskId = manifest.candidates.ask;
    const candidateAsk = candidateAskId ? await loadArtifact(root, candidateAskId) : undefined;
    const candidateWeaveId = manifest.candidates.weave;
    const candidateWeave = candidateWeaveId ? await loadArtifact(root, candidateWeaveId) : undefined;
    const authoringBook = bookId ? await isLightweightAuthoringBook(join(deps.root, "books", bookId)) : false;
    return c.json({
      manifest,
      artifacts,
      reports,
      catalog,
      authoringBook,
      runs,
      canon: canon?.canon,
      canonSource: canon?.source,
      adoptedAskId: manifest.adopted.ask,
      candidateAsk: candidateAsk
        ? {
          artifactId: candidateAsk.meta.artifactId,
          version: candidateAsk.meta.version,
          status: candidateAsk.meta.status,
          body: candidateAsk.body,
          canon: parseCanon(candidateAsk.body),
        }
        : undefined,
      candidateWeave: candidateWeave
        ? {
          artifactId: candidateWeave.meta.artifactId,
          version: candidateWeave.meta.version,
          status: candidateWeave.meta.status,
          body: candidateWeave.body,
          scope: candidateWeave.meta.scope,
        }
        : undefined,
      roles: fillMissingAuthoringRoles(project),
    });
  });

  app.get("/api/v1/authoring/artifacts/:artifactId", async (c) => {
    const bookId = c.req.query("bookId") || undefined;
    const draftId = c.req.query("draftId") || undefined;
    const loaded = await loadArtifact(storeRoot(deps.root, { bookId, draftId }), c.req.param("artifactId"));
    if (!loaded) return c.json({ error: "找不到稿件" }, 404);
    return c.json(loaded);
  });

  app.put("/api/v1/authoring/artifacts/:artifactId", async (c) => {
    const body = await c.req.json<{ bookId?: string; draftId?: string; body: string }>();
    const meta = await saveHandEditedArtifact(
      storeRoot(deps.root, body),
      c.req.param("artifactId"),
      body.body ?? "",
    );
    return c.json({ ok: true, artifactId: meta.artifactId, version: meta.version, meta });
  });

  app.post("/api/v1/authoring/roles/:roleId/test", async (c) => {
    const roleId = c.req.param("roleId") as AuthoringRoleId;
    if (!AUTHORING_ROLE_IDS.includes(roleId)) return c.json({ error: "未知角色" }, 400);
    const body = await c.req.json<AuthoringRoleConfig & { save?: boolean }>().catch(() => ({} as AuthoringRoleConfig & { save?: boolean }));
    const project = await deps.loadProject();
    const roles = fillMissingAuthoringRoles(project);
    const resolved = resolveAuthoringRole({
      roleId,
      baseLlm: project.llm,
      roles,
      temporary: body,
      apiKeys: await loadRoleApiKeys(deps.root),
    });
    const result = await testAuthoringRole({ resolved });
    if (body.save !== true) {
      return c.json({ ...result, saved: false });
    }
    roles[roleId] = {
      ...roles[roleId],
      lastTestStatus: result.ok ? "ok" : "failed",
      lastTestError: result.error,
    };
    await deps.saveRoles(roles);
    return c.json({ ...result, saved: true, role: roles[roleId] });
  });

  app.get("/api/v1/authoring/runs/:runId", async (c) => {
    const bookId = c.req.query("bookId") || undefined;
    const draftId = c.req.query("draftId") || undefined;
    const run = await loadRun(storeRoot(deps.root, { bookId, draftId }), c.req.param("runId"));
    if (!run) return c.json({ error: "找不到运行记录" }, 404);
    return c.json(run);
  });

  app.post("/api/v1/authoring/runs/:runId/pause", async (c) => {
    const body = await c.req.json<{ bookId?: string; draftId?: string }>().catch(() => ({}));
    await saveRunControl(storeRoot(deps.root, body), c.req.param("runId"), "pause");
    return c.json({ ok: true, action: "pause" });
  });

  app.post("/api/v1/authoring/runs/:runId/cancel", async (c) => {
    const body = await c.req.json<{ bookId?: string; draftId?: string }>().catch(() => ({}));
    await saveRunControl(storeRoot(deps.root, body), c.req.param("runId"), "cancel");
    return c.json({ ok: true, action: "cancel" });
  });

  app.post("/api/v1/authoring/runs/:runId/resume", async (c) => {
    const body = await c.req.json<{ bookId?: string; draftId?: string; wait?: boolean }>();
    const root = storeRoot(deps.root, body);
    const run = await loadRun(root, c.req.param("runId"));
    if (!run) return c.json({ error: "找不到运行记录" }, 404);
    const project = await deps.loadProject();
    if (run.stage !== "weave") return c.json({ error: "目前仅织卷支持继续剩余范围" }, 400);
    if (run.operation === "revise") {
      const checkpoint = run.checkpoint;
      if (!run.reportId || !checkpoint?.revisionArtifactId || !checkpoint.revisionIssueIds?.length
        || !checkpoint.requestedStart || !checkpoint.requestedEnd) {
        return c.json({ error: "这次旧修订没有可恢复的审查记录，请打开审查意见，重新选择意见发起修订。已保存的书稿不会被替换。" }, 400);
      }
      await saveRunControl(root, run.runId, "none");
      await saveRun(root, { ...run, status: "running", error: undefined, updatedAt: new Date().toISOString() });
      const work = reviseWeave({
        root,
        project,
        artifactId: checkpoint.revisionArtifactId,
        reportId: run.reportId,
        selectedIssueIds: checkpoint.revisionIssueIds,
        startChapter: checkpoint.requestedStart,
        endChapter: checkpoint.requestedEnd,
        requirements: checkpoint.requirements,
        reuseStale: checkpoint.revisionReuseStale,
        reviseStructure: checkpoint.producedScope === "structure",
        resumeRunId: run.runId,
      });
      if (body.wait) {
        try {
          return c.json({ artifactId: await work });
        } catch (error) {
          await recordWeaveFailure(root, run.runId, error);
          return c.json({ error: weaveRevisionError(error) }, 400);
        }
      }
      void work.catch((error: unknown) => recordWeaveFailure(root, run.runId, error));
      return c.json({ runId: run.runId, status: "running", operation: "revise", progressLabel: "继续修订" });
    }
    const requestedStart = run.checkpoint?.requestedStart;
    const requestedEnd = run.checkpoint?.requestedEnd;
    const missing = run.checkpoint?.missingChapters ?? [];
    if (!requestedStart && missing.length === 0) {
      return c.json({ error: "没有可恢复的范围，请重新指定章节。" }, 400);
    }
    await saveRunControl(root, run.runId, "none");
    const result = await generateWeaveRange({
      root,
      project,
      startChapter: requestedStart ?? Math.min(...missing),
      endChapter: requestedEnd ?? Math.max(...missing),
      targetChapters: run.checkpoint?.targetChapters,
      resumeRunId: run.runId,
      missingChapters: missing.length ? missing : undefined,
    });
    return c.json(result);
  });

  app.post("/api/v1/authoring/ask/prepare", async (c) => {
    const body = await c.req.json<{ bookId?: string; draftId?: string }>();
    const result = await prepareAskCanon({ root: storeRoot(deps.root, body) });
    return c.json(result);
  });

  app.post("/api/v1/authoring/ask/generate", async (c) => {
    const body = await c.req.json<{ bookId?: string; draftId?: string; conversation: string; requirements?: string; authorRequirement?: string }>();
    const project = await deps.loadProject();
    const result = await generateAskCanon({
      root: storeRoot(deps.root, body),
      project,
      conversation: body.conversation ?? "",
      requirements: body.requirements,
      authorRequirement: body.authorRequirement,
    });
    return c.json(result);
  });

  app.post("/api/v1/authoring/ask/review", async (c) => {
    const body = await c.req.json<{ bookId?: string; draftId?: string; artifactId: string; conversation?: string }>();
    const project = await deps.loadProject();
    const report = await reviewAskCanon({
      root: storeRoot(deps.root, body),
      project,
      artifactId: body.artifactId,
      conversation: body.conversation,
    });
    return c.json(report);
  });

  app.post("/api/v1/authoring/ask/revise", async (c) => {
    const body = await c.req.json<{
      bookId?: string;
      draftId?: string;
      artifactId: string;
      reportId: string;
      selectedIssueIds: string[];
      extraRequirement?: string;
      authorRequirement?: string;
      conversation?: string;
      reuseStale?: boolean; requirements?: string;
    }>();
    const project = await deps.loadProject();
    const result = await reviseAskCanon({
      root: storeRoot(deps.root, body),
      project,
      artifactId: body.artifactId,
      reportId: body.reportId,
      selectedIssueIds: body.selectedIssueIds ?? [],
      extraRequirement: body.authorRequirement ?? body.extraRequirement ?? body.requirements,
      conversation: body.conversation,
      reuseStale: body.reuseStale,
    });
    return c.json(result);
  });

  app.post("/api/v1/authoring/ask/adopt", async (c) => {
    const body = await c.req.json<{ bookId?: string; draftId?: string; artifactId: string; language?: "zh" | "en" }>();
    const project = await deps.loadProject();
    const result = await adoptAskCanon({
      root: storeRoot(deps.root, body),
      project,
      artifactId: body.artifactId,
      language: body.language,
    });
    return c.json({
      ...result,
      message: result.created ? "正典已采用，新书已建立" : "正典已采用",
    });
  });

  app.post("/api/v1/authoring/ground/catalog", async (c) => {
    const body = await c.req.json<{ bookId: string }>();
    const project = await deps.loadProject();
    const catalog = await proposeSettingsCatalog({
      root: storeRoot(deps.root, body),
      project,
    });
    return c.json(catalog);
  });

  app.post("/api/v1/authoring/ground/generate", async (c) => {
    const body = await c.req.json<{ bookId: string; entryIds?: string[]; regenerate?: boolean; requirements?: string }>();
    const project = await deps.loadProject();
    const result = await generateGroundEntries({
      root: storeRoot(deps.root, body),
      project,
      entryIds: body.entryIds,
      regenerate: body.regenerate, requirements: body.requirements,
    });
    return c.json(result);
  });

  app.post("/api/v1/authoring/ground/review", async (c) => {
    const body = await c.req.json<{ bookId: string; entryIds: string[] }>();
    const project = await deps.loadProject();
    const report = await reviewGroundEntries({
      root: storeRoot(deps.root, body),
      project,
      entryIds: body.entryIds ?? [],
    });
    return c.json(report);
  });

  app.post("/api/v1/authoring/ground/revise", async (c) => {
    const body = await c.req.json<{
      bookId: string;
      entryId?: string;
      reportId: string;
      selectedIssueIds: string[];
      reuseStale?: boolean; requirements?: string;
    }>();
    const project = await deps.loadProject();
    const result = await reviseGroundEntry({
      root: storeRoot(deps.root, body),
      project,
      entryId: body.entryId, requirements: body.requirements,
      reportId: body.reportId,
      selectedIssueIds: body.selectedIssueIds ?? [],
      reuseStale: body.reuseStale,
    });
    return c.json({ artifactId: result.artifactIds[0], ...result });
  });

  app.post("/api/v1/authoring/ground/adopt", async (c) => {
    const body = await c.req.json<{ bookId: string; entryIds: string[] }>();
    const project = await deps.loadProject();
    const result = await adoptGroundEntries({
      root: storeRoot(deps.root, body),
      project,
      entryIds: body.entryIds ?? [],
    });
    return c.json(result);
  });

  app.post("/api/v1/authoring/weave/structure", async (c) => {
    const body = await c.req.json<{ bookId: string; requirements?: string }>();
    const project = await deps.loadProject();
    const result = await generateWeaveStructure({
      root: storeRoot(deps.root, body),
      project,
      requirements: body.requirements,
    });
    return c.json(result);
  });

  app.post("/api/v1/authoring/weave/generate", async (c) => {
    const body = await c.req.json<{ bookId: string; startChapter: number; endChapter: number; targetChapters?: number; wait?: boolean; requirements?: string }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    if (body.bookId && await isLightweightAuthoringBook(join(deps.root, "books", body.bookId))) {
      const manifest = await loadManifest(root);
      if (!manifest.adopted.weave) {
        return c.json({ error: "请先采用分卷结构，再生成章概要。" }, 400);
      }
    }
    const runId = newRunId();
    const start = Math.max(1, body.startChapter || 1);
    const end = Math.max(start, body.endChapter || start);
    const now = new Date().toISOString();
    await saveRun(root, {
      runId,
      stage: "weave",
      operation: "generate",
      roleId: "weave.main",
      status: "running",
      bookId: body.bookId,
      progressDone: 0,
      progressTotal: end - start + 1,
      progressLabel: `本次 0/${end - start + 1}`,
      modelSnapshot: {},
      checkpoint: { requestedStart: start, requestedEnd: end, missingChapters: [], producedScope: `chapters:${start}-${end}`, requirements: body.requirements, targetChapters: body.targetChapters },
      createdAt: now,
      updatedAt: now,
    });
    const work = generateWeaveRange({
      root,
      project,
      startChapter: start,
      endChapter: end,
      targetChapters: body.targetChapters && body.targetChapters !== end ? body.targetChapters : undefined,
      requirements: body.requirements,
      runId,
    });
    if (body.wait) {
      return c.json(await work);
    }
    void work.catch(async (error: unknown) => {
      const current = await loadRun(root, runId);
      if (current && (current.status === "running" || current.status === "pausing")) {
        await saveRun(root, {
          ...current,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return c.json({ runId, status: "running", scope: `chapters:${start}-${end}` });
  });

  app.post("/api/v1/authoring/weave/review", async (c) => {
    const body = await c.req.json<{ bookId: string; artifactId: string; coverage: string }>();
    const project = await deps.loadProject();
    const report = await reviewWeave({
      root: storeRoot(deps.root, body),
      project,
      artifactId: body.artifactId,
      coverage: body.coverage,
    });
    return c.json(report);
  });

  app.post("/api/v1/authoring/weave/revise", async (c) => {
    const body = await c.req.json<{
      bookId: string;
      artifactId: string;
      reportId: string;
      selectedIssueIds: string[];
      startChapter: number;
      endChapter: number;
      reuseStale?: boolean; requirements?: string; reviseStructure?: boolean; wait?: boolean;
    }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    if (!body.artifactId || !body.reportId || !body.selectedIssueIds?.length) {
      return c.json({ error: "请先打开当前稿件的审查意见，选择需要修订的问题。" }, 400);
    }
    if (!Number.isInteger(body.startChapter) || !Number.isInteger(body.endChapter)
      || body.startChapter < 1 || body.endChapter < body.startChapter) {
      return c.json({ error: "请输入有效的修订章范围，结束章不能小于开始章。" }, 400);
    }
    const [artifact, report] = await Promise.all([loadArtifact(root, body.artifactId), loadReport(root, body.reportId)]);
    if (!artifact || !report) return c.json({ error: "找不到待修订稿件或审查报告，请刷新后重新发起修订。" }, 400);
    const runId = newRunId();
    const now = new Date().toISOString();
    const scope = body.reviseStructure ? "structure" : `chapters:${body.startChapter}-${body.endChapter}`;
    await saveRun(root, {
      runId, stage: "weave", operation: "revise", roleId: "weave.main", status: "running", bookId: body.bookId,
      reportId: body.reportId, scope, progressDone: 0, progressLabel: "准备修订", modelSnapshot: {},
      checkpoint: {
        requestedStart: body.startChapter, requestedEnd: body.endChapter, requirements: body.requirements,
        producedScope: scope, revisionArtifactId: body.artifactId,
        revisionIssueIds: body.selectedIssueIds, revisionReuseStale: body.reuseStale,
      },
      createdAt: now, updatedAt: now,
    });
    const work = reviseWeave({
      root,
      project,
      artifactId: body.artifactId,
      reportId: body.reportId,
      selectedIssueIds: body.selectedIssueIds ?? [],
      startChapter: body.startChapter,
      endChapter: body.endChapter, requirements: body.requirements,
      reuseStale: body.reuseStale,
      reviseStructure: body.reviseStructure,
      runId,
    });
    if (body.wait) {
      try {
        return c.json({ artifactId: await work });
      } catch (error) {
        await recordWeaveFailure(root, runId, error);
        return c.json({ error: weaveRevisionError(error) }, 400);
      }
    }
    void work.catch((error: unknown) => recordWeaveFailure(root, runId, error));
    return c.json({ runId, status: "running", operation: "revise", progressLabel: "准备修订" });
  });

  app.post("/api/v1/authoring/weave/adopt", async (c) => {
    const body = await c.req.json<{ bookId: string; artifactId: string }>();
    const project = await deps.loadProject();
    await adoptWeave({
      root: storeRoot(deps.root, body),
      project,
      artifactId: body.artifactId,
    });
    return c.json({ ok: true, message: "规划已采用" });
  });

  app.post("/api/v1/authoring/write/select", async (c) => {
    const body = await c.req.json<{ bookId: string; chapterNumber: number; artifactId: string }>();
    const project = await deps.loadProject();
    const result = await selectWriteCandidate({
      root: storeRoot(deps.root, body),
      project,
      chapterNumber: body.chapterNumber,
      artifactId: body.artifactId,
    });
    return c.json(result);
  });

  app.post("/api/v1/authoring/write/hand", async (c) => {
    const body = await c.req.json<{ bookId: string; chapterNumber: number; title?: string; body: string; artifactId?: string }>();
    const project = await deps.loadProject();
    const result = await saveWriteBody({
      root: storeRoot(deps.root, body),
      project,
      chapterNumber: body.chapterNumber,
      title: body.title,
      body: body.body ?? "",
      artifactId: body.artifactId,
    });
    return c.json(result);
  });

  app.post("/api/v1/authoring/write/generate", async (c) => {
    const body = await c.req.json<{ bookId: string; chapterNumber: number; title?: string; requirements?: string }>();
    const project = await deps.loadProject();
    try {
      const result = await generateChapterDraft({
        root: storeRoot(deps.root, body),
        project,
        chapterNumber: body.chapterNumber,
        title: body.title,
        requirements: body.requirements,
      });
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/请先/.test(message)) return c.json({ error: message }, 400);
      throw error;
    }
  });

  app.post("/api/v1/authoring/write/review", async (c) => {
    const body = await c.req.json<{ bookId: string; artifactId: string; coverage?: string }>();
    const project = await deps.loadProject();
    const report = await reviewChapterDraft({
      root: storeRoot(deps.root, body),
      project,
      artifactId: body.artifactId,
      coverage: body.coverage,
    });
    return c.json(report);
  });

  app.post("/api/v1/authoring/write/revise", async (c) => {
    const body = await c.req.json<{
      bookId: string;
      artifactId: string;
      reportId: string;
      selectedIssueIds: string[];
      extraRequirement?: string;
      reuseStale?: boolean; requirements?: string;
    }>();
    const project = await deps.loadProject();
    const result = await reviseChapterDraft({
      root: storeRoot(deps.root, body),
      project,
      artifactId: body.artifactId,
      reportId: body.reportId,
      selectedIssueIds: body.selectedIssueIds ?? [],
      extraRequirement: body.requirements ?? body.extraRequirement,
      reuseStale: body.reuseStale,
    });
    return c.json(result);
  });

  app.post("/api/v1/authoring/write/adopt", async (c) => {
    const body = await c.req.json<{ bookId: string; artifactId: string }>();
    const project = await deps.loadProject();
    const result = await adoptChapterDraft({
      root: storeRoot(deps.root, body),
      project,
      artifactId: body.artifactId,
    });
    return c.json({
      ...result,
      message: result.settled ? "章节已采用" : "正文已采用，摘要与状态整理未完成",
    });
  });

  app.get("/api/v1/authoring/diff", async (c) => {
    const left = c.req.query("left") ?? "";
    const right = c.req.query("right") ?? "";
    const bookId = c.req.query("bookId") || undefined;
    const draftId = c.req.query("draftId") || undefined;
    const root = storeRoot(deps.root, { bookId, draftId });
    const a = await loadArtifact(root, left);
    const b = await loadArtifact(root, right);
    if (!a || !b) return c.json({ error: "找不到比较版本" }, 404);
    return c.json({
      left: a.meta,
      right: b.meta,
      hunks: diffLines(a.body, b.body),
    });
  });

  app.get("/api/v1/authoring/reports/:reportId", async (c) => {
    const bookId = c.req.query("bookId") || undefined;
    const draftId = c.req.query("draftId") || undefined;
    const report = await loadReport(storeRoot(deps.root, { bookId, draftId }), c.req.param("reportId"));
    if (!report) return c.json({ error: "找不到报告" }, 404);
    return c.json(report);
  });
}
