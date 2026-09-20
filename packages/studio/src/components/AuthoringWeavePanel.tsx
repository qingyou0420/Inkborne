/**
 * 织卷 authoring: full-book chapter coverage generate / review / adopt.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useRef, useState } from "react";
import { fetchJson, postApi, putApi, useApi } from "../hooks/use-api";
import { invalidateBookStage } from "../hooks/use-book-stage";
import { useChatStore } from "../store/chat";
import { showToast } from "../lib/toast";
import type { AuthoringReport, AuthoringWorkspace } from "../lib/authoring-workspace";
import { resolveAdoptArtifactId, workspaceQuery, reportForArtifact } from "../lib/authoring-workspace";
import { generationReviewNotes, withGenerationReview } from "../lib/generation-review-notes";
import { pollWeaveRun, resolveWeaveVolumeRange } from "../lib/weave-editor-state";
import { weaveLengthGateCopy } from "../lib/stage-copy";
import { LiteraryEmpty } from "./LiteraryEmpty";
import { AuthoringReviewDrawer } from "./AuthoringReviewDrawer";
import { useDraftDecision } from "../hooks/use-draft-decision";
import { ManuscriptView } from "./ManuscriptView";
import { ManuscriptHistoryDrawer } from "./ManuscriptHistoryDrawer";
import { RegenerateDialog } from "./RegenerateDialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import "./write-workspace.css";
import { registerNavigationGuard } from "../lib/edit-navigation";
import { parseVolumeMapTree } from "../lib/volume-map-tree";

interface WeaveRun {
  readonly runId: string;
  readonly status: string;
  readonly progressDone?: number;
  readonly progressTotal?: number;
  readonly progressLabel?: string;
  readonly error?: string;
}

/** Adoption changes the file facts used by the shared four-stage navigation. */
export async function adoptWeaveAndRefreshStage(bookId: string, artifactId: string): Promise<{ message?: string }> {
  const result = await postApi<{ message?: string }>("/authoring/weave/adopt", { bookId, artifactId });
  invalidateBookStage(bookId);
  useChatStore.getState().bumpBookDataVersion();
  return result;
}

// Route changes preserve hand edits for this app session. Formal saves still use the API.
const pendingWeaveEdits = new Map<string, { body: string; baseId: string; savedBody: string }>();
let unloadGuardInstalled = false;
function installUnloadGuard() {
  if (unloadGuardInstalled || typeof window === "undefined") return;
  unloadGuardInstalled = true;
  window.addEventListener("beforeunload", (event) => {
    if (pendingWeaveEdits.size === 0) return;
    event.preventDefault(); event.returnValue = "";
  });
}

