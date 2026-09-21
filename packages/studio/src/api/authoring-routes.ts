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
  CANON_LENGTH_REQUIRED,
  WEAVE_LENGTH_REQUIRED,
  adoptChapterDraft,
  settleAdoptedChapter,
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
  impactWorkspaceSummary,
  isLightweightAuthoringBook,
  listArtifacts,
  listChapterStateRefs,
  listReports,
  listRuns,
  loadArtifact,
  loadCanonDocument,
  loadCurrentImpact,
  loadDraft,
  loadImpactReport,
  loadManifest,
  loadReport,
  loadRun,
  loadSettingsCatalog,
  migrateBookSession,
  newRunId,
  saveRun,
  SessionAlreadyMigratedError,
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
  resolveImpactItems,
  saveHandEditedArtifact,
  saveRunControl,
  testAuthoringRole,
  triageCanonImpact,
  type AuthoringRoleConfig,
  type AuthoringRoleId,
  type AuthoringRunRecord,
  type AuthoringStoreRoot,
  type ProjectConfig,
} from "@actalk/inkos-core";

interface AuthoringRouteDeps {
  readonly root: string;
  readonly loadProject: () => Promise<ProjectConfig>;
  readonly saveRoles: (roles: ProjectConfig["authoringRoles"]) => Promise<void>;
  readonly broadcast?: (event: string, data: unknown) => void;
}

function storeRoot(projectRoot: string, body: { bookId?: string; draftId?: string }): AuthoringStoreRoot {
  return {
    projectRoot,
    bookId: body.bookId,
    draftId: body.bookId ? body.draftId : (body.draftId || undefined),
  };
}

function emitAuthoringRun(deps: AuthoringRouteDeps, root: AuthoringStoreRoot, run: Pick<AuthoringRunRecord, "runId" | "stage" | "status"> & {
  readonly progressDone?: number;
  readonly progressTotal?: number;
  readonly error?: string;
}): void {
  deps.broadcast?.("authoring:run", {
    bookId: root.bookId,
    draftId: root.draftId,
    runId: run.runId,
    stage: run.stage,
    status: run.status,
    progressDone: run.progressDone,
    progressTotal: run.progressTotal,
    error: run.error,
  });
}

async function recordRunFailure(root: AuthoringStoreRoot, runId: string, error: unknown, deps?: AuthoringRouteDeps): Promise<void> {
  const current = await loadRun(root, runId);
  if (current && (current.status === "running" || current.status === "pausing")) {
    const failed = {
      ...current,
      status: "failed" as const,
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    };
    await saveRun(root, failed);
    if (deps) emitAuthoringRun(deps, root, failed);
    return;
  }
  if (deps && current) emitAuthoringRun(deps, root, current);
}

async function announceRun(deps: AuthoringRouteDeps, root: AuthoringStoreRoot, runId: string): Promise<void> {
  const run = await loadRun(root, runId);
  if (run) emitAuthoringRun(deps, root, run);
}

function onAuthoringProgress(deps: AuthoringRouteDeps, root: AuthoringStoreRoot) {
  return (run: AuthoringRunRecord) => emitAuthoringRun(deps, root, run);
}

function weaveRevisionError(error: unknown): string {
  return `织卷修订失败：${error instanceof Error ? error.message : String(error)}`;
}

export const AUTHORING_ORPHAN_RUN_ERROR = "Studio 重启时这次运行已中断，请重新发起。";

