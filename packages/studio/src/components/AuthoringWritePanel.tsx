/**
 * 落笔 authoring: candidate editing, independent review, and explicit adoption.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useEffect, useRef, useState } from "react";
import { Check, MoreHorizontal, PenLine, Save } from "lucide-react";
import { isTransientNetworkFetchError } from "../lib/error-copy";
import { fetchJson, postApi, putApi, useApi } from "../hooks/use-api";
import {
  AUTHORING_SUBMIT_UNKNOWN_MESSAGE,
  AuthoringSubmitUnknownError,
  isAuthoringSubmitUnknown,
  matchActiveAuthoringSubmit,
  recoverAuthoringSubmit,
  submitAuthoringAction,
} from "../lib/recover-authoring-submit";
import { isAuthoringRunActive, isBackgroundAuthoringStart, useAuthoringRun } from "../hooks/use-authoring-run";
import { previousChapterSettleHold, producedArtifactForScope, selectScopedAuthoringRun, shouldAutoTakeoverAuthoringRun, writeRetryAction } from "../lib/authoring-run-selection";
import { writeStateMissing } from "../lib/write-directory";
import { goBookAuthoringStage } from "../lib/authoring-nav";
import { showToast } from "../lib/toast";
import type { AuthoringImpactSummary, AuthoringReport, AuthoringWorkspace } from "../lib/authoring-workspace";
import { currentWriteArtifact, reportForArtifact, resolveAdoptArtifactId, workspaceQuery } from "../lib/authoring-workspace";
import {
  findImpactTriageRun,
  rememberImpactFocus,
  writeImpactActionLabel,
  writeImpactBanner,
} from "../lib/impact-view";
import { GenerationRequirements } from "./GenerationRequirements";
import { AuthoringDiffDrawer } from "./AuthoringDiffDrawer";
import { AuthoringReviewDrawer } from "./AuthoringReviewDrawer";
import { ManuscriptView } from "./ManuscriptView";
import { ManuscriptHistoryDrawer } from "./ManuscriptHistoryDrawer";
import { RegenerateDialog } from "./RegenerateDialog";
import { useDraftDecision } from "../hooks/use-draft-decision";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { registerNavigationGuard } from "../lib/edit-navigation";
import { generationReviewNotes, withGenerationReview } from "../lib/generation-review-notes";
import "./write-workspace.css";

// Retain unsaved text when a route temporarily unmounts the editor. This is only
// a session buffer; formal candidates still go through the authoring API.
const pendingWriteEdits = new Map<string, { body: string; baseId?: string; savedBody: string }>();
let unloadGuardInstalled = false;
function installUnloadGuard() {
  if (unloadGuardInstalled || typeof window === "undefined") return;
  unloadGuardInstalled = true;
  window.addEventListener("beforeunload", (event) => {
    if (pendingWriteEdits.size === 0) return;
    event.preventDefault(); event.returnValue = "";
  });
}
export type WriteLeaveGuard = () => Promise<boolean>;

export function AuthoringWritePanel({ bookId, chapterNumber, chapterTitle, isZh, onChanged, onRegisterBeforeLeave, onGoNextChapter }: {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly chapterTitle?: string;
  readonly isZh: boolean;
  readonly onChanged?: () => void;
  readonly onRegisterBeforeLeave?: (guard: WriteLeaveGuard | null) => void;
  readonly onGoNextChapter?: () => void;
}) {
  const { data, error: workspaceError, refetch } = useApi<AuthoringWorkspace>(`/authoring/workspace?${workspaceQuery(bookId)}`);
  const bufferKey = `${bookId}:${chapterNumber}`;
  const scope = `chapter:${chapterNumber}`;
  const candidate = currentWriteArtifact(data, chapterNumber);
  const adoptedId = data?.manifest?.adopted?.write?.[String(chapterNumber)];
  const parentId = candidate?.parentArtifactId && candidate.parentArtifactId !== candidate.artifactId ? candidate.parentArtifactId : undefined;
  const restoredEdit = useRef(pendingWriteEdits.get(bufferKey));
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [report, setReport] = useState<AuthoringReport | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [generation, setGeneration] = useState<{ issueIds?: ReadonlyArray<string>; reuseStale?: boolean } | null>(null);
  const [requirementNotes, setRequirementNotes] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [settleArtifactId, setSettleArtifactId] = useState<string | null>(null);
  const authoringRun = useAuthoringRun(bookId, activeRunId);
  const decision = useDraftDecision(isZh);
  const [body, setBody] = useState(restoredEdit.current?.body ?? "");
  const [dirty, setDirty] = useState(Boolean(restoredEdit.current));
  const dirtyRef = useRef(dirty);
  const editBaseId = useRef(restoredEdit.current?.baseId);
  const savedBodyRef = useRef(restoredEdit.current?.savedBody ?? "");
  const lastLoadedId = useRef("");
  const pendingSavedId = useRef<string | undefined>(undefined);
  const artifactUrl = candidate ? `/authoring/artifacts/${encodeURIComponent(candidate.artifactId)}?bookId=${encodeURIComponent(bookId)}` : "";
  const { data: artifact, error: artifactError, refetch: refetchArtifact } = useApi<{ body?: string; meta?: { artifactId?: string } }>(artifactUrl);
  const chapterUrl = !candidate ? `/books/${encodeURIComponent(bookId)}/chapters/${chapterNumber}` : "";
  const { data: existingChapter, loading: chapterLoading } = useApi<{ content?: string; chapterNumber?: number }>(chapterUrl);
  const artifactForCurrent = artifact?.meta?.artifactId === candidate?.artifactId ? artifact : undefined;
  const chapterForCurrent = existingChapter?.chapterNumber === chapterNumber ? existingChapter : undefined;
  const ready = Boolean(data) && (candidate ? artifactForCurrent?.body != null : !chapterLoading);
  const lastWriteRun = selectScopedAuthoringRun(data?.runs, "write", scope);
  const previousSettleHold = previousChapterSettleHold(data?.runs, chapterNumber);
  const previousSettleId = previousSettleHold && isAuthoringRunActive(previousSettleHold.status) ? previousSettleHold.runId : null;
  const previousSettleWatch = useAuthoringRun(bookId, previousSettleId);
  const previousSettleActive = Boolean(previousSettleId) && (previousSettleWatch.active || !previousSettleWatch.settled);
  const chapterStateMissing = writeStateMissing({
    adoptedId,
    stateArtifactId: data?.writeStateRefs?.[String(chapterNumber)],
  });

  useEffect(() => {
    if (activeRunId) return;
    if (lastWriteRun && shouldAutoTakeoverAuthoringRun(lastWriteRun)) setActiveRunId(lastWriteRun.runId);
  }, [activeRunId, lastWriteRun]);

  useEffect(() => {
    if (!previousSettleWatch.settled) return;
    void refetch();
  }, [previousSettleWatch.settled, refetch]);

  useEffect(() => {
    if (!authoringRun.settled || !authoringRun.run) return;
    void refetch();
    onChanged?.();
    if (authoringRun.run.status === "failed" || authoringRun.run.status === "partial") {
      setFailure(authoringRun.run.error ?? (isZh ? "这次操作没有完成。" : "This run did not finish."));
    } else {
      setFailure(null);
      const produced = producedArtifactForScope(authoringRun.run, scope);
      if (produced) pendingSavedId.current = produced;
    }
  }, [authoringRun.settled, authoringRun.run, isZh, onChanged, refetch]);

  useEffect(() => {
    if (dirtyRef.current || busyRef.current || !ready) return;
    if (pendingSavedId.current && candidate?.artifactId !== pendingSavedId.current) return;
    pendingSavedId.current = undefined;
    const loadKey = candidate?.artifactId ?? `empty:${bufferKey}`;
    const nextBody = artifactForCurrent?.body ?? chapterForCurrent?.content ?? "";
    if (lastLoadedId.current === loadKey && savedBodyRef.current === nextBody) return;
    setBody(nextBody);
    savedBodyRef.current = nextBody;
    editBaseId.current = candidate?.artifactId;
    lastLoadedId.current = loadKey;
  }, [artifactForCurrent?.body, bufferKey, candidate?.artifactId, chapterForCurrent?.content, ready, busy, dirty]);

  const persistIfDirty = async (): Promise<string | undefined> => {
    if (!dirtyRef.current) return pendingSavedId.current ?? candidate?.artifactId;
    const baseId = editBaseId.current;
    const saved = baseId
      ? await putApi<{ artifactId: string }>(`/authoring/artifacts/${encodeURIComponent(baseId)}`, { bookId, body })
      : await postApi<{ artifactId: string }>("/authoring/write/hand", { bookId, chapterNumber, title: chapterTitle, body });
    dirtyRef.current = false;
    setDirty(false);
    savedBodyRef.current = body;
    editBaseId.current = saved.artifactId;
    pendingSavedId.current = saved.artifactId;
    lastLoadedId.current = saved.artifactId;
    pendingWriteEdits.delete(bufferKey);
    await refetch();
    return saved.artifactId;
  };

  const [submitUnknown, setSubmitUnknown] = useState<string | null>(null);
  const lookupWorkspaceRuns = () => fetchJson<AuthoringWorkspace>(`/authoring/workspace?${workspaceQuery(bookId)}`);
  const run = async (label: string, fn: () => Promise<unknown>, notifyParent = false): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(label);
    setFailure(null);
    let keepBusy = false;
    try {
      await fn();
      await refetch();
      if (notifyParent) onChanged?.();
      return true;
    } catch (error) {
      if (isAuthoringSubmitUnknown(error)) {
        keepBusy = true;
        setSubmitUnknown(label);
        setFailure(error.message);
        setBusy("unknown");
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      setFailure(message);
      showToast(message, "error");
      return false;
    } finally {
      if (!keepBusy) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  };

  const actionsRef = useRef({ save: async (): Promise<boolean> => false, leave: async (): Promise<boolean> => false });
  const discardEdits = () => { setBody(savedBodyRef.current); dirtyRef.current = false; setDirty(false); pendingWriteEdits.delete(bufferKey); setEditing(false); };
  actionsRef.current = {
    save: async () => {
      if (busyRef.current) return false;
      if (!editing) return true;
      if (!dirtyRef.current) { setEditing(false); return true; }
      return run("save", async () => { await persistIfDirty(); setEditing(false); });
    },
    leave: async () => {
      if (busyRef.current) {
        setFailure(isZh ? "当前操作尚未结束，请稍后切换章节。" : "Wait for the current operation before switching chapters.");
        return false;
      }
      if (!dirtyRef.current) { setEditing(false); return true; }
      const answer = await decision.ask();
      if (answer === "cancel") { setEditing(true); return false; }
      if (answer === "discard") { discardEdits(); return true; }
      return run("save", async () => { await persistIfDirty(); setEditing(false); });
    },
  };
  useEffect(() => {
    onRegisterBeforeLeave?.(() => actionsRef.current.leave());
    return () => onRegisterBeforeLeave?.(null);
  }, [onRegisterBeforeLeave]);
  useEffect(() => {
    if (!dirty) return;
    return registerNavigationGuard(() => actionsRef.current.leave());
  }, [dirty]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s" || event.altKey || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      void actionsRef.current.save();
    };
    installUnloadGuard();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const workspaceReport = reportForArtifact(data?.reports, candidate?.artifactId) ?? null;
  const storedReport = report ?? workspaceReport;
  const activeReport = storedReport && dirty ? { ...storedReport, stale: true, staleReason: isZh ? "正文已有未保存手改，这份报告对应修改前的稿件。" : "Unsaved edits have changed the reviewed text." } : storedReport;
  const writeRunCompleted = authoringRun.settled && authoringRun.run?.status === "completed";
  const softenTransientRefreshError = (message: string | null) => (
    message && writeRunCompleted && data && isTransientNetworkFetchError(message) ? null : message
  );
  const error = failure
    ?? softenTransientRefreshError(authoringRun.error)
    ?? softenTransientRefreshError(workspaceError)
    ?? softenTransientRefreshError(artifactError);
  const switchedInBackground = dirty && candidate?.artifactId !== editBaseId.current;
  const history = (data?.artifacts ?? []).filter((item) => item.stage === "write" && item.scope === scope);
  const selectVersion = async (artifactId: string) => {
    await persistIfDirty();
    await postApi("/authoring/write/select", { bookId, chapterNumber, artifactId });
    pendingSavedId.current = undefined;
    setHistoryOpen(false);
    setDiffOpen(false);
  };
  const adopt = async () => {
    const artifactId = resolveAdoptArtifactId(await persistIfDirty(), candidate?.artifactId);
    const result = await postApi<{ message?: string; settled?: boolean; runId?: string; status?: string; artifactId?: string }>("/authoring/write/adopt", { bookId, artifactId });
    if (isBackgroundAuthoringStart(result) && result.runId) {
      setSettleArtifactId(artifactId);
      setActiveRunId(result.runId);
    }
    showToast(result.message ?? (isZh ? "章节已采用" : "Chapter adopted"), result.settled === false ? "info" : "success", {
      label: isZh ? "写下一章" : "Write next chapter",
      onClick: () => onGoNextChapter ? onGoNextChapter() : goBookAuthoringStage(bookId, "write"),
    });
  };
  const reviewCurrent = () => {
    if (editing || dirty || busyRef.current) return Promise.resolve(false);
    setReportOpen(true);
    return run("review", async () => {
      const artifactId = pendingSavedId.current ?? candidate?.artifactId;
      if (!artifactId) throw new Error(isZh ? "先写本章或生成候选。" : "Write or generate a candidate first.");
      const submitted = await submitAuthoringAction<AuthoringReport & { runId?: string; status?: string }>({
        post: () => postApi("/authoring/write/review", { bookId, artifactId, coverage: `第 ${chapterNumber} 章` }),
        readWorkspace: lookupWorkspaceRuns,
        match: matchActiveAuthoringSubmit("write", "review", scope),
      });
      if (submitted.kind === "bound") {
        setActiveRunId(submitted.run.runId);
        setSubmitUnknown(null);
        return;
      }
      if (submitted.kind === "unknown") throw new AuthoringSubmitUnknownError();
      const next = submitted.result;
      if (isBackgroundAuthoringStart(next) && next.runId) {
        setActiveRunId(next.runId);
        return;
      }
      setReport(next);
    });
  };
  const generationNotes = generationReviewNotes(activeReport, [pendingSavedId.current ?? candidate?.artifactId]);
  const startWriteJob = async (path: "/authoring/write/generate" | "/authoring/write/revise", payload: Record<string, unknown>) => {
    const submitted = await submitAuthoringAction<{ artifactId?: string; runId?: string; status?: string }>({
      post: () => postApi(path, payload),
      readWorkspace: lookupWorkspaceRuns,
      match: matchActiveAuthoringSubmit("write", path.endsWith("/revise") ? "revise" : "generate", scope),
    });
    if (submitted.kind === "bound") {
      setActiveRunId(submitted.run.runId);
      setSubmitUnknown(null);
      setReportOpen(false);
      return;
    }
    if (submitted.kind === "unknown") throw new AuthoringSubmitUnknownError();
    const generated = submitted.result;
    if (isBackgroundAuthoringStart(generated) && generated.runId) {
      setActiveRunId(generated.runId);
      setReportOpen(false);
      return;
    }
    if (generated.artifactId) pendingSavedId.current = generated.artifactId;
    setReportOpen(false);
  };
  const generateChapter = async (requirements = "") => {
    return run("generate", async () => {
      await startWriteJob("/authoring/write/generate", {
        bookId,
        chapterNumber,
        title: chapterTitle,
        requirements: withGenerationReview(requirements, generationNotes),
      });
    }, true);
  };
  const abandonRun = () => {
    if (!activeRunId) return;
    void postApi(`/authoring/runs/${encodeURIComponent(activeRunId)}/cancel`, { bookId });
  };
  const retryFailedRun = () => {
    const action = writeRetryAction(authoringRun.run?.operation);
    if (action === "settle") {
      retrySettle(authoringRun.run?.producedArtifactIds?.[0] ?? settleArtifactId);
      return;
    }
    if (action === "review") {
      void reviewCurrent();
      return;
    }
    void generateChapter(requirementNotes);
  };
  const retrySettle = (artifactId?: string | null) => {
    if (!artifactId) return;
    void run("settle", async () => {
      const result = await postApi<{ runId?: string; status?: string }>("/authoring/write/settle", { bookId, artifactId });
      if (result.runId) setActiveRunId(result.runId);
    });
  };
  const locked = Boolean(busy) || authoringRun.active;
  const generateHeld = previousSettleActive;
  const targetWords = data?.canon?.chapterWordCount;
  const currentWords = body.replace(/\s/g, "").length;
  const runStatus = authoringRun.active
    ? (isZh
      ? `${authoringRun.run?.progressLabel ?? `正在写第 ${chapterNumber} 章`}${authoringRun.elapsed ? ` · 已 ${authoringRun.elapsed}` : ""}`
      : `${authoringRun.run?.progressLabel ?? `Writing ch.${chapterNumber}`}${authoringRun.elapsed ? ` · ${authoringRun.elapsed}` : ""}`)
    : authoringRun.run?.status === "failed"
      ? (authoringRun.run.error ?? (isZh ? "这次操作失败" : "This run failed"))
      : null;
  const triage = findImpactTriageRun(data?.runs);
  const impactBanner = writeImpactBanner({
    impact: data?.impact,
    watches: data?.manifest?.watches,
    chapterNumber,
    triageRunning: triage?.status === "running" || triage?.status === "pausing",
    authoringBook: data?.authoringBook,
    isZh,
  });

  return (
    <section className={`manuscript-workspace ${reportOpen ? "review-is-open" : ""}`} data-testid="authoring-write-panel" aria-busy={Boolean(busy)}>
      <header className="manuscript-heading">
        <div className="manuscript-version">
          <span>{candidate ? candidate.artifactId === adoptedId ? (isZh ? `已采用 v${candidate.version}` : `Adopted v${candidate.version}`) : (isZh ? `候选 v${candidate.version}` : `Candidate v${candidate.version}`) : (isZh ? "本章草稿" : "Chapter draft")}</span>
          {adoptedId ? <span>{isZh ? "已有采用稿" : "Adopted draft available"}</span> : null}
        </div>
        <h1>{isZh ? `第 ${chapterNumber} 章` : `Chapter ${chapterNumber}`}{chapterTitle ? ` ${chapterTitle}` : ""}</h1>
        <div className="manuscript-meta">
          <span>{targetWords
            ? (isZh ? `${currentWords.toLocaleString()} / 约 ${targetWords.toLocaleString()} 字` : `${currentWords.toLocaleString()} / ~${targetWords.toLocaleString()} words`)
            : `${currentWords.toLocaleString()} ${isZh ? "字" : "characters"}`}</span>
        </div>
        {previousSettleActive ? <p className="manuscript-notice" data-testid="write-previous-settle-hold">{isZh ? `正在整理第 ${chapterNumber - 1} 章状态，完成后可写下一章` : `Settling chapter ${chapterNumber - 1} before writing the next chapter.`}</p> : null}
        {chapterStateMissing && !previousSettleActive ? <p className="manuscript-notice" data-testid="write-state-missing">{isZh ? "本章已采用，但状态尚未整理。" : "This chapter is adopted, but its state is not settled."}</p> : null}
        {impactBanner ? (
          <div className="manuscript-notice" data-testid="write-impact-banner">
            <p>{impactBanner.text}</p>
            {impactBanner.chapterText ? <p>{impactBanner.chapterText}</p> : null}
            {impactBanner.globalsText ? <p data-testid="write-impact-globals">{impactBanner.globalsText}</p> : null}
            {impactBanner.actions.length > 0 ? (
              <p className="flex flex-wrap gap-2">
                {impactBanner.actions.map((action) => (
                  <button
                    key={action}
                    type="button"
                    className="btn-ghost"
                    data-testid={`write-impact-${action}`}
                    onClick={() => {
                      if (action === "ground") goBookAuthoringStage(bookId, "ground");
                      else if (action === "weave") goBookAuthoringStage(bookId, "weave");
                      else if (action === "chapter") {
                        rememberImpactFocus(`chapter:${chapterNumber}`);
                        goBookAuthoringStage(bookId, "weave");
                      } else if (action === "recompute") {
                        void run("impact", async () => {
                          const result = await postApi<{ runId?: string; status?: string }>("/authoring/impact/recompute", { bookId });
                          if (result.runId) setActiveRunId(result.runId);
                          showToast(isZh ? "正在相对正典重算影响…" : "Recomputing canon impact…");
                        });
                      } else {
                        void run("impact", async () => {
                          await postApi<{ ok: boolean; impact?: AuthoringImpactSummary }>("/authoring/impact/resolve", { bookId, as: "reviewed" });
                        });
                      }
                    }}
                  >
                    {writeImpactActionLabel(action, isZh)}
                  </button>
                ))}
              </p>
            ) : null}
          </div>
        ) : null}
        {switchedInBackground ? <p className="manuscript-notice">{isZh ? "候选已在别处更新。你的手改已保留，保存将另存为新候选。" : "Another candidate was selected. Your edits are retained and will save as a new candidate."}</p> : null}
      </header>
      {error ? <div className="manuscript-error" role="alert"><span>{error}</span>{!failure ? <button type="button" className="btn-ghost" onClick={() => { void refetch(); void refetchArtifact(); }}>{isZh ? "重新加载" : "Retry loading"}</button> : null}{submitUnknown ? <button type="button" className="btn-ghost" data-testid="authoring-submit-check" onClick={() => {
        void recoverAuthoringSubmit({
          readWorkspace: lookupWorkspaceRuns,
          match: matchActiveAuthoringSubmit("write", submitUnknown === "review" ? "review" : submitUnknown === "revise" ? "revise" : "generate", scope),
        }).then((recovered) => {
          if (recovered.kind === "bound") {
            setActiveRunId(recovered.run.runId);
            setSubmitUnknown(null);
            setFailure(null);
            busyRef.current = false;
            setBusy(null);
          } else setFailure(AUTHORING_SUBMIT_UNKNOWN_MESSAGE);
        });
      }}>{isZh ? "核对" : "Check"}</button> : null}</div> : null}
      {editing ? <textarea
        className="manuscript-editor prose-body"
        aria-label={isZh ? `第 ${chapterNumber} 章候选正文` : `Chapter ${chapterNumber} candidate text`}
        placeholder={!ready ? (isZh ? "正在打开稿件…" : "Opening manuscript…") : (isZh ? "从这一章的第一句话开始。" : "Begin with the first sentence of this chapter.")}
        value={body}
        readOnly={locked || !ready}
        onChange={(event) => {
          if (busyRef.current || !ready) return;
          const value = event.target.value;
          const changed = value !== savedBodyRef.current;
          dirtyRef.current = changed;
          setDirty(changed);
          setBody(value);
          setFailure(null);
          if (changed) pendingWriteEdits.set(bufferKey, { body: value, baseId: editBaseId.current, savedBody: savedBodyRef.current });
          else pendingWriteEdits.delete(bufferKey);
        }}
        data-testid="write-candidate-body"
      /> : !ready ? <p role="status" className="py-12 text-muted-foreground">{isZh ? "正在打开稿件…" : "Opening manuscript…"}</p> : body.trim() ? <ManuscriptView body={body} className="write-manuscript-reading" /> : <p className="py-16 text-muted-foreground">{isZh ? "这一章，还在等第一句话。" : "This chapter is waiting for its first sentence."}</p>}
      <div className="manuscript-actions" data-testid="write-action-bar">
        <span className="manuscript-save-status" role="status" aria-live="polite">
          <strong>{isZh ? "落笔" : "Write"}</strong>
          {runStatus ?? (busy === "save" ? (isZh ? "正在保存…" : "Saving…") : dirty ? (isZh ? "有未保存修改" : "Unsaved changes") : candidate ? (isZh ? "草稿已保存" : "Draft saved") : (isZh ? "尚未保存候选" : "No candidate saved"))}
          {authoringRun.active ? <button type="button" className="btn-ghost" data-testid="authoring-abandon-run" onClick={abandonRun}>{isZh ? "放弃这次运行" : "Abandon run"}</button> : null}
          {authoringRun.run?.status === "failed" ? <button type="button" className="btn-ghost" onClick={retryFailedRun}>{isZh ? "重试" : "Retry"}</button> : null}
        </span>
        <div className="manuscript-action-buttons">
          {editing ? <>
          <button type="button" className="quiet" disabled={locked || !dirty || !ready} onClick={() => void actionsRef.current.save()} aria-keyshortcuts="Control+s Meta+s" data-testid="write-save"><Save size={14} />{isZh ? "保存" : "Save"}</button>
          <button type="button" className="quiet" disabled={locked} onClick={() => void actionsRef.current.leave()}>{isZh ? "取消" : "Cancel"}</button>
          </> : <>
          <button type="button" disabled={locked || !ready} onClick={() => setEditing(true)}>{isZh ? "编辑" : "Edit"}</button>
          {candidate ? <>
          <button type="button" disabled={locked || !ready || dirty} onClick={() => void reviewCurrent()}>{busy === "review" ? (isZh ? "审查中…" : "Reviewing…") : (isZh ? "审查" : "Review")}</button>
          <button type="button" disabled={locked || !ready || dirty || candidate.artifactId === adoptedId} onClick={() => void run("adopt", adopt, true)}><Check size={14} />{busy === "adopt" ? (isZh ? "采用中…" : "Adopting…") : candidate.artifactId === adoptedId ? (isZh ? "已采用" : "Adopted") : (isZh ? "采用" : "Adopt")}</button>
          <DropdownMenu><DropdownMenuTrigger className="quiet" disabled={locked || dirty} aria-label={isZh ? "更多操作" : "More actions"}><MoreHorizontal size={18} /></DropdownMenuTrigger><DropdownMenuContent align="end">
            <DropdownMenuItem disabled={generateHeld} onClick={() => setGeneration({})}>{isZh ? "重新生成" : "Regenerate"}</DropdownMenuItem>
            {chapterStateMissing ? <DropdownMenuItem data-testid="write-settle-state" onClick={() => retrySettle(adoptedId)}>{isZh ? "整理状态" : "Settle state"}</DropdownMenuItem> : null}
            <DropdownMenuItem onClick={() => setHistoryOpen(true)}>{isZh ? "历史版本" : "Version history"}</DropdownMenuItem>
            <DropdownMenuItem disabled={!storedReport} onClick={() => setReportOpen(true)}>{isZh ? "查看审查意见" : "View review"}</DropdownMenuItem>
            <DropdownMenuItem disabled={!parentId} onClick={() => setDiffOpen(true)}>{isZh ? "比较修改前后" : "Compare versions"}</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu>
          </> : <><button type="button" className="primary" disabled={locked || generateHeld || !ready || dirty} data-testid="write-generate" onClick={() => void generateChapter(requirementNotes)}><PenLine size={15} />{busy === "generate" ? (isZh ? "正在写…" : "Writing…") : (isZh ? "创作本章" : "Write chapter")}</button><GenerationRequirements value={requirementNotes} onChange={setRequirementNotes} isZh={isZh} disabled={locked || !ready} /></>}
          </>}
        </div>
      </div>
      <RegenerateDialog open={Boolean(generation)} title={isZh ? (generation?.issueIds ? "按意见重新创作" : "创作本章") : "Write chapter"} scopeLabel={isZh ? `第 ${chapterNumber} 章` : `Chapter ${chapterNumber}`} isZh={isZh} busy={Boolean(busy)} error={failure} reportSummary={generation?.issueIds && activeReport ? activeReport.summary : generationNotes} onClose={() => setGeneration(null)} onConfirm={async (requirements) => {
        if (!generation || (!generation.issueIds && generateHeld)) return false;
        const ok = await run(generation.issueIds ? "revise" : "generate", async () => {
          if (generation.issueIds && activeReport && candidate) {
            await startWriteJob("/authoring/write/revise", { bookId, artifactId: pendingSavedId.current ?? candidate.artifactId, reportId: activeReport.reportId, selectedIssueIds: generation.issueIds, reuseStale: generation.reuseStale, requirements });
          } else {
            await startWriteJob("/authoring/write/generate", { bookId, chapterNumber, title: chapterTitle, requirements: withGenerationReview(requirements, generationNotes) });
          }
        }, true);
        if (ok) setGeneration(null);
        return ok;
      }} />
      <ManuscriptHistoryDrawer open={historyOpen} bookId={bookId} title={isZh ? "本章版本" : "Chapter versions"} artifacts={history} currentId={candidate?.artifactId} adoptedId={adoptedId} isZh={isZh} busy={Boolean(busy)} onClose={() => setHistoryOpen(false)} onRestore={(artifactId, restoredBody) => run("restore", async () => {
        const restored = await putApi<{ artifactId: string }>(`/authoring/artifacts/${encodeURIComponent(artifactId)}`, { bookId, body: restoredBody }); pendingSavedId.current = restored.artifactId;
      })} />
      <AuthoringReviewDrawer key={activeReport?.reportId ?? "no-report"} open={reportOpen} title={isZh ? `落笔审查 · 第 ${chapterNumber} 章` : `Write review · ch.${chapterNumber}`} report={activeReport} currentArtifactId={pendingSavedId.current ?? candidate?.artifactId} isZh={isZh} busy={busy === "review"} reviseDisabled={Boolean(busy) || editing || dirty} error={failure} onRetry={() => void reviewCurrent()} onClose={() => setReportOpen(false)} onRevise={(issueIds, reuseStale) => {
        if (!candidate || !activeReport) return;
        if (editing || dirty) { showToast(isZh ? "请先保存或取消当前修改。" : "Save or cancel your edits first.", "info"); return; }
        setGeneration({ issueIds, reuseStale });
      }} />
      <AuthoringDiffDrawer open={diffOpen} bookId={bookId} leftId={parentId} rightId={candidate?.artifactId} adoptedId={adoptedId && adoptedId !== parentId && adoptedId !== candidate?.artifactId ? adoptedId : undefined} isZh={isZh} onClose={() => setDiffOpen(false)} onKeep={() => {
        if (parentId) void run("keep", () => selectVersion(parentId));
      }} onAdopt={() => { void run("adopt", async () => { await adopt(); setDiffOpen(false); }, true); }} />
      {decision.dialog}
    </section>
  );
}