export function AuthoringWeavePanel({
  bookId,
  targetChapters,
  isZh,
  onAdopted,
  active = true,
  onRegisterBeforeLeave,
  preferredVolume,
  onGoAsk,
}: {
  readonly bookId: string;
  readonly targetChapters: number;
  readonly isZh: boolean;
  readonly onAdopted?: () => void;
  readonly active?: boolean;
  readonly onRegisterBeforeLeave?: (guard: (() => Promise<boolean>) | null) => void;
  readonly preferredVolume?: { readonly startChapter: number; readonly endChapter: number } | null;
  readonly onGoAsk?: () => void;
}) {
  const { data, error: workspaceError, refetch } = useApi<AuthoringWorkspace>(`/authoring/workspace?${workspaceQuery(bookId)}`);
  const coverage = data?.manifest?.coverage;
  const candidate = data?.candidateWeave;
  const lastWeave = data?.runs?.find((item) => item.stage === "weave");
  const [endChapter, setEndChapter] = useState(String(targetChapters || ""));
  const [startChapter, setStartChapter] = useState("1");
  const [busy, setBusy] = useState<string | null>(null);
  const [reportOverride, setReport] = useState<AuthoringReport | null>(null);
  const report = reportOverride ?? reportForArtifact(data?.reports, candidate?.artifactId) ?? null;
  const [reportOpen, setReportOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [generation, setGeneration] = useState<{ issueIds?: ReadonlyArray<string>; reuseStale?: boolean; mode?: "chapters" | "structure" } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const decision = useDraftDecision(isZh);
  const restoredEdit = useRef(pendingWeaveEdits.get(bookId));
  const [editBody, setEditBody] = useState(restoredEdit.current?.body ?? "");
  const [dirty, setDirty] = useState(Boolean(restoredEdit.current));
  const dirtyRef = useRef(dirty);
  const editBaseId = useRef(restoredEdit.current?.baseId);
  const savedBodyRef = useRef(restoredEdit.current?.savedBody ?? "");
  const pendingSavedId = useRef<string | undefined>(undefined);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<WeaveRun | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollEpoch, setPollEpoch] = useState(0);
  const actionRef = useRef(false);
  const generated = coverage?.chaptersGenerated ?? 0;
  const canonTarget = data?.canon?.targetChapters;
  const lengthMissing = Boolean(data) && !(typeof canonTarget === "number" && canonTarget > 0);
  const target = (typeof canonTarget === "number" && canonTarget > 0)
    ? canonTarget
    : (targetChapters || coverage?.chaptersTarget || 0);
  const adoptedId = data?.manifest?.adopted?.weave;
  const hasAdoptedStructure = Boolean(adoptedId);
  const plannedVolumes = parseVolumeMapTree(candidate?.body ?? "").volumes
    .filter((volume) => volume.startChapter != null && volume.endChapter != null)
    .map((volume) => ({
      volumeNumber: volume.volumeNumber,
      title: volume.title,
      startChapter: volume.startChapter!,
      endChapter: volume.endChapter!,
    }));
  const currentScope = candidate?.scope
    ?? data?.artifacts?.find((item) => item.artifactId === (pendingSavedId.current ?? candidate?.artifactId))?.scope;
  const filledChapterCount = parseVolumeMapTree(candidate?.body ?? "").chapterCount;
  const isStructureCandidate = currentScope === "structure"
    || (filledChapterCount === 0 && plannedVolumes.length > 0);
  const run = liveRun ?? (activeRunId && lastWeave?.runId === activeRunId ? lastWeave : null);
  const running = busy === "generate" || Boolean(run && (run.status === "running" || run.status === "pausing"));

  useEffect(() => {
    if (!data || dirtyRef.current || actionRef.current) return;
    if (pendingSavedId.current && candidate?.artifactId !== pendingSavedId.current) return;
    pendingSavedId.current = undefined;
    setEditBody(candidate?.body ?? "");
    savedBodyRef.current = candidate?.body ?? "";
    editBaseId.current = candidate?.artifactId;
  }, [data, candidate?.artifactId, candidate?.body, busy, dirty]);

  useEffect(() => {
    if (activeRunId) return;
    if (lastWeave && (lastWeave.status === "running" || lastWeave.status === "pausing" || lastWeave.status === "paused" || lastWeave.status === "partial" || lastWeave.status === "failed")) {
      setActiveRunId(lastWeave.runId);
      setLiveRun(lastWeave);
    }
  }, [activeRunId, lastWeave]);

  useEffect(() => {
    if (!activeRunId) return undefined;
    let cancelled = false;
    const stop = pollWeaveRun({
      read: () => fetchJson<WeaveRun>(`/authoring/runs/${encodeURIComponent(activeRunId)}?bookId=${encodeURIComponent(bookId)}`),
      update: (next) => {
        setLiveRun(next);
        setPollError(null);
      },
      settled: async () => {
        await refetch();
        if (!cancelled) setBusy((current) => current === "generate" ? null : current);
      },
      error: (error) => setPollError(error instanceof Error ? error.message : String(error)),
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [activeRunId, bookId, refetch, pollEpoch]);

  const runAction = async (label: string, fn: () => Promise<unknown>, after?: "adopt") => {
    if (actionRef.current) return undefined;
    actionRef.current = true;
    setBusy(label);
    setFailure(null);
    try {
      const result = await fn();
      await refetch();
      if (after === "adopt") onAdopted?.();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFailure(message);
      showToast(message, "error");
      return undefined;
    } finally {
      actionRef.current = false;
      setBusy(null);
    }
  };

  const persistIfDirty = async (): Promise<string | undefined> => {
    if (!dirtyRef.current) return pendingSavedId.current ?? candidate?.artifactId;
    const baseId = editBaseId.current;
    if (!baseId) throw new Error(isZh ? "手稿的原候选尚未加载，请重试。" : "The original candidate has not loaded. Please retry.");
    const savingDraft = pendingWeaveEdits.get(bookId);
    const saved = await putApi<{ artifactId: string }>(`/authoring/artifacts/${encodeURIComponent(baseId)}`, {
      bookId,
      body: editBody,
    });
    dirtyRef.current = false;
    setDirty(false);
    savedBodyRef.current = editBody;
    editBaseId.current = saved.artifactId;
    pendingSavedId.current = saved.artifactId;
    if (pendingWeaveEdits.get(bookId) === savingDraft) pendingWeaveEdits.delete(bookId);
    await refetch();
    return saved.artifactId;
  };

  const applyVolumeRange = (volume?: { startChapter: number; endChapter: number }) => {
    const next = volume ?? resolveWeaveVolumeRange(plannedVolumes, preferredVolume, target);
    setStartChapter(String(next.startChapter));
    setEndChapter(String(next.endChapter));
  };
  const openChapterGeneration = () => {
    applyVolumeRange();
    setGeneration({ mode: "chapters" });
  };

  const startGenerate = async (requirements: string): Promise<boolean> => {
    if (actionRef.current || running) return false;
    const first = Number(startChapter);
    const last = Number(endChapter);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) {
      showToast(isZh ? "请输入有效章范围，结束章不能小于开始章。" : "Enter a valid chapter range.", "error");
      return false;
    }
    actionRef.current = true;
    setBusy("generate");
    setFailure(null);
    try {
      await persistIfDirty();
      const result = await postApi<WeaveRun & { beats?: unknown }>( "/authoring/weave/generate", {
        bookId,
        startChapter: Number(startChapter) || 1,
        endChapter: Number(endChapter) || target,
        targetChapters: target || undefined,
        requirements,
      });
      pendingSavedId.current = undefined;
      if (result.runId) {
        setActiveRunId(result.runId);
        setPollEpoch((epoch) => epoch + 1);
        setLiveRun({ runId: result.runId, status: result.status ?? "running", progressLabel: result.progressLabel });
      } else {
        await refetch();
        setBusy(null);
      }
      setReportOpen(false);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFailure(message);
      showToast(message, "error");
      setBusy(null);
      return false;
    } finally {
      actionRef.current = false;
    }
  };

  const leaveRef = useRef<() => Promise<boolean>>(async () => true);
  const discardEdits = () => { setEditBody(savedBodyRef.current); dirtyRef.current = false; setDirty(false); pendingWeaveEdits.delete(bookId); setEditing(false); };
  leaveRef.current = async () => {
    if (actionRef.current) return false;
    if (!dirtyRef.current) { setEditing(false); return true; }
    if (running) return false;
    const answer = await decision.ask();
    if (answer === "cancel") { setEditing(true); return false; }
    if (answer === "discard") { discardEdits(); return true; }
    let saved = false;
    await runAction("save", async () => { await persistIfDirty(); setEditing(false); saved = true; });
    return saved;
  };
  useEffect(() => {
    onRegisterBeforeLeave?.(() => leaveRef.current());
    return () => onRegisterBeforeLeave?.(null);
  }, [onRegisterBeforeLeave]);
  useEffect(() => {
    if (!active || !dirty) return;
    return registerNavigationGuard(() => leaveRef.current());
  }, [active, dirty]);
  useEffect(() => {
    if (!active) setReportOpen(false);
  }, [active]);
  const saveRef = useRef<() => Promise<unknown>>(async () => undefined);
  saveRef.current = () => runAction("save", async () => { await persistIfDirty(); setEditing(false); });
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !document.querySelector('[role="dialog"]')) {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, editing]);
  useEffect(() => { installUnloadGuard(); }, []);

  const rangeDone = run?.status === "completed";
  const canResume = Boolean(run && (run.status === "partial" || run.status === "paused" || run.status === "failed"));
  const activeReport = report && dirty ? { ...report, stale: true, staleReason: isZh ? "规划已有未保存手改，这份报告对应修改前的稿件。" : "Unsaved edits have changed the reviewed outline." } : report;
  const history = (data?.artifacts ?? []).filter((item) => item.stage === "weave");
  const currentId = pendingSavedId.current ?? editBaseId.current ?? candidate?.artifactId;
  const reviewCurrent = () => {
    if (actionRef.current || editing || dirty || running) return Promise.resolve(undefined);
    setReportOpen(true);
    return runAction("review", async () => { const artifactId = resolveAdoptArtifactId(currentId, candidate?.artifactId); const next = await postApi<AuthoringReport>("/authoring/weave/review", { bookId, artifactId, coverage: isZh ? "整份规划" : "Entire outline" }); setReport(next); return next; });
  };
  const generationNotes = generationReviewNotes(activeReport, [currentId]);

  if (lengthMissing) {
    const gate = weaveLengthGateCopy(isZh);
    return (
      <section className="space-y-5" data-testid="authoring-weave-panel">
        <LiteraryEmpty
          title={gate.title}
          subtitle={gate.subtitle}
          action={onGoAsk ? gate.action : undefined}
          onAction={onGoAsk}
          testId="weave-length-gate"
        />
      </section>
    );
  }

  return (
    <section className={`space-y-5 ${reportOpen ? "review-is-open" : ""}`} data-testid="authoring-weave-panel">
      {workspaceError && <p role="alert" className="text-sm text-destructive">{workspaceError} <button type="button" onClick={() => void refetch()}>{isZh ? "重新加载" : "Retry loading"}</button></p>}
      {pollError && <p role="alert" className="text-sm text-destructive">{isZh ? "进度暂时无法读取，正在重试。" : "Unable to read progress. Retrying."} {pollError}</p>}
      {run?.error && <p role="alert" className="text-sm text-destructive">{run.error}</p>}
      {dirty && candidate && editBaseId.current !== candidate.artifactId && <p role="status" className="text-sm text-muted-foreground">{isZh ? "候选已有新版本。你的手改已保留，保存会生成新候选。" : "A newer candidate exists. Your edits are retained and will save as a new candidate."}</p>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl">{isZh ? "全书规划" : "Book outline"}</h2>
          <p className="text-sm text-muted-foreground">
            {isZh
              ? `全书 ${target || "—"} 章 · 已有概要 ${generated} · 已采用 ${coverage?.chaptersAdopted ?? 0}`
              : `Book ${target || "—"} ch · outlined ${generated} · adopted ${coverage?.chaptersAdopted ?? 0}`}
            {run?.progressLabel ? ` · ${run.progressLabel}` : ""}
            {rangeDone ? (isZh ? " · 本次范围已完成" : " · this range complete") : ""}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">{dirty ? (isZh ? "未保存修改" : "Unsaved edits") : currentId === adoptedId && adoptedId ? (isZh ? "已采用" : "Adopted") : (isZh ? "候选" : "Candidate")}</span>
      </div>
      <RegenerateDialog open={Boolean(generation)} title={generation?.mode === "structure" ? (isZh ? "重新规划分卷" : "Replan volumes") : (isZh ? "规划章节概要" : "Plan chapter summaries")} scopeLabel={generation?.mode === "structure" ? (isZh ? `全书 ${target || "—"} 章` : `Book ${target || "—"} ch`) : (isZh ? `第 ${startChapter}–${endChapter} 章` : `Chapters ${startChapter}–${endChapter}`)} isZh={isZh} busy={Boolean(busy)} error={failure} reportSummary={generation?.issueIds && report ? report.summary : generationNotes} onClose={() => setGeneration(null)} onConfirm={async (requirements) => {
        if (!generation) return false;
        const ok = generation.issueIds && report && currentId ? (await runAction("revise", async () => {
          const result = await postApi<WeaveRun>("/authoring/weave/revise", {
            bookId,
            artifactId: currentId,
            reportId: report.reportId,
            selectedIssueIds: generation.issueIds,
            startChapter: Number(startChapter) || 1,
            endChapter: Number(endChapter) || target,
            reuseStale: generation.reuseStale,
            requirements,
            reviseStructure: isStructureCandidate,
          });
          if (result.runId) {
            setActiveRunId(result.runId);
            setPollEpoch((epoch) => epoch + 1);
            setLiveRun(result);
          }
          pendingSavedId.current = undefined; setReportOpen(false); return true;
        })) === true
          : generation.mode === "structure"
            ? (await runAction("generate", async () => {
              await postApi("/authoring/weave/structure", { bookId, requirements });
              pendingSavedId.current = undefined;
              return true;
            })) === true
            : await startGenerate(withGenerationReview(requirements, generationNotes));
        if (ok) setGeneration(null);
        return ok;
      }}>
        {generation?.mode === "structure" ? null : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {plannedVolumes.length > 0 ? (
            <label>
              {isZh ? "本卷" : "Volume"}
              <select
                className="ml-1 rounded-md border border-border bg-background px-2 py-1"
                value={`${startChapter}-${endChapter}`}
                disabled={Boolean(busy) || running}
                onChange={(event) => {
                  const volume = plannedVolumes.find((item) => `${item.startChapter}-${item.endChapter}` === event.target.value);
                  if (volume) applyVolumeRange(volume);
                }}
              >
                {plannedVolumes.map((volume) => (
                  <option key={`${volume.startChapter}-${volume.endChapter}`} value={`${volume.startChapter}-${volume.endChapter}`}>
                    {isZh ? `第${volume.volumeNumber ?? "?"}卷 ${volume.title}（${volume.startChapter}-${volume.endChapter}章）` : `Vol ${volume.volumeNumber ?? "?"} ${volume.title} (${volume.startChapter}-${volume.endChapter})`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            {isZh ? "从" : "From"}
            <input
              type="number"
              min={1}
              className="ml-1 w-16 rounded-md border border-border bg-background px-2 py-1"
              value={startChapter}
              disabled={Boolean(busy) || running}
              onChange={(event) => setStartChapter(event.target.value)}
            />
          </label>
          <label>
            {isZh ? "到" : "to"}
            <input
              type="number"
              min={1}
              className="ml-1 w-16 rounded-md border border-border bg-background px-2 py-1"
              value={endChapter}
              disabled={Boolean(busy) || running}
              onChange={(event) => setEndChapter(event.target.value)}
            />
          </label>
        </div>
        )}
      </RegenerateDialog>
      {candidate || editBaseId.current ? (
        editing ? <textarea
          className="prose-body min-h-[200px] w-full rounded-md border border-input bg-background px-3 py-2"
          value={editBody}
          readOnly={Boolean(busy) || running}
          aria-label={isZh ? "全书大纲候选" : "Book outline candidate"}
          onChange={(event) => {
            if (actionRef.current || running) return;
            const body = event.target.value;
            const changed = body !== savedBodyRef.current;
            dirtyRef.current = changed;
            setDirty(changed);
            setEditBody(body);
            if (changed && editBaseId.current) pendingWeaveEdits.set(bookId, { body, baseId: editBaseId.current, savedBody: savedBodyRef.current });
            else pendingWeaveEdits.delete(bookId);
          }}
          data-testid="weave-candidate-body"
        /> : <ManuscriptView body={editBody} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {isZh
            ? (hasAdoptedStructure ? "还没有本章概要候选。可按卷或章范围生成。" : `还没有分卷规划。先生成全书与分卷结构（全书 ${target || "—"} 章）。`)
            : (hasAdoptedStructure ? "No chapter-summary candidate yet." : "Generate the book/volume structure first.")}
        </p>
      )}
      {failure ? <p role="alert" className="text-sm text-destructive">{failure}</p> : null}
      <div className="manuscript-action-buttons ground-document-actions">
        {editing ? <>
          <button type="button" disabled={Boolean(busy) || running || !dirty} onClick={() => void runAction("save", async () => { await persistIfDirty(); setEditing(false); })}>{isZh ? "保存" : "Save"}</button>
          <button type="button" className="quiet" disabled={Boolean(busy) || running} onClick={() => void leaveRef.current()}>{isZh ? "取消" : "Cancel"}</button>
        </> : candidate || editBaseId.current ? <>
          <button type="button" disabled={Boolean(busy) || running} onClick={() => setEditing(true)}>{isZh ? "编辑" : "Edit"}</button>
          <button type="button" disabled={!candidate || Boolean(busy) || running || dirty} onClick={() => void reviewCurrent()}>{busy === "review" ? (isZh ? "审查中…" : "Reviewing…") : (isZh ? "审查" : "Review")}</button>
          <button type="button" disabled={!candidate || Boolean(busy) || running || dirty || currentId === adoptedId} onClick={() => void runAction("adopt", async () => {
            const artifactId = resolveAdoptArtifactId(currentId, candidate?.artifactId);
            const result = await adoptWeaveAndRefreshStage(bookId, artifactId);
            showToast(result.message ?? (isZh ? "整份规划已采用" : "Outline adopted"), "success"); return result;
          }, "adopt")}>{currentId === adoptedId ? (isZh ? "已采用" : "Adopted") : (isZh ? "采用" : "Adopt")}</button>
          {hasAdoptedStructure ? <button type="button" data-testid="outline-weave-chapters" disabled={Boolean(busy) || running || dirty || currentId !== adoptedId} onClick={openChapterGeneration}>{isZh ? "生成本卷章概要" : "Plan chapter summaries"}</button> : null}
          <span className="text-xs text-muted-foreground">{isZh ? "作用于整份规划" : "Applies to the entire outline"}</span>
          <DropdownMenu><DropdownMenuTrigger className="quiet" aria-label={isZh ? "成果操作" : "Manuscript actions"} disabled={Boolean(busy) || running || dirty}><MoreHorizontal size={17} /></DropdownMenuTrigger><DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!hasAdoptedStructure || currentId !== adoptedId} onClick={openChapterGeneration}>{isZh ? "生成本次章概要" : "Plan chapter range"}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setGeneration({ mode: "structure" })}>{isZh ? "重新规划分卷" : "Replan volumes"}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setHistoryOpen(true)}>{isZh ? "历史版本" : "Version history"}</DropdownMenuItem>
            <DropdownMenuItem disabled={!report} onClick={() => setReportOpen(true)}>{isZh ? "查看审查意见" : "View review"}</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu>
        </> : <button
          type="button"
          data-testid="outline-weave"
          className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
          disabled={Boolean(busy) || running}
          onClick={() => {
            if (hasAdoptedStructure) {
              openChapterGeneration();
              return;
            }
            void runAction("generate", async () => {
              await postApi("/authoring/weave/structure", { bookId });
              pendingSavedId.current = undefined;
            });
          }}
        >
          {running
            ? (isZh ? `正在规划… ${run?.progressLabel ?? ""}` : `Planning… ${run?.progressLabel ?? ""}`)
            : hasAdoptedStructure
              ? (isZh ? "生成本卷章概要" : "Plan chapter summaries")
              : (isZh ? "生成分卷规划" : "Plan volumes")}
        </button>}
        {canResume && !running ? (
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
            disabled={Boolean(busy) || editing || dirty}
            onClick={() => void runAction("resume", async () => {
              await persistIfDirty();
              const result = await postApi<WeaveRun>(`/authoring/runs/${run!.runId}/resume`, { bookId });
              pendingSavedId.current = undefined;
              if (result.runId) {
                setActiveRunId(result.runId);
                setPollEpoch((epoch) => epoch + 1);
                setLiveRun(result);
              }
              return result;
            })}
          >
            {isZh ? "继续剩余范围" : "Resume remaining"}
          </button>
        ) : null}
        {running && activeRunId ? (
          <button
            type="button"
            data-testid="outline-weave-pause"
            className="rounded-lg border border-border px-3 py-2 text-sm"
            onClick={() => void runAction("pause", () => postApi(`/authoring/runs/${activeRunId}/pause`, { bookId }))}
          >
            {isZh ? "暂停" : "Pause"}
          </button>
        ) : null}
      </div>

      <AuthoringReviewDrawer
        key={report?.reportId ?? "closed"}
        open={reportOpen}
        title={isZh ? "织卷审查" : "Weave review"}
        report={activeReport}
        currentArtifactId={pendingSavedId.current ?? editBaseId.current ?? candidate?.artifactId}
        isZh={isZh}
        busy={busy === "review"}
        reviseDisabled={Boolean(busy) || editing || dirty || running}
        error={failure}
        onRetry={() => void reviewCurrent()}
        onClose={() => setReportOpen(false)}
        onRevise={(issueIds, reuseStale) => {
          if (!candidate || !report) return;
          if (editing || dirty) { showToast(isZh ? "请先保存或取消当前修改。" : "Save or cancel your edits first.", "info"); return; }
          if (!isStructureCandidate) applyVolumeRange();
          setGeneration({ issueIds, reuseStale, mode: isStructureCandidate ? "structure" : "chapters" });
        }}
      />
      <ManuscriptHistoryDrawer open={historyOpen} bookId={bookId} title={isZh ? "规划版本" : "Outline versions"} artifacts={history} currentId={currentId} adoptedId={adoptedId} isZh={isZh} busy={Boolean(busy)} onClose={() => setHistoryOpen(false)} onRestore={async (artifactId, body) => {
        const ok = await runAction("restore", async () => { await putApi(`/authoring/artifacts/${encodeURIComponent(artifactId)}`, { bookId, body }); pendingSavedId.current = undefined; return true; });
        return ok === true;
      }} />
      {decision.dialog}
    </section>
  );
}