function emptyRun(input: {
  readonly runId: string;
  readonly stage: AuthoringRunRecord["stage"];
  readonly operation: AuthoringRunRecord["operation"];
  readonly roleId: AuthoringRoleId;
  readonly bookId?: string;
  readonly draftId?: string;
  readonly scope?: string;
  readonly progressLabel?: string;
  readonly progressTotal?: number;
  readonly reportId?: string;
}): AuthoringRunRecord {
  const now = new Date().toISOString();
  return {
    runId: input.runId,
    stage: input.stage,
    operation: input.operation,
    roleId: input.roleId,
    status: "running",
    bookId: input.bookId,
    draftId: input.draftId,
    scope: input.scope,
    progressDone: 0,
    progressTotal: input.progressTotal,
    progressLabel: input.progressLabel,
    reportId: input.reportId,
    modelSnapshot: {},
    producedArtifactIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function registerAuthoringRoutes(app: Hono, deps: AuthoringRouteDeps): void {
  const serverStartedAt = new Date().toISOString();
  const activeRunIds = new Set<string>();

  const reclaimOrphanRun = async (root: AuthoringStoreRoot, run: AuthoringRunRecord | undefined): Promise<AuthoringRunRecord | undefined> => {
    if (!run) return undefined;
    if ((run.status === "running" || run.status === "pausing") && run.updatedAt < serverStartedAt) {
      const failed = {
        ...run,
        status: "failed" as const,
        error: AUTHORING_ORPHAN_RUN_ERROR,
        updatedAt: new Date().toISOString(),
      };
      await saveRun(root, failed);
      emitAuthoringRun(deps, root, failed);
      return failed;
    }
    return run;
  };

  const persistStartingRun = async (root: AuthoringStoreRoot, run: AuthoringRunRecord): Promise<void> => {
    await saveRun(root, run);
    emitAuthoringRun(deps, root, run);
  };

  const watchAuthoringWork = (
    root: AuthoringStoreRoot,
    runId: string,
    work: Promise<unknown>,
    announce = false,
  ): void => {
    activeRunIds.add(runId);
    void work
      .then(() => announce ? announceRun(deps, root, runId) : undefined)
      .catch((error: unknown) => recordRunFailure(root, runId, error, deps))
      .finally(() => { activeRunIds.delete(runId); });
  };

  const startAuthoringWork = (
    root: AuthoringStoreRoot,
    runId: string,
    workFactory: () => Promise<unknown>,
    announce = true,
  ): Promise<unknown> => {
    const work = Promise.resolve().then(workFactory);
    watchAuthoringWork(root, runId, work, announce);
    return work;
  };

  const awaitAuthoringWork = async <T>(
    root: AuthoringStoreRoot,
    runId: string,
    work: Promise<T>,
  ): Promise<T> => {
    activeRunIds.add(runId);
    try {
      return await work;
    } catch (error) {
      await recordRunFailure(root, runId, error, deps);
      throw error;
    } finally {
      activeRunIds.delete(runId);
    }
  };
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
    const [manifest, artifacts, reports, canon, catalog, listedRuns, writeStateRefs] = await Promise.all([
      loadManifest(root),
      listArtifacts(root),
      listReports(root),
      loadCanonDocument(root).catch(() => null),
      loadSettingsCatalog(root).catch(() => ({ categories: [], entries: [] })),
      listRuns(root).catch(() => []),
      listChapterStateRefs(root).catch(() => ({})),
    ]);
    const runs = (await Promise.all(listedRuns.map((run) => reclaimOrphanRun(root, run)))).filter(
      (run): run is AuthoringRunRecord => Boolean(run),
    );
    const candidateAskId = manifest.candidates.ask;
    const candidateAsk = candidateAskId ? await loadArtifact(root, candidateAskId) : undefined;
    const candidateWeaveId = manifest.candidates.weave;
    const candidateWeave = candidateWeaveId ? await loadArtifact(root, candidateWeaveId) : undefined;
    const authoringBook = bookId ? await isLightweightAuthoringBook(join(deps.root, "books", bookId)) : false;
    const currentImpact = authoringBook ? await loadCurrentImpact(root).catch(() => undefined) : undefined;
    return c.json({
      manifest,
      artifacts,
      reports,
      catalog,
      authoringBook,
      impact: currentImpact ? impactWorkspaceSummary(currentImpact) : undefined,
      runs,
      writeStateRefs,
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
    const root = storeRoot(deps.root, { bookId, draftId });
    const run = await reclaimOrphanRun(root, await loadRun(root, c.req.param("runId")));
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
    const root = storeRoot(deps.root, body);
    const runId = c.req.param("runId");
    if (activeRunIds.has(runId)) {
      await saveRunControl(root, runId, "cancel");
      return c.json({ ok: true, action: "cancel" });
    }
    const run = await loadRun(root, runId);
    if (run && (run.status === "running" || run.status === "pausing")) {
      const cancelled = {
        ...run,
        status: "cancelled" as const,
        updatedAt: new Date().toISOString(),
      };
      await saveRun(root, cancelled);
      emitAuthoringRun(deps, root, cancelled);
      return c.json({ ok: true, action: "cancel", status: "cancelled" });
    }
    await saveRunControl(root, runId, "cancel");
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
          await recordRunFailure(root, run.runId, error, deps);
          return c.json({ error: weaveRevisionError(error) }, 400);
        }
      }
      void work.catch((error: unknown) => recordRunFailure(root, run.runId, error, deps));
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
    const body = await c.req.json<{ bookId?: string; draftId?: string; conversation: string; requirements?: string; authorRequirement?: string; wait?: boolean }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    const runId = newRunId();
    await persistStartingRun(root, emptyRun({
      runId, stage: "ask", operation: "generate", roleId: "ask.main",
      bookId: body.bookId, draftId: root.draftId, progressLabel: "正在整理正典",
    }));
    const workFactory = () => generateAskCanon({
      root,
      project,
      conversation: body.conversation ?? "",
      requirements: body.requirements,
      authorRequirement: body.authorRequirement,
      runId,
      onProgress: onAuthoringProgress(deps, root),
    });
    if (body.wait) return c.json(await awaitAuthoringWork(root, runId, Promise.resolve().then(workFactory)));
    startAuthoringWork(root, runId, workFactory);
    return c.json({ runId, status: "running" });
  });

  app.post("/api/v1/authoring/ask/review", async (c) => {
    const body = await c.req.json<{ bookId?: string; draftId?: string; artifactId: string; conversation?: string; wait?: boolean }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    const runId = newRunId();
    await persistStartingRun(root, emptyRun({
      runId, stage: "ask", operation: "review", roleId: "ask.review",
      bookId: body.bookId, draftId: root.draftId, progressLabel: "正在审查正典",
    }));
    const workFactory = () => reviewAskCanon({
      root,
      project,
      artifactId: body.artifactId,
      conversation: body.conversation,
      runId,
      onProgress: onAuthoringProgress(deps, root),
    });
    if (body.wait) return c.json(await awaitAuthoringWork(root, runId, Promise.resolve().then(workFactory)));
    startAuthoringWork(root, runId, workFactory);
    return c.json({ runId, status: "running" });
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
      reuseStale?: boolean; requirements?: string; wait?: boolean;
    }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    const runId = newRunId();
    await persistStartingRun(root, emptyRun({
      runId, stage: "ask", operation: "revise", roleId: "ask.main",
      bookId: body.bookId, draftId: root.draftId, reportId: body.reportId, progressLabel: "正在修订正典",
    }));
    const workFactory = () => reviseAskCanon({
      root,
      project,
      artifactId: body.artifactId,
      reportId: body.reportId,
      selectedIssueIds: body.selectedIssueIds ?? [],
      extraRequirement: body.authorRequirement ?? body.extraRequirement ?? body.requirements,
      conversation: body.conversation,
      reuseStale: body.reuseStale,
      runId,
      onProgress: onAuthoringProgress(deps, root),
    });
    if (body.wait) return c.json(await awaitAuthoringWork(root, runId, Promise.resolve().then(workFactory)));
    startAuthoringWork(root, runId, workFactory);
    return c.json({ runId, status: "running" });
  });

  app.post("/api/v1/authoring/ask/adopt", async (c) => {
    const body = await c.req.json<{ bookId?: string; draftId?: string; artifactId: string; language?: "zh" | "en" }>();
    const project = await deps.loadProject();
    try {
      const result = await adoptAskCanon({
        root: storeRoot(deps.root, body),
        project,
        artifactId: body.artifactId,
        language: body.language,
      });
      if (result.created && body.draftId) {
        const draft = await loadDraft(deps.root, body.draftId);
        if (draft?.sessionId) {
          try {
            await migrateBookSession(deps.root, draft.sessionId, result.bookId);
          } catch (error) {
            if (!(error instanceof SessionAlreadyMigratedError)) throw error;
          }
          deps.broadcast?.("book:created", {
            sessionId: draft.sessionId,
            bookId: result.bookId,
            canonCandidate: false,
            stage: "ask",
          });
        }
      }
      let impactRunId: string | undefined;
      if (result.impactPending && result.bookId) {
        const adoptRoot = storeRoot(deps.root, { bookId: result.bookId, draftId: body.draftId });
        const adoptManifest = await loadManifest(adoptRoot);
        impactRunId = newRunId();
        await persistStartingRun(adoptRoot, emptyRun({
          runId: impactRunId,
          stage: "ask",
          operation: "review",
          roleId: "ask.review",
          bookId: result.bookId,
          draftId: adoptRoot.draftId,
          scope: `impact:${adoptManifest.impactBaseline?.ask ?? ""}..${result.artifactId}`,
          progressLabel: "正在分辨正典改动的影响",
        }));
        startAuthoringWork(adoptRoot, impactRunId, () => triageCanonImpact({
          root: adoptRoot,
          project,
          runId: impactRunId,
          onProgress: onAuthoringProgress(deps, adoptRoot),
        }));
      }
      return c.json({
        ...result,
        impactRunId,
        message: result.created ? "正典已采用，新书已建立" : "正典已采用",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: string }).code;
      if (code === CANON_LENGTH_REQUIRED || /篇幅/.test(message)) {
        return c.json({ error: message, code: code ?? CANON_LENGTH_REQUIRED }, 400);
      }
      throw error;
    }
  });

  app.post("/api/v1/authoring/ground/catalog", async (c) => {
    const body = await c.req.json<{ bookId: string; wait?: boolean }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    const runId = newRunId();
    const now = new Date().toISOString();
    await persistStartingRun(root, emptyRun({
      runId, stage: "ground", operation: "generate", roleId: "ground.main",
      bookId: body.bookId, progressLabel: "正在拟定设定目录",
    }));
    const work = proposeSettingsCatalog({ root, project }).then(async (catalog) => {
      await saveRun(root, {
        runId, stage: "ground", operation: "generate", roleId: "ground.main", status: "completed",
        bookId: body.bookId, progressDone: 1, progressTotal: 1, progressLabel: "设定目录已拟定",
        modelSnapshot: {}, producedArtifactIds: [], createdAt: now, updatedAt: new Date().toISOString(),
      });
      emitAuthoringRun(deps, root, { runId, stage: "ground", status: "completed", progressDone: 1, progressTotal: 1 });
      return catalog;
    });
    if (body.wait) return c.json(await awaitAuthoringWork(root, runId, work));
    watchAuthoringWork(root, runId, work);
    return c.json({ runId, status: "running" });
  });

  app.post("/api/v1/authoring/ground/generate", async (c) => {
    const body = await c.req.json<{ bookId: string; entryIds?: string[]; regenerate?: boolean; requirements?: string; wait?: boolean }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    const runId = newRunId();
    await persistStartingRun(root, emptyRun({
      runId, stage: "ground", operation: "generate", roleId: "ground.main",
      bookId: body.bookId, progressLabel: "正在生成设定",
    }));
    const workFactory = () => generateGroundEntries({
      root,
      project,
      entryIds: body.entryIds,
      regenerate: body.regenerate,
      requirements: body.requirements,
      runId,
      onProgress: onAuthoringProgress(deps, root),
    });
    if (body.wait) return c.json(await awaitAuthoringWork(root, runId, Promise.resolve().then(workFactory)));
    startAuthoringWork(root, runId, workFactory);
    return c.json({ runId, status: "running" });
  });

  app.post("/api/v1/authoring/ground/review", async (c) => {
    const body = await c.req.json<{ bookId: string; entryIds: string[]; wait?: boolean }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    const runId = newRunId();
    const now = new Date().toISOString();
    await persistStartingRun(root, emptyRun({
      runId, stage: "ground", operation: "review", roleId: "ground.review",
      bookId: body.bookId, progressLabel: "正在审查设定",
    }));
    const work = reviewGroundEntries({
      root,
      project,
      entryIds: body.entryIds ?? [],
    }).then(async (report) => {
      await saveRun(root, {
        runId, stage: "ground", operation: "review", roleId: "ground.review", status: "completed",
        bookId: body.bookId, reportId: report.reportId, progressDone: 1, progressTotal: 1,
        progressLabel: "审查完成", modelSnapshot: {}, producedArtifactIds: [],
        createdAt: now, updatedAt: new Date().toISOString(),
      });
      emitAuthoringRun(deps, root, { runId, stage: "ground", status: "completed", progressDone: 1, progressTotal: 1 });
      return report;
    });
    if (body.wait) return c.json(await awaitAuthoringWork(root, runId, work));
    watchAuthoringWork(root, runId, work);
    return c.json({ runId, status: "running" });
  });

  app.post("/api/v1/authoring/ground/revise", async (c) => {
    const body = await c.req.json<{
      bookId: string;
      entryId?: string;
      reportId: string;
      selectedIssueIds: string[];
      reuseStale?: boolean; requirements?: string; wait?: boolean;
    }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    const runId = newRunId();
    const now = new Date().toISOString();
    await persistStartingRun(root, emptyRun({
      runId, stage: "ground", operation: "revise", roleId: "ground.main",
      bookId: body.bookId, reportId: body.reportId, progressLabel: "正在修订设定",
    }));
    const work = reviseGroundEntry({
      root,
      project,
      entryId: body.entryId, requirements: body.requirements,
      reportId: body.reportId,
      selectedIssueIds: body.selectedIssueIds ?? [],
      reuseStale: body.reuseStale,
    }).then(async (result) => {
      await saveRun(root, {
        runId, stage: "ground", operation: "revise", roleId: "ground.main", status: "completed",
        bookId: body.bookId, reportId: body.reportId, progressDone: 1, progressTotal: 1,
        progressLabel: "修订完成", modelSnapshot: {}, producedArtifactIds: result.artifactIds,
        createdAt: now, updatedAt: new Date().toISOString(),
      });
      emitAuthoringRun(deps, root, { runId, stage: "ground", status: "completed", progressDone: 1, progressTotal: 1 });
      return { artifactId: result.artifactIds[0], ...result };
    });
    if (body.wait) return c.json(await awaitAuthoringWork(root, runId, work));
    watchAuthoringWork(root, runId, work);
    return c.json({ runId, status: "running" });
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
    const body = await c.req.json<{ bookId: string; requirements?: string; wait?: boolean }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    const runId = newRunId();
    await persistStartingRun(root, emptyRun({
      runId, stage: "weave", operation: "generate", roleId: "weave.main",
      bookId: body.bookId, progressLabel: "正在生成分卷规划",
    }));
    const workFactory = () => generateWeaveStructure({
      root,
      project,
      requirements: body.requirements,
      runId,
    });
    const mapLengthError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: string }).code;
      if (code === WEAVE_LENGTH_REQUIRED || /请先/.test(message)) {
        return { error: message, code: code ?? WEAVE_LENGTH_REQUIRED };
      }
      return undefined;
    };
    if (body.wait) {
      try {
        return c.json(await awaitAuthoringWork(root, runId, Promise.resolve().then(workFactory)));
      } catch (error) {
        const mapped = mapLengthError(error);
        if (mapped) return c.json(mapped, 400);
        throw error;
      }
    }
    startAuthoringWork(root, runId, workFactory);
    return c.json({ runId, status: "running" });
  });

  app.post("/api/v1/authoring/weave/generate", async (c) => {
    const body = await c.req.json<{ bookId: string; startChapter: number; endChapter: number; targetChapters?: number; wait?: boolean; requirements?: string }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
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
    if (body.wait) return c.json(await awaitAuthoringWork(root, runId, work));
    watchAuthoringWork(root, runId, work, true);
    emitAuthoringRun(deps, root, { runId, stage: "weave", status: "running", progressDone: 0, progressTotal: end - start + 1 });
    return c.json({ runId, status: "running", scope: `chapters:${start}-${end}` });
  });

  app.post("/api/v1/authoring/weave/review", async (c) => {
    const body = await c.req.json<{ bookId: string; artifactId: string; coverage: string; wait?: boolean }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    const runId = newRunId();
    await persistStartingRun(root, emptyRun({
      runId, stage: "weave", operation: "review", roleId: "weave.review",
      bookId: body.bookId, progressLabel: "正在审查规划",
    }));
    const workFactory = () => reviewWeave({
      root,
      project,
      artifactId: body.artifactId,
      coverage: body.coverage,
      runId,
    });
    if (body.wait) return c.json(await awaitAuthoringWork(root, runId, Promise.resolve().then(workFactory)));
    startAuthoringWork(root, runId, workFactory);
    return c.json({ runId, status: "running" });
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
        return c.json({ artifactId: await awaitAuthoringWork(root, runId, work) });
      } catch (error) {
        return c.json({ error: weaveRevisionError(error) }, 400);
      }
    }
    watchAuthoringWork(root, runId, work);
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
    const body = await c.req.json<{ bookId: string; chapterNumber: number; title?: string; requirements?: string; wait?: boolean }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    const runId = newRunId();
    await persistStartingRun(root, emptyRun({
      runId, stage: "write", operation: "generate", roleId: "write.main",
      bookId: body.bookId, scope: `chapter:${body.chapterNumber}`,
      progressLabel: `正在写第 ${body.chapterNumber} 章`,
    }));
    const workFactory = () => generateChapterDraft({
      root,
      project,
      chapterNumber: body.chapterNumber,
      title: body.title,
      requirements: body.requirements,
      runId,
      onProgress: onAuthoringProgress(deps, root),
    });
    if (body.wait) {
      try {
        return c.json(await awaitAuthoringWork(root, runId, Promise.resolve().then(workFactory)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/请先/.test(message)) return c.json({ error: message }, 400);
        throw error;
      }
    }
    startAuthoringWork(root, runId, workFactory);
    return c.json({ runId, status: "running" });
  });

  app.post("/api/v1/authoring/write/review", async (c) => {
    const body = await c.req.json<{ bookId: string; artifactId: string; coverage?: string; wait?: boolean }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    const runId = newRunId();
    await persistStartingRun(root, emptyRun({
      runId, stage: "write", operation: "review", roleId: "write.review",
      bookId: body.bookId, progressLabel: "正在审查正文",
    }));
    const workFactory = () => reviewChapterDraft({
      root,
      project,
      artifactId: body.artifactId,
      coverage: body.coverage,
      runId,
      onProgress: onAuthoringProgress(deps, root),
    });
    if (body.wait) return c.json(await awaitAuthoringWork(root, runId, Promise.resolve().then(workFactory)));
    startAuthoringWork(root, runId, workFactory);
    return c.json({ runId, status: "running" });
  });

  app.post("/api/v1/authoring/write/revise", async (c) => {
    const body = await c.req.json<{
      bookId: string;
      artifactId: string;
      reportId: string;
      selectedIssueIds: string[];
      extraRequirement?: string;
      reuseStale?: boolean; requirements?: string; wait?: boolean;
    }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    const runId = newRunId();
    await persistStartingRun(root, emptyRun({
      runId, stage: "write", operation: "revise", roleId: "write.main",
      bookId: body.bookId, reportId: body.reportId, progressLabel: "正在修订正文",
    }));
    const workFactory = () => reviseChapterDraft({
      root,
      project,
      artifactId: body.artifactId,
      reportId: body.reportId,
      selectedIssueIds: body.selectedIssueIds ?? [],
      extraRequirement: body.requirements ?? body.extraRequirement,
      reuseStale: body.reuseStale,
      runId,
      onProgress: onAuthoringProgress(deps, root),
    });
    if (body.wait) return c.json(await awaitAuthoringWork(root, runId, Promise.resolve().then(workFactory)));
    startAuthoringWork(root, runId, workFactory);
    return c.json({ runId, status: "running" });
  });

  app.post("/api/v1/authoring/write/adopt", async (c) => {
    const body = await c.req.json<{ bookId: string; artifactId: string; wait?: boolean }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    const adopted = await adoptChapterDraft({
      root,
      project,
      artifactId: body.artifactId,
      deferSettle: true,
    });
    const adoptedMeta = await loadArtifact(root, body.artifactId);
    const runId = newRunId();
    await persistStartingRun(root, emptyRun({
      runId, stage: "write", operation: "settle", roleId: "write.main",
      bookId: body.bookId, scope: adoptedMeta?.meta.scope,
      progressLabel: "正在整理章节状态",
    }));
    const workFactory = () => settleAdoptedChapter({
      root,
      project,
      artifactId: body.artifactId,
      runId,
      onProgress: onAuthoringProgress(deps, root),
    });
    if (body.wait) {
      const settled = await awaitAuthoringWork(root, runId, Promise.resolve().then(workFactory)) as Awaited<ReturnType<typeof settleAdoptedChapter>>;
      return c.json({
        ...adopted,
        ...settled,
        runId,
        message: settled.settled ? "章节已采用" : "正文已采用，摘要与状态整理未完成",
      });
    }
    startAuthoringWork(root, runId, workFactory);
    return c.json({
      ...adopted,
      runId,
      status: "running",
      settled: false,
      message: "章节已采用，正在整理摘要与状态",
    });
  });

  app.post("/api/v1/authoring/write/settle", async (c) => {
    const body = await c.req.json<{ bookId: string; artifactId: string; wait?: boolean }>();
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    const settleMeta = await loadArtifact(root, body.artifactId);
    const runId = newRunId();
    await persistStartingRun(root, emptyRun({
      runId, stage: "write", operation: "settle", roleId: "write.main",
      bookId: body.bookId, scope: settleMeta?.meta.scope,
      progressLabel: "正在整理章节状态",
    }));
    const workFactory = () => settleAdoptedChapter({
      root,
      project,
      artifactId: body.artifactId,
      runId,
      onProgress: onAuthoringProgress(deps, root),
    });
    if (body.wait) return c.json(await awaitAuthoringWork(root, runId, Promise.resolve().then(workFactory)));
    startAuthoringWork(root, runId, workFactory);
    return c.json({ runId, status: "running", operation: "settle" });
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

  app.post("/api/v1/authoring/impact/recompute", async (c) => {
    const body = await c.req.json<{ bookId: string; wait?: boolean }>();
    if (!body.bookId) return c.json({ error: "缺少 bookId" }, 400);
    const project = await deps.loadProject();
    const root = storeRoot(deps.root, body);
    if (!(await isLightweightAuthoringBook(join(deps.root, "books", body.bookId)))) {
      return c.json({ error: "旧书不支持正典影响分辨" }, 400);
    }
    const manifest = await loadManifest(root);
    if (!manifest.adopted.ask) return c.json({ error: "还没有已采用的正典，无法重算影响" }, 400);
    const runId = newRunId();
    await persistStartingRun(root, emptyRun({
      runId,
      stage: "ask",
      operation: "review",
      roleId: "ask.review",
      bookId: body.bookId,
      scope: `impact:${manifest.impactBaseline?.ask ?? ""}..${manifest.adopted.ask}`,
      progressLabel: "正在分辨正典改动的影响",
    }));
    const workFactory = () => triageCanonImpact({
      root,
      project,
      runId,
      onProgress: onAuthoringProgress(deps, root),
    });
    if (body.wait) return c.json(await awaitAuthoringWork(root, runId, Promise.resolve().then(workFactory)));
    startAuthoringWork(root, runId, workFactory);
    return c.json({ runId, status: "running" });
  });

  app.post("/api/v1/authoring/impact/resolve", async (c) => {
    const body = await c.req.json<{ bookId: string; keys?: string[]; as: "reviewed" | "dismissed" }>();
    if (!body.bookId) return c.json({ error: "缺少 bookId" }, 400);
    if (body.as !== "reviewed" && body.as !== "dismissed") {
      return c.json({ error: "as 只能是 reviewed 或 dismissed" }, 400);
    }
    const root = storeRoot(deps.root, body);
    const report = await resolveImpactItems(root, { keys: body.keys, as: body.as });
    return c.json({
      ok: true,
      impact: report ? impactWorkspaceSummary(report) : undefined,
    });
  });

  app.get("/api/v1/authoring/impact/:impactId", async (c) => {
    const bookId = c.req.query("bookId") || undefined;
    const draftId = c.req.query("draftId") || undefined;
    const report = await loadImpactReport(storeRoot(deps.root, { bookId, draftId }), c.req.param("impactId"));
    if (!report) return c.json({ error: "找不到影响报告" }, 404);
    return c.json(report);
  });

  app.get("/api/v1/authoring/reports/:reportId", async (c) => {
    const bookId = c.req.query("bookId") || undefined;
    const draftId = c.req.query("draftId") || undefined;
    const report = await loadReport(storeRoot(deps.root, { bookId, draftId }), c.req.param("reportId"));
    if (!report) return c.json({ error: "找不到报告" }, 404);
    return c.json(report);
  });
}
