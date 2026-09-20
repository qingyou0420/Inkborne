/**
 * 研墨 authoring: catalog, scoped generate, review, adopt.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchJson, postApi, putApi, useApi } from "../hooks/use-api";
import { isBackgroundAuthoringStart, useAuthoringRun } from "../hooks/use-authoring-run";
import { groundRetryAction, selectScopedAuthoringRun, shouldAutoTakeoverAuthoringRun } from "../lib/authoring-run-selection";
import { goBookAuthoringStage } from "../lib/authoring-nav";
import { showToast } from "../lib/toast";
import type { AuthoringReport, AuthoringWorkspace } from "../lib/authoring-workspace";
import { GenerationRequirements } from "./GenerationRequirements";
import { workspaceQuery, reportForArtifact } from "../lib/authoring-workspace";
import { generationReviewNotes, withGenerationReview } from "../lib/generation-review-notes";
import { groundGenerationScope, groundRevisionScope } from "../lib/ground-task-scope";
import { AuthoringReviewDrawer } from "./AuthoringReviewDrawer";
import { createGroundCandidateEditor, pendingGroundEntry } from "../lib/ground-drafts";
import { useDraftDecision } from "../hooks/use-draft-decision";
import { ManuscriptView } from "./ManuscriptView";
import { ManuscriptHistoryDrawer } from "./ManuscriptHistoryDrawer";
import { RegenerateDialog } from "./RegenerateDialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { List, MoreHorizontal } from "lucide-react";
import { registerNavigationGuard } from "../lib/edit-navigation";

export function AuthoringGroundPanel(props: Parameters<typeof AuthoringGroundBook>[0]) {
  return <AuthoringGroundBook key={props.bookId} {...props} />;
}

function AuthoringGroundBook({
  bookId,
  isZh,
  legacySections = [],
  legacySectionId = null,
  onLegacySectionChange,
  legacyContent,
  legacyBusy = false,
  onBeforeLegacyLeave,
}: {
  readonly bookId: string;
  readonly isZh: boolean;
  readonly legacySections?: ReadonlyArray<{ id: string; label: string; ready: boolean }>;
  readonly legacySectionId?: string | null;
  readonly onLegacySectionChange?: (id: string | null) => void;
  readonly legacyContent?: ReactNode;
  readonly legacyBusy?: boolean;
  readonly onBeforeLegacyLeave?: () => Promise<boolean>;
}) {
  const { data, error: workspaceError, loading: workspaceLoading, refetch } = useApi<AuthoringWorkspace>(`/authoring/workspace?${workspaceQuery(bookId)}`);
  const entries = data?.catalog?.entries ?? [];
  const showLegacy = !workspaceLoading && data?.authoringBook === false && legacySections.length > 0;
  const coverage = data?.manifest?.coverage;
  const [selected, setSelected] = useState<string[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(() => pendingGroundEntry(bookId) ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reportOverride, setReport] = useState<AuthoringReport | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(true);
  const [batchMode, setBatchMode] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [generation, setGeneration] = useState<{ entryIds: string[]; regenerate?: boolean; issueIds?: ReadonlyArray<string>; reuseStale?: boolean; report?: AuthoringReport } | null>(null);
  const [requirementNotes, setRequirementNotes] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const authoringRun = useAuthoringRun(bookId, activeRunId);
  const decision = useDraftDecision(isZh);
  const visible = entries.filter((entry) => !entry.archived);
  const generationScope = groundGenerationScope(entries, selected);
  const focused = visible.find((entry) => entry.id === (focusedId ?? visible[0]?.id));
  const focusedArtifactId = focused?.candidateArtifactId ?? focused?.adoptedArtifactId;
  const focusedUrl = focusedArtifactId
    ? `/authoring/artifacts/${encodeURIComponent(focusedArtifactId)}?bookId=${encodeURIComponent(bookId)}`
    : "";
  const editor = useMemo(() => createGroundCandidateEditor(bookId, focused?.id ?? ""), [bookId, focused?.id]);
  const [, redrawEditor] = useState(0);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [artifactRetry, setArtifactRetry] = useState(0);
  const operationBusy = useRef(false);
  const artifactRequest = useRef(0);
  const draft = editor.snapshot;
  const report = reportOverride ?? reportForArtifact(data?.reports, draft.baseId) ?? null;
  const lastGroundRun = selectScopedAuthoringRun(data?.runs, "ground");

  const run = async (label: string, fn: () => Promise<unknown>) => {
    if (operationBusy.current || legacyBusy) return;
    operationBusy.current = true;
    setBusy(label);
    setFailure(null);
    try {
      const result = await fn();
      await refetch();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFailure(message);
      showToast(message, "error");
      return undefined;
    } finally {
      operationBusy.current = false;
      setBusy(null);
    }
  };

  useEffect(() => {
    if (activeRunId) return;
    if (lastGroundRun && shouldAutoTakeoverAuthoringRun(lastGroundRun)) setActiveRunId(lastGroundRun.runId);
  }, [activeRunId, lastGroundRun]);

  useEffect(() => {
    if (!authoringRun.settled || !authoringRun.run) return;
    void refetch();
    artifactRequest.current += 1;
    editor.generated();
    setArtifactRetry((value) => value + 1);
    if (authoringRun.run.status === "failed" || authoringRun.run.status === "partial") {
      setFailure(authoringRun.run.error ?? (isZh ? "有条目没有生成成功。" : "Some settings failed to generate."));
    }
  }, [authoringRun.settled, authoringRun.run, editor, isZh, refetch]);

  const generateLabel = !generationScope.regenerate
    ? (isZh ? `补全剩余 ${generationScope.entryIds.length} 项` : `Fill remaining ${generationScope.entryIds.length}`)
    : (isZh ? `重新生成 ${generationScope.entryIds.length} 项设定` : `Regenerate ${generationScope.entryIds.length} settings`);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++artifactRequest.current;
    if (editor.snapshot.dirty) {
      setArtifactError(null);
      setArtifactLoading(false);
      return;
    }
    if (!focusedArtifactId || !focusedUrl) {
      if (editor.load(undefined, "")) redrawEditor((value) => value + 1);
      setArtifactError(null);
      setArtifactLoading(false);
      return;
    }
    setArtifactLoading(true);
    setArtifactError(null);
    void fetchJson<{ body: string }>(focusedUrl).then((artifact) => {
      if (cancelled || requestId !== artifactRequest.current) return;
      if (editor.load(focusedArtifactId, artifact.body)) redrawEditor((value) => value + 1);
    }).catch((error: unknown) => {
      if (!cancelled && requestId === artifactRequest.current) setArtifactError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (!cancelled && requestId === artifactRequest.current) setArtifactLoading(false); });
    return () => { cancelled = true; };
  }, [focusedUrl, focusedArtifactId, artifactRetry, editor, draft.dirty]);

  const persistIfDirty = async (): Promise<string | undefined> => {
    const submitted = editor.snapshot;
    if (submitted.dirty) artifactRequest.current += 1;
    const savedId = await editor.save((baseId, body) => putApi<{ artifactId: string }>(`/authoring/artifacts/${encodeURIComponent(baseId)}`, { bookId, body }));
    setArtifactLoading(false);
    redrawEditor((value) => value + 1);
    await refetch();
    return savedId;
  };

  const discardEdits = () => { editor.change(editor.snapshot.savedBody); redrawEditor((value) => value + 1); setEditing(false); };
  const finishEditing = async (): Promise<boolean> => {
    if (operationBusy.current || legacyBusy) return false;
    if (!editor.snapshot.dirty) { setEditing(false); return true; }
    const answer = await decision.ask();
    if (answer === "cancel") { setEditing(true); return false; }
    if (answer === "discard") { discardEdits(); return true; }
    const saved = await run("save", async () => { await persistIfDirty(); return true; });
    if (saved === true) setEditing(false);
    return saved === true;
  };
  const selectEntry = async (id: string) => {
    if (focused?.id === id && !legacySectionId) return;
    if (legacySectionId && onBeforeLegacyLeave && !(await onBeforeLegacyLeave())) return;
    if (!legacySectionId && !(await finishEditing())) return;
    void run("switch", async () => {
      setFocusedId(id);
      setEditing(false); setReportOpen(false); setReport(null);
      onLegacySectionChange?.(null);
    });
  };

  const selectLegacy = async (id: string) => {
    if (legacySectionId && legacySectionId !== id && onBeforeLegacyLeave && !(await onBeforeLegacyLeave())) return;
    if (!legacySectionId && !(await finishEditing())) return;
    void run("switch", async () => {
      onLegacySectionChange?.(id);
      setEditing(false); setReportOpen(false);
    });
  };
  const leaveRef = useRef(finishEditing);
  leaveRef.current = finishEditing;
  useEffect(() => {
    if (legacySectionId || !draft.dirty) return;
    return registerNavigationGuard(() => leaveRef.current());
  }, [legacySectionId, draft.dirty]);

  useEffect(() => {
    if (legacySectionId) return;
    const saveShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (!editing || !editor.snapshot.dirty || artifactLoading || artifactError || document.querySelector('[role="dialog"]')) return;
      void run("save", async () => { await persistIfDirty(); setEditing(false); });
    };
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  });

  const grouped = useMemo(() => {
    const map = new Map<string, typeof visible>();
    for (const entry of visible) {
      const list = map.get(entry.category) ?? [];
      list.push(entry);
      map.set(entry.category, list);
    }
    return [...map.entries()];
  }, [visible]);

  const actionIds = batchMode ? selected : focused ? [focused.id] : [];
  const currentAdopted = Boolean(focusedArtifactId && focusedArtifactId === focused?.adoptedArtifactId && !draft.dirty);
  const history = (data?.artifacts ?? []).filter((item) => item.stage === "ground" && item.scope === focused?.id);
  const blocked = Boolean(busy) || legacyBusy || authoringRun.active || artifactLoading || Boolean(artifactError) || workspaceLoading || Boolean(workspaceError);
  const reviewCurrent = () => {
    if (blocked || editing || draft.dirty || actionIds.length === 0) return Promise.resolve(undefined);
    setReportOpen(true);
    return run("review", async () => {
      const next = await postApi<AuthoringReport & { runId?: string; status?: string }>("/authoring/ground/review", { bookId, entryIds: actionIds });
      if (isBackgroundAuthoringStart(next) && next.runId) { setActiveRunId(next.runId); return next; }
      setReport(next);
      return next;
    });
  };
  const generationNotes = generationReviewNotes(report, (generation?.entryIds ?? []).map((id) => { const item = visible.find((entry) => entry.id === id); return item?.candidateArtifactId ?? item?.adoptedArtifactId; }));
  const generateEntries = (entryIds: string[], regenerate: boolean, requirements = "") => run("generate", async () => {
    await persistIfDirty();
    const result = await postApi<{ runId?: string; status?: string; generated?: string[] }>("/authoring/ground/generate", { bookId, entryIds, regenerate, requirements: withGenerationReview(requirements, generationNotes) });
    if (isBackgroundAuthoringStart(result) && result.runId) setActiveRunId(result.runId);
    else { artifactRequest.current += 1; editor.generated(); setArtifactRetry((value) => value + 1); }
    setReportOpen(false); return true;
  });
  const startCatalog = () => run("catalog", async () => {
    await persistIfDirty();
    const result = await postApi<{ runId?: string; status?: string }>("/authoring/ground/catalog", { bookId });
    if (isBackgroundAuthoringStart(result) && result.runId) setActiveRunId(result.runId);
    return result;
  });
  const abandonRun = () => {
    if (!activeRunId) return;
    void postApi(`/authoring/runs/${encodeURIComponent(activeRunId)}/cancel`, { bookId });
  };
  const retryFailedRun = () => {
    const action = groundRetryAction(authoringRun.run ?? undefined, generationScope.entryIds.length > 0 || visible.length > 0);
    if (action === "review") void reviewCurrent();
    else if (action === "catalog") void startCatalog();
    else void generateEntries(generationScope.entryIds, generationScope.regenerate);
  };
  const groundRunStatus = authoringRun.active
    ? (authoringRun.run?.progressLabel ?? (isZh ? "正在生成设定…" : "Generating settings…"))
    : authoringRun.run?.status === "failed" || authoringRun.run?.status === "partial"
      ? (authoringRun.run.error ?? (isZh ? "有条目失败" : "Some entries failed"))
      : null;

  return (
    <section className={`space-y-4 ground-workspace ${reportOpen ? "review-is-open" : ""}`} data-testid="authoring-ground-panel">
      {workspaceError ? <p role="alert" className="text-sm text-destructive">{workspaceError}<button type="button" className="btn-ghost" onClick={() => void refetch()}>{isZh ? "重新加载" : "Retry loading"}</button></p> : null}
      {workspaceLoading ? <p role="status" className="text-sm text-muted-foreground">{isZh ? "正在载入设定…" : "Loading settings…"}</p> : null}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <button type="button" className="btn-ghost inline-flex items-center gap-2" aria-expanded={directoryOpen} onClick={() => setDirectoryOpen((value) => !value)}><List size={16} />{isZh ? "设定目录" : "Setting catalog"}</button>
          <p className="text-xs text-muted-foreground" role="status">
            {groundRunStatus ?? (isZh
              ? `已生成 ${coverage?.settingsGenerated ?? 0}/${coverage?.settingsTarget ?? visible.length} · 已采用 ${coverage?.settingsAdopted ?? 0}`
              : `Generated ${coverage?.settingsGenerated ?? 0}/${coverage?.settingsTarget ?? visible.length} · adopted ${coverage?.settingsAdopted ?? 0}`)}
            {authoringRun.active ? <button type="button" className="btn-ghost" data-testid="authoring-abandon-run" onClick={abandonRun}>{isZh ? "放弃这次运行" : "Abandon run"}</button> : null}
            {authoringRun.error ? <span role="alert">{authoringRun.error}</span> : null}
            {authoringRun.run?.error ? <button type="button" className="btn-ghost" onClick={() => setFailure(authoringRun.run?.error ?? null)}>{isZh ? "查看原因" : "See why"}</button> : null}
            {(authoringRun.run?.status === "failed" || authoringRun.run?.status === "partial") ? (
              <button type="button" className="btn-ghost" onClick={retryFailedRun}>
                {isZh ? "重试" : "Retry"}
              </button>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {visible.length === 0 ? <button
            type="button"
            className="btn-secondary text-sm disabled:opacity-40"
            disabled={blocked}
            onClick={() => void startCatalog()}
          >
            {busy === "catalog" ? (isZh ? "拟定中…" : "Planning…") : (isZh ? "根据正典拟定设定目录" : "Propose catalog")}
          </button> : <DropdownMenu>
            <DropdownMenuTrigger className="btn-ghost" aria-label={isZh ? "目录操作" : "Directory actions"} disabled={blocked || editing}><MoreHorizontal size={18} /></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => { setBatchMode((value) => !value); setSelected([]); }}>{batchMode ? (isZh ? "结束多选" : "Finish selecting") : (isZh ? "批量选择" : "Select a batch")}</DropdownMenuItem>
              <DropdownMenuItem disabled={generationScope.entryIds.length === 0} onClick={() => generationScope.regenerate ? setGeneration(generationScope) : void generateEntries(generationScope.entryIds, false, requirementNotes)}>{generateLabel}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void startCatalog()}>{isZh ? "重新拟定目录" : "Rebuild catalog"}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>}
        </div>
      </div>

      <div className={`one-workspace ${!directoryOpen ? "directory-collapsed" : ""}`}>
        <nav className="one-directory ground-directory" hidden={!directoryOpen} aria-label={isZh ? "设定目录" : "Setting catalog"}>
          {grouped.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {isZh ? "还没有设定目录。先根据正典拟定。" : "No catalog yet. Propose one from the canon."}
            </p>
          ) : grouped.map(([category, items]) => (
            <div key={category}>
              <div className="group">{category}</div>
              {items.map((entry) => {
                const status = entry.candidateArtifactId && !entry.adoptedArtifactId
                  ? (isZh ? "候选" : "candidate")
                  : entry.adoptedArtifactId && entry.candidateArtifactId && entry.adoptedArtifactId !== entry.candidateArtifactId
                    ? (isZh ? "已采用 · 新候选" : "adopted · new candidate")
                    : entry.adoptedArtifactId
                      ? (isZh ? "已采用" : "adopted")
                      : (isZh ? "未生成" : "empty");
                return (
                  <div key={entry.id} className="flex items-start gap-2">
                    {batchMode ? <input
                      type="checkbox"
                      className="mt-2"
                      checked={selected.includes(entry.id)}
                      disabled={Boolean(busy) || legacyBusy}
                      aria-label={isZh ? `选择 ${entry.name}` : `Select ${entry.name}`}
                      onChange={(event) => {
                        setSelected((prev) => event.target.checked
                          ? [...prev, entry.id]
                          : prev.filter((id) => id !== entry.id));
                      }}
                    /> : null}
                    <button
                      type="button"
                      className={`dir-item ${focused?.id === entry.id && !legacySectionId ? "active" : ""}`}
                      disabled={Boolean(busy) || legacyBusy}
                      aria-current={focused?.id === entry.id && !legacySectionId ? "page" : undefined}
                      onClick={() => void selectEntry(entry.id)}
                    >
                      {entry.name}
                      <small>{status}</small>
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
          {showLegacy ? <div data-testid="ground-toc" className="ground-legacy-directory">
            <div className="group">{isZh ? "已采用设定（旧书）" : "Adopted settings (legacy)"}</div>
            {legacySections.map((item) => <button
              key={item.id}
              type="button"
              data-testid={`ground-toc-${item.id}`}
              className={`dir-item ${legacySectionId === item.id ? "active" : ""}`}
              aria-current={legacySectionId === item.id ? "page" : undefined}
              disabled={Boolean(busy) || legacyBusy}
              onClick={() => void selectLegacy(item.id)}
            >{item.label}<small>{item.ready ? (isZh ? "已有资料" : "Available") : (isZh ? "待补充" : "To complete")}</small></button>)}
          </div> : null}
        </nav>

        <div className="one-document space-y-3">
          {legacySectionId ? legacyContent : <>
          {focused ? (
            <>
              <div className="version-state">
                <span>{isZh ? `条目正文 · ${focused.name}` : `Entry · ${focused.name}`}</span>
                {draft.dirty ? <span className="badge-quiet">{isZh ? "未保存" : "Unsaved"}</span> : null}
                {focused.candidateArtifactId && focused.candidateArtifactId !== focused.adoptedArtifactId
                  ? <span className="badge-quiet">{isZh ? "候选" : "candidate"}</span>
                  : focused.adoptedArtifactId
                    ? <span className="badge-quiet">{isZh ? "已采用" : "adopted"}</span>
                    : <span className="badge-quiet">{isZh ? "未生成" : "empty"}</span>}
              </div>
              {artifactLoading ? <p role="status" className="text-sm text-muted-foreground">{isZh ? "正在读取设定…" : "Loading setting…"}</p> : null}
              {draft.dirty && draft.baseId !== focusedArtifactId ? <p role="status" className="text-sm text-muted-foreground">{isZh ? "手改已保留，基于较早版本；保存会另建候选。" : "Your edits are retained from an earlier version. Saving creates a new candidate."}</p> : null}
              {artifactError ? <p role="alert" className="text-sm text-destructive">{artifactError}<button type="button" className="btn-ghost" onClick={() => setArtifactRetry((value) => value + 1)}>{isZh ? "重试" : "Retry"}</button></p> : null}
              {editing ? <textarea
                className="prose-body min-h-[280px] w-full rounded-md border border-input bg-background px-3 py-2"
                value={draft.body}
                disabled={Boolean(busy) || artifactLoading || Boolean(artifactError) || !draft.baseId}
                aria-label={isZh ? `编辑设定：${focused.name}` : `Edit setting: ${focused.name}`}
                onChange={(event) => {
                  editor.change(event.target.value);
                  redrawEditor((value) => value + 1);
                  setReport((current) => current ? { ...current, stale: true, staleReason: isZh ? "正文已修改，请先保存并重新审查。" : "Text changed. Save and review again." } : null);
                }}
                placeholder={isZh ? "生成后可在这里阅读和修改" : "Generated text can be read and edited here"}
                data-testid="ground-entry-body"
              /> : draft.baseId ? <ManuscriptView body={draft.body} /> : !artifactLoading && !artifactError ? <div className="py-12 space-y-5"><p className="text-muted-foreground">{isZh ? "这条设定尚未生成。" : "This setting has not been written yet."}</p><div className="flex flex-wrap items-center gap-2"><button type="button" className="btn-primary" disabled={blocked} data-testid="ground-generate" onClick={() => void generateEntries([focused.id], false, requirementNotes)}>{isZh ? "生成设定" : "Generate setting"}</button><GenerationRequirements value={requirementNotes} onChange={setRequirementNotes} isZh={isZh} disabled={blocked} /></div></div> : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {isZh ? "从左侧选择一条设定来阅读和修改。勾选用于批量生成、审查或采用。" : "Focus an entry on the left to edit. Checkboxes select a batch."}
            </p>
          )}
          {failure ? <p role="alert" className="text-sm text-destructive">{failure}</p> : null}
          {draft.baseId || batchMode ? <div className="manuscript-action-buttons ground-document-actions">
            {editing ? <>
              <button type="button" disabled={blocked || !draft.dirty} onClick={() => void run("save", async () => { await persistIfDirty(); setEditing(false); })}>{isZh ? "保存" : "Save"}</button>
              <button type="button" disabled={blocked} className="quiet" onClick={() => void finishEditing()}>{isZh ? "取消" : "Cancel"}</button>
            </> : <>
            <button type="button" disabled={blocked || !draft.baseId || batchMode} onClick={() => setEditing(true)}>{isZh ? "编辑" : "Edit"}</button>
            <button
              type="button"
              className="btn-secondary text-sm disabled:opacity-40"
              disabled={blocked || actionIds.length === 0 || draft.dirty}
              onClick={() => void reviewCurrent()}
            >
              {busy === "review" ? (isZh ? "审查中…" : "Reviewing…") : batchMode ? (isZh ? `审查所选 ${actionIds.length} 项` : `Review ${actionIds.length} selected`) : (isZh ? "审查" : "Review")}
            </button>
            <button
              type="button"
              className="btn-secondary text-sm disabled:opacity-40"
              disabled={blocked || actionIds.length === 0 || draft.dirty || (!batchMode && currentAdopted)}
              onClick={() => void run("adopt", async () => {
                const result = await postApi<{ adopted: string[] }>("/authoring/ground/adopt", { bookId, entryIds: actionIds });
                showToast(isZh ? `已采用 ${result.adopted.length} 项` : `Adopted ${result.adopted.length}`, "success", {
                  label: isZh ? "去织卷" : "Go to Weave",
                  onClick: () => goBookAuthoringStage(bookId, "weave"),
                });
                return result;
              })}
            >
              {batchMode ? (isZh ? `采用所选 ${actionIds.length} 项` : `Adopt ${actionIds.length} selected`) : currentAdopted ? (isZh ? "已采用" : "Adopted") : (isZh ? "采用" : "Adopt")}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger className="quiet" aria-label={isZh ? "更多操作" : "More actions"} disabled={blocked || draft.dirty}><MoreHorizontal size={17} /></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={actionIds.length === 0} onClick={() => setGeneration({ entryIds: actionIds })}>{isZh ? "重新生成" : "Regenerate"}</DropdownMenuItem>
                <DropdownMenuItem disabled={!focused || batchMode} onClick={() => setHistoryOpen(true)}>{isZh ? "历史版本" : "Version history"}</DropdownMenuItem>
                <DropdownMenuItem disabled={!report} onClick={() => setReportOpen(true)}>{isZh ? "查看审查意见" : "View review"}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </>}
          </div> : null}
          </>}
        </div>
      </div>

      <AuthoringReviewDrawer
        open={reportOpen}
        title={isZh ? "研墨审查" : "Ground review"}
        report={report && draft.dirty ? { ...report, stale: true, staleReason: isZh ? "正文已有未保存修改。" : "The text has unsaved edits." } : report}
        isZh={isZh}
        busy={busy === "review"}
        reviseDisabled={Boolean(busy) || editing || draft.dirty}
        error={failure}
        onRetry={() => void reviewCurrent()}
        onClose={() => setReportOpen(false)}
        currentArtifactId={draft.baseId}
        onRevise={(issueIds, reuseStale) => {
          if (!report) return;
          if (editing || draft.dirty) { showToast(isZh ? "请先保存或取消当前修改。" : "Save or cancel your edits first.", "info"); return; }
          const scope = groundRevisionScope(entries, report, issueIds, reuseStale);
          if ("error" in scope) { showToast(isZh ? "所选意见的目标或版本已变化，请重新审查对应设定后再修订。" : "The selected notes no longer match the target settings. Review those settings again.", "info"); return; }
          setGeneration({ entryIds: scope.entryIds, issueIds, reuseStale, report });
        }}
      />
      <RegenerateDialog open={Boolean(generation)} title={isZh ? (generation?.issueIds ? "按意见重新生成设定" : "生成设定") : "Generate settings"} scopeLabel={generation?.entryIds.map((id) => visible.find((entry) => entry.id === id)?.name ?? id).join("、")} isZh={isZh} busy={Boolean(busy)} error={failure} reportSummary={generation?.report?.summary ?? generationNotes} onClose={() => setGeneration(null)} onConfirm={async (requirements) => {
        if (!generation) return false;
        const ok = await run(generation.issueIds ? "revise" : "generate", async () => {
          if (generation.issueIds) {
            const scope = generation.report ? groundRevisionScope(entries, generation.report, generation.issueIds, generation.reuseStale) : null;
            if (!scope || "error" in scope || scope.entryIds.join("\0") !== generation.entryIds.join("\0")) throw new Error(isZh ? "修订目标已变化，请关闭窗口并重新选择意见。" : "Revision targets changed. Close this window and select the notes again.");
            const revised = await postApi<{ runId?: string; status?: string }>("/authoring/ground/revise", { bookId, reportId: generation.report!.reportId, selectedIssueIds: generation.issueIds, reuseStale: generation.reuseStale, requirements });
            if (isBackgroundAuthoringStart(revised) && revised.runId) setActiveRunId(revised.runId);
          } else {
            const generated = await postApi<{ runId?: string; status?: string }>("/authoring/ground/generate", { bookId, entryIds: generation.entryIds, regenerate: generation.regenerate ?? true, requirements: withGenerationReview(requirements, generationNotes) });
            if (isBackgroundAuthoringStart(generated) && generated.runId) setActiveRunId(generated.runId);
          }
          if (!activeRunId) { artifactRequest.current += 1; editor.generated(); setArtifactRetry((value) => value + 1); }
          setReportOpen(false); return true;
        });
        if (ok === true) setGeneration(null);
        return ok === true;
      }} />
      <ManuscriptHistoryDrawer open={historyOpen} bookId={bookId} title={isZh ? "设定版本" : "Setting versions"} artifacts={history} currentId={focusedArtifactId} adoptedId={focused?.adoptedArtifactId} isZh={isZh} busy={Boolean(busy)} onClose={() => setHistoryOpen(false)} onRestore={async (artifactId, body) => {
        const ok = await run("restore", async () => { await putApi(`/authoring/artifacts/${encodeURIComponent(artifactId)}`, { bookId, body }); editor.generated(); setArtifactRetry((value) => value + 1); return true; });
        return ok === true;
      }} />
      {decision.dialog}
    </section>
  );
}
