/** 问心: conversation-led canon reading, explicit editing and adoption.
 * SPDX-License-Identifier: AGPL-3.0-only */
import { useEffect, useRef, useState } from "react";
import { Check, FileCheck2, MoreHorizontal, PanelRightClose, PanelRightOpen, PencilLine, Save } from "lucide-react";
import { fetchJson, postApi, putApi, useApi } from "../hooks/use-api";
import { invalidateBookStage } from "../hooks/use-book-stage";
import { showToast } from "../lib/toast";
import { registerNavigationGuard } from "../lib/edit-navigation";
import { chatSelectors, useChatStore } from "../store/chat";
import type { SessionRuntime } from "../store/chat/types";
import type { AuthoringArtifact, AuthoringWorkspace } from "../lib/authoring-workspace";
import { resolveAdoptArtifactId } from "../lib/authoring-workspace";
import { askCanonScopeKey, askConversation, askReportState, createAskCanonEditor, isAskSession } from "./ask-canon-state";
import { canonFieldNames, canonLengthMissing, readCanonFields, updateCanonField, updateCanonText, validateCanonFields, type CanonFieldName } from "./ask-canon-fields";
import { ManuscriptView } from "./ManuscriptView";
import { RegenerateDialog } from "./RegenerateDialog";
import { AuthoringReviewDrawer } from "./AuthoringReviewDrawer";
import { Drawer } from "./ui/drawer";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./ui/dropdown-menu";
import "./ask-workspace.css";

interface AskCanonProps {
  readonly bookId?: string;
  readonly resumeSessionId?: string;
  readonly isZh: boolean;
  readonly onAdopted?: (bookId: string) => void;
}
interface CanonVersion { readonly meta: AuthoringArtifact; readonly body: string }
interface RevisionIntent { readonly selectedIssueIds: ReadonlyArray<string>; readonly reuseStale?: boolean; readonly reportId: string }

// Scope remounts isolate responses. Session-only editing buffers survive navigation.
export function AskCanonPanel(props: AskCanonProps) {
  const activeSession = useChatStore(chatSelectors.activeSession);
  const session = isAskSession(activeSession, props.bookId) && (!props.resumeSessionId || activeSession?.sessionId === props.resumeSessionId) ? activeSession : null;
  return <CanonEditor key={props.bookId ? `book:${props.bookId}` : `draft:${session?.sessionId ?? "pending"}`} {...props} session={session} />;
}

function CanonEditor({ bookId, isZh, onAdopted, session }: AskCanonProps & { readonly session: SessionRuntime | null }) {
  const [draftId, setDraftId] = useState<string>();
  const [draftError, setDraftError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const query = bookId ? `bookId=${encodeURIComponent(bookId)}` : draftId ? `draftId=${encodeURIComponent(draftId)}` : "";
  const { data, loading, error, refetch } = useApi<AuthoringWorkspace>(query ? `/authoring/workspace?${query}` : "");
  const adoptedOnlyId = !data?.candidateAsk ? data?.adoptedAskId : undefined;
  const adoptedCopy = useApi<CanonVersion>(adoptedOnlyId ? `/authoring/artifacts/${encodeURIComponent(adoptedOnlyId)}?${query}` : "");
  const candidate = data?.candidateAsk ?? (adoptedCopy.data && adoptedCopy.data.meta.artifactId === adoptedOnlyId
    ? { artifactId: adoptedCopy.data.meta.artifactId, version: adoptedCopy.data.meta.version, body: adoptedCopy.data.body, status: "adopted" } : undefined);
  // A new draft's compatibility placeholder is not a manuscript.
  const adopted = bookId || data?.canonSource === "canon" ? data?.canon : undefined;
  const canPrepare = Boolean(adopted && !candidate && !data?.adoptedAskId);
  const editor = useRef(createAskCanonEditor(askCanonScopeKey(bookId, session?.sessionId)));
  const [editState, setEditState] = useState(editor.current.snapshot);
  const { body: editBody, dirty, editBaseId, pendingSavedId } = editState;
  const [editing, setEditing] = useState(dirty);
  const [expanded, setExpanded] = useState(dirty);
  const [cancelOpen, setCancelOpen] = useState(false);
  const navigationDecision = useRef<((allow: boolean) => void) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [actionError, setActionError] = useState<string>();
  const [reportOpen, setReportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyItem, setHistoryItem] = useState<CanonVersion>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const historyRequest = useRef(0);
  const [lengthOpen, setLengthOpen] = useState(false);
  const [lengthDraft, setLengthDraft] = useState<Record<CanonFieldName, string>>({ title: "", genre: "", targetChapters: "", chapterWordCount: "" });
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generationIssueIds, setGenerationIssueIds] = useState<string[]>([]);
  const [revision, setRevision] = useState<RevisionIntent>();
  const currentArtifactId = pendingSavedId ?? editBaseId ?? candidate?.artifactId;
  const { report, stale } = askReportState(data?.reports, currentArtifactId, dirty);
  const artifacts = (data?.artifacts ?? []).filter((item) => item.stage === "ask").slice().reverse();
  const editingVersion = artifacts.find((item) => item.artifactId === currentArtifactId)?.version ?? (currentArtifactId === candidate?.artifactId ? candidate?.version : undefined);
  const adoptedVersion = artifacts.find((item) => item.artifactId === data?.adoptedAskId)?.version;
  const conversation = askConversation(session, bookId);
  const scope = { bookId, draftId: bookId ? undefined : draftId };
  const awaitingNewBody = Boolean(pendingSavedId && pendingSavedId !== editBaseId && pendingSavedId !== candidate?.artifactId);
  const ready = Boolean(query && data && !loading && !error && !adoptedCopy.loading && !adoptedCopy.error && !awaitingNewBody);
  const hasManuscript = Boolean(candidate || editBaseId || adopted);
  const isAdopted = Boolean(!dirty && currentArtifactId && currentArtifactId === data?.adoptedAskId);
  const fields = readCanonFields(editBody);

  const ensureDraft = async () => {
    if (bookId || !session) return;
    setDraftError(undefined);
    try {
      const draft = await postApi<{ draftId: string }>("/authoring/drafts/ensure", { sessionId: session.sessionId });
      if (mounted.current) setDraftId(draft.draftId);
    } catch (failure) { if (mounted.current) setDraftError(failure instanceof Error ? failure.message : String(failure)); }
  };
  useEffect(() => { void ensureDraft(); }, [bookId, session?.sessionId]);
  useEffect(() => {
    if (data && editor.current.load(candidate, busyRef.current)) setEditState(editor.current.snapshot);
  }, [data, candidate?.artifactId, candidate?.body, busy, dirty]);
  useEffect(() => { if (hasManuscript) setExpanded(true); }, [candidate?.artifactId, Boolean(adopted)]);
  useEffect(() => {
    if (!dirty) return;
    return registerNavigationGuard(() => {
      if (busyRef.current) return false;
      return new Promise<boolean>((resolve) => { navigationDecision.current = resolve; setCancelOpen(true); });
    });
  }, [dirty]);
  useEffect(() => () => { navigationDecision.current?.(false); navigationDecision.current = null; }, []);
  const answerNavigation = (allow: boolean) => {
    navigationDecision.current?.(allow); navigationDecision.current = null;
  };

  const run = async (label: string, action: () => Promise<unknown>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(label); setActionError(undefined);
    try { await action(); return true; }
    catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (mounted.current) setActionError(message);
      showToast(message, "error"); return false;
    } finally { await refetch(); busyRef.current = false; if (mounted.current) setBusy(null); }
  };
  const persistIfDirty = async (requireLength = false): Promise<string | undefined> => {
    const fieldError = validateCanonFields(editor.current.snapshot.body, isZh, { requireLength });
    if (fieldError) throw new Error(fieldError);
    const artifactId = await editor.current.save((baseId, body) => putApi<{ artifactId: string }>(`/authoring/artifacts/${encodeURIComponent(baseId)}`, { ...scope, body }));
    if (mounted.current) setEditState(editor.current.snapshot);
    return artifactId;
  };
  const save = async () => {
    const saved = await run("save", async () => {
      await persistIfDirty();
      if (!mounted.current) return;
      setEditing(false); setCancelOpen(false);
      showToast(isZh ? "候选已保存，已采用正典未变" : "Candidate saved; adopted canon unchanged", "success");
    });
    answerNavigation(saved);
    return saved;
  };
  const changeBody = (body: string) => {
    if (busyRef.current || !ready || !editing) return;
    editor.current.change(body); setEditState(editor.current.snapshot);
  };
  const cancelEditing = () => {
    if (dirty) setCancelOpen(true);
    else { setEditing(false); setActionError(undefined); }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s" || event.altKey || !editing) return;
      event.preventDefault();
      if (editBaseId && dirty && ready && !busyRef.current && !historyOpen && !generateOpen && !revision) void save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const loadVersion = async (artifactId: string) => {
    const request = ++historyRequest.current;
    setHistoryLoading(true); setHistoryError(undefined); setHistoryItem(undefined);
    try {
      const item = await fetchJson<CanonVersion>(`/authoring/artifacts/${encodeURIComponent(artifactId)}?${query}`);
      if (mounted.current && request === historyRequest.current) setHistoryItem(item);
    } catch (failure) { if (mounted.current && request === historyRequest.current) setHistoryError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (mounted.current && request === historyRequest.current) setHistoryLoading(false); }
  };
  const openHistory = (id?: string) => { setReportOpen(false); setHistoryOpen(true); if (id) void loadVersion(id); };
  const prepareCurrentArtifact = async (): Promise<string> => {
    if (candidate) return resolveAdoptArtifactId(currentArtifactId, candidate.artifactId);
    if (!canPrepare) throw new Error(isZh ? "暂无可操作的正典，请先整理正典。" : "Create a canon first.");
    // Preserve old-book text as a candidate only after an explicit action.
    const prepared = await postApi<CanonVersion>("/authoring/ask/prepare", scope);
    editor.current.load({ artifactId: prepared.meta.artifactId, version: prepared.meta.version, status: prepared.meta.status, body: prepared.body });
    editor.current.expectCandidate(prepared.meta.artifactId);
    if (mounted.current) setEditState(editor.current.snapshot);
    return prepared.meta.artifactId;
  };
  const startEditing = () => {
    if (!ready || busyRef.current) return;
    if (candidate) { setEditing(true); setExpanded(true); setActionError(undefined); return; }
    void run("prepare", async () => {
      await prepareCurrentArtifact();
      if (mounted.current) { setEditing(true); setExpanded(true); }
    });
  };
  const review = () => {
    setReportOpen(true); setExpanded(true);
    void run("review", async () => {
      const artifactId = await prepareCurrentArtifact();
      await postApi("/authoring/ask/review", { ...scope, artifactId, conversation });
    });
  };
  const creatingBook = !bookId;
  const applyCanonFields = (body: string, next: Record<CanonFieldName, string>) => {
    let updated = body;
    for (const key of canonFieldNames) updated = updateCanonField(updated, key, next[key]);
    return updated;
  };
  const adoptCurrent = async () => {
    const artifactId = await prepareCurrentArtifact();
    const savedId = await persistIfDirty(creatingBook);
    const result = await postApi<{ message?: string; bookId?: string }>("/authoring/ask/adopt", { ...scope, artifactId: savedId ?? artifactId });
    invalidateBookStage(result.bookId ?? bookId);
    useChatStore.getState().bumpBookDataVersion();
    showToast(result.message ?? (isZh ? "正典已采用" : "Canon adopted"));
    if (mounted.current && result.bookId && !bookId) onAdopted?.(result.bookId);
  };
  const startAdopt = () => void run("adopt", async () => {
    await prepareCurrentArtifact();
    const source = editor.current.snapshot.body || candidate?.body || "";
    const current = readCanonFields(source).fields;
    if (creatingBook && canonLengthMissing(current)) {
      setLengthDraft(current);
      setLengthOpen(true);
      return;
    }
    await adoptCurrent();
  });
  const confirmLengthAndAdopt = () => void run("adopt", async () => {
    const source = editor.current.snapshot.body || candidate?.body || "";
    const nextBody = applyCanonFields(source, lengthDraft);
    const fieldError = validateCanonFields(nextBody, isZh, { requireLength: true });
    if (fieldError) throw new Error(fieldError);
    editor.current.change(nextBody);
    if (mounted.current) setEditState(editor.current.snapshot);
    await adoptCurrent();
    if (mounted.current) setLengthOpen(false);
  });
  const regenerate = (requirements: string, authorRequirement = requirements) => run(revision ? "revise" : "generate", async () => {
    const generated = revision
      ? await postApi<{ artifactId: string }>("/authoring/ask/revise", { ...scope, artifactId: resolveAdoptArtifactId(currentArtifactId, candidate?.artifactId), ...revision, conversation, authorRequirement, extraRequirement: authorRequirement })
      : await postApi<{ artifactId: string }>("/authoring/ask/generate", { ...scope, conversation, requirements, authorRequirement });
    editor.current.expectCandidate(generated.artifactId);
    if (mounted.current) { setEditState(editor.current.snapshot); setExpanded(true); setReportOpen(false); }
  });
  const busyLabels: Record<string, string> = { prepare: isZh ? "读取文稿中…" : "Preparing manuscript…", save: isZh ? "保存中…" : "Saving…", generate: isZh ? "整理正典中…" : "Generating…", review: isZh ? "审查中…" : "Reviewing…", adopt: isZh ? "采用中…" : "Adopting…", revise: isZh ? "修订中…" : "Revising…", restore: isZh ? "恢复为候选中…" : "Restoring candidate…" };
  const status = busy ? busyLabels[busy] : dirty ? (isZh ? "有未保存修改" : "Unsaved changes") : isAdopted ? (isZh ? "已采用" : "Adopted") : candidate ? (isZh ? "候选已保存" : "Candidate saved") : "";
  const labels: Record<typeof canonFieldNames[number], string> = isZh
    ? { title: "书名", genre: "类型", targetChapters: "预计章节", chapterWordCount: "每章字数" }
    : { title: "Title", genre: "Genre", targetChapters: "Chapters", chapterWordCount: "Words per chapter" };

  return (
    <aside className="canon-sheet ask-canon-editor" data-expanded={expanded && hasManuscript} data-review-open={reportOpen} aria-label={isZh ? "故事正典" : "Story canon"} aria-busy={Boolean(busy)}>
      {hasManuscript && !expanded ? <button type="button" className="ask-open-canon" onClick={() => setExpanded(true)}><PanelRightOpen size={16} />{isZh ? "展开正典" : "Open canon"}</button> : null}
      <header className="ask-canon-heading" hidden={!expanded || !hasManuscript}>
        <div className="ask-canon-title"><h2>{isZh ? "故事正典" : "Story canon"}</h2><button type="button" onClick={() => { setExpanded(false); setReportOpen(false); }} disabled={editing} aria-label={isZh ? "收起正典" : "Collapse canon"} title={editing ? (isZh ? "完成编辑后可收起" : "Finish editing to collapse") : undefined}><PanelRightClose size={17} /></button></div>
        <div className="ask-canon-meta"><span>{editingVersion ? (isZh ? `${isAdopted ? "已采用" : "候选"} v${editingVersion}` : `${isAdopted ? "Adopted" : "Candidate"} v${editingVersion}`) : (isZh ? "故事文稿" : "Story manuscript")}</span>{!isAdopted && adoptedVersion ? <span>{isZh ? `正式稿 v${adoptedVersion}` : `Adopted v${adoptedVersion}`}</span> : null}</div>
      </header>
      <div className="ask-canon-scroll" hidden={!expanded || !hasManuscript}>
        {dirty && candidate && editBaseId !== candidate.artifactId ? <p role="status" className="text-xs text-muted-foreground">{isZh ? "候选已有新版本。手改已保留，保存会从原稿另存为新候选。" : "A newer candidate exists. Your retained changes save as a new candidate."}</p> : null}
        {candidate || editBaseId ? editing ? <div className="ask-canon-form">
          <div className="ask-canon-fields">{canonFieldNames.map((key) => <label key={key}><span>{labels[key]}</span><input aria-label={labels[key]} type={key === "targetChapters" || key === "chapterWordCount" ? "number" : "text"} min={key === "chapterWordCount" ? 100 : 1} step={1} value={fields.fields[key]} disabled={Boolean(busy) || !ready} onChange={(event) => changeBody(updateCanonField(editBody, key, event.target.value))} /></label>)}</div>
          <label className="ask-canon-label"><span className="sr-only">{isZh ? "候选正文（编辑中）" : "Candidate text (editing)"}</span><textarea className="prose-body ask-canon-body" value={fields.text} readOnly={Boolean(busy) || !ready} spellCheck={false} onChange={(event) => changeBody(updateCanonText(editBody, event.target.value))} data-testid="ask-candidate-body" /></label>
        </div> : <ManuscriptView body={editBody} parseFrontmatter className="ask-canon-reading" /> : adopted ? <CanonPreview canon={adopted} isZh={isZh} /> : null}
      </div>
      <footer className="ask-canon-toolbar" data-testid="ask-canon-toolbar">
        <div className="ask-canon-workstate" role="status" aria-live="polite"><span>{status}</span>
          {report && !busy ? <span>{report.incomplete ? (isZh ? "审查未完成" : "Review incomplete") : stale ? (isZh ? "审查对应旧稿" : "Review is outdated") : (isZh ? "已有审查意见" : "Review available")}</span> : null}
          {error || draftError || adoptedCopy.error ? <span role="alert">{error ?? draftError ?? adoptedCopy.error}<button type="button" onClick={() => void (draftError ? ensureDraft() : adoptedCopy.error ? adoptedCopy.refetch() : refetch())}>{isZh ? "重试加载" : "Retry loading"}</button></span> : null}
          {actionError ? <span role="alert" className="ask-canon-error">{actionError}</span> : null}
        </div>
        <div className="ask-canon-actions">{editing ? <>
          <button type="button" className="ask-canon-primary" disabled={!editBaseId || !dirty || Boolean(busy) || !ready} onClick={() => void save()}><Save size={15} />{isZh ? "保存" : "Save"}</button><button type="button" disabled={Boolean(busy)} onClick={cancelEditing}>{isZh ? "取消" : "Cancel"}</button>
        </> : hasManuscript ? <>
          <button type="button" disabled={(!candidate && !canPrepare) || Boolean(busy) || !ready} onClick={startEditing}><PencilLine size={15} />{isZh ? "编辑" : "Edit"}</button>
          <button type="button" disabled={(!candidate && !canPrepare) || Boolean(busy) || !ready || session?.isChatStreaming} onClick={report && !reportOpen ? () => { setReportOpen(true); setExpanded(true); } : review}><FileCheck2 size={15} />{isZh ? "审查" : "Review"}</button>
          <button type="button" className="ask-canon-primary" data-testid={creatingBook ? "ask-adopt-create" : "ask-adopt"} disabled={(!candidate && !canPrepare) || Boolean(busy) || !ready || isAdopted} onClick={startAdopt}><Check size={15} />{isAdopted ? (isZh ? "已采用" : "Adopted") : creatingBook ? (isZh ? "采用并建书" : "Adopt and create book") : (isZh ? "采用" : "Adopt")}</button>
          <DropdownMenu><DropdownMenuTrigger className="ask-canon-menu-trigger" disabled={Boolean(busy)} aria-label={isZh ? "正典操作" : "Canon actions"}><MoreHorizontal size={18} /></DropdownMenuTrigger><DropdownMenuContent align="end" side="top">
            <DropdownMenuItem disabled={!ready || Boolean(session?.isChatStreaming)} onClick={() => { setActionError(undefined); setGenerationIssueIds(report && !stale && !report.incomplete ? report.issues.map((issue) => issue.issueId) : []); setGenerateOpen(true); }}>{isZh ? "重新生成" : "Regenerate"}</DropdownMenuItem>
            <DropdownMenuItem disabled={!artifacts.length} onClick={() => openHistory(currentArtifactId)}>{isZh ? "历史版本" : "Version history"}</DropdownMenuItem>
            <DropdownMenuItem disabled={!data?.adoptedAskId} onClick={() => openHistory(data?.adoptedAskId)}>{isZh ? "查看已采用" : "View adopted"}</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu>
        </> : <button type="button" className="ask-canon-primary" disabled={Boolean(busy) || !ready || !conversation.trim() || session?.isChatStreaming} title={!conversation.trim() ? (isZh ? "先在问心对话中描述故事" : "Describe your story first") : undefined} onClick={() => void regenerate("")}><PencilLine size={15} />{isZh ? "整理正典" : "Create canon"}</button>}</div>
      </footer>
      <Drawer open={historyOpen} title={isZh ? "正典版本" : "Canon versions"} onClose={() => setHistoryOpen(false)}>
        <div className="ask-version-list">{artifacts.map((item) => <button type="button" key={item.artifactId} aria-pressed={historyItem?.meta.artifactId === item.artifactId} onClick={() => void loadVersion(item.artifactId)}><span>v{item.version}</span><span>{item.artifactId === data?.adoptedAskId ? (isZh ? "已采用" : "Adopted") : item.artifactId === candidate?.artifactId ? (isZh ? "当前候选" : "Current candidate") : (isZh ? "历史稿" : "Historical")}</span></button>)}</div>
        {historyLoading ? <p role="status">{isZh ? "正在读取版本…" : "Loading version…"}</p> : null}{historyError ? <p role="alert">{historyError}</p> : null}
        {historyItem ? <><h3 className="mt-5 mb-3 font-medium">{isZh ? `版本 v${historyItem.meta.version}` : `Version ${historyItem.meta.version}`}</h3><ManuscriptView body={historyItem.body} parseFrontmatter className="ask-version-body" /><button type="button" className="ask-history-restore" disabled={Boolean(busy) || !ready || dirty || historyItem.meta.artifactId === candidate?.artifactId} onClick={() => void run("restore", async () => {
          const restored = await putApi<{ artifactId: string }>(`/authoring/artifacts/${encodeURIComponent(currentArtifactId ?? historyItem.meta.artifactId)}`, { ...scope, body: historyItem.body });
          editor.current.expectCandidate(restored.artifactId); setEditState(editor.current.snapshot); setHistoryOpen(false);
          showToast(isZh ? "历史稿已另存为新候选，尚未采用" : "Historical copy restored as an unadopted candidate");
        })}>{isZh ? "另存为当前候选" : "Restore as current candidate"}</button></> : null}
      </Drawer>
      <AuthoringReviewDrawer open={reportOpen} title={isZh ? "问心审查" : "Ask review"} report={report ? { ...report, stale } : null} currentArtifactId={currentArtifactId} isZh={isZh} busy={busy === "review"} reviseDisabled={editing || Boolean(busy) || !ready} error={actionError} onRetry={() => { if (!editing && !busyRef.current) review(); }} onClose={() => setReportOpen(false)} onRevise={(selectedIssueIds, reuseStale) => { if (!report || editing) return; setActionError(undefined); setRevision({ selectedIssueIds, reuseStale, reportId: report.reportId }); }} />
      <RegenerateDialog open={generateOpen || Boolean(revision)} title={isZh ? "重新整理正典" : "Regenerate canon"} scopeLabel={isZh ? "当前作品 · 整份故事正典" : "Current book · Entire story canon"} isZh={isZh} busy={Boolean(busy)} error={actionError} reportSummary={report && !report.incomplete && (revision?.reuseStale || !stale) ? [report.summary, ...(revision ? report.issues.filter((issue) => revision.selectedIssueIds.includes(issue.issueId)).map((issue) => `${issue.title}：${issue.suggestion ?? issue.evidence ?? ""}`) : [])].join("\n") : undefined} onClose={() => { if (!busyRef.current) { setGenerateOpen(false); setRevision(undefined); } }} onConfirm={async (requirements) => {
        const chosen = report?.issues.filter((issue) => generationIssueIds.includes(issue.issueId)) ?? [];
        const applicable = report && !report.incomplete && !stale && !revision && chosen.length ? [report.summary, ...chosen.map((issue) => `${issue.title}：${issue.suggestion ?? issue.evidence ?? ""}`)].join("\n") : "";
        return regenerate([requirements, applicable ? `${isZh ? "当前稿审查意见" : "Current review"}：\n${applicable}` : ""].filter(Boolean).join("\n\n"), requirements);
      }}>
        {generateOpen && report && (stale || report.incomplete) ? <p className="text-sm text-muted-foreground">{isZh ? "已有报告对应旧稿或未完成，本次不会自动带入。" : "The previous review is outdated or incomplete and will not be included."}</p> : null}
        {generateOpen && report && !stale && !report.incomplete && report.issues.length ? <fieldset className="ask-regenerate-issues"><legend>{isZh ? "带入哪些审查意见" : "Include review notes"}</legend>{report.issues.map((issue) => <label key={issue.issueId}><input type="checkbox" checked={generationIssueIds.includes(issue.issueId)} disabled={Boolean(busy)} onChange={(event) => setGenerationIssueIds((ids) => event.target.checked ? [...ids, issue.issueId] : ids.filter((id) => id !== issue.issueId))} /><span>{issue.title}{issue.suggestion ? <small>{issue.suggestion}</small> : null}</span></label>)}</fieldset> : null}
      </RegenerateDialog>
      <Drawer open={lengthOpen} placement="center" title={isZh ? "确认全书篇幅" : "Confirm book length"} onClose={() => { if (!busyRef.current) setLengthOpen(false); }}>
        <p className="text-sm leading-7 text-muted-foreground">{isZh ? "建书前必须确认目标章数和每章字数，不会再静默补默认值。" : "Confirm target chapters and words per chapter before creating the book. Silent defaults are no longer filled in."}</p>
        <div className="ask-canon-fields mt-4">{canonFieldNames.map((key) => <label key={key}><span>{labels[key]}</span><input aria-label={labels[key]} type={key === "targetChapters" || key === "chapterWordCount" ? "number" : "text"} min={key === "chapterWordCount" ? 100 : 1} step={1} value={lengthDraft[key]} disabled={Boolean(busy)} onChange={(event) => setLengthDraft((current) => ({ ...current, [key]: event.target.value }))} /></label>)}</div>
        {actionError ? <p role="alert" className="text-destructive text-sm">{actionError}</p> : null}
        <div className="ask-cancel-actions">
          <button type="button" disabled={Boolean(busy)} onClick={() => setLengthOpen(false)}>{isZh ? "再改改" : "Edit more"}</button>
          <button type="button" className="ask-canon-primary" data-testid="ask-length-confirm" disabled={Boolean(busy) || canonLengthMissing(lengthDraft)} onClick={confirmLengthAndAdopt}>{isZh ? "采用并建书" : "Adopt and create book"}</button>
        </div>
      </Drawer>
      <Drawer open={cancelOpen} placement="center" title={isZh ? "保留这次修改？" : "Keep your changes?"} onClose={() => { if (!busyRef.current) { setCancelOpen(false); answerNavigation(false); } }}><p className="text-sm leading-7 text-muted-foreground">{isZh ? "保存为候选，或放弃本次未保存的修改。" : "Save a candidate, or discard only these unsaved changes."}</p>{actionError ? <p role="alert" className="text-destructive text-sm">{actionError}</p> : null}<div className="ask-cancel-actions">
        <button type="button" disabled={Boolean(busy)} onClick={() => { setCancelOpen(false); answerNavigation(false); }}>{isZh ? "继续编辑" : "Continue editing"}</button>
        <button type="button" disabled={Boolean(busy)} onClick={() => { editor.current.discard(); setEditState(editor.current.snapshot); setEditing(false); setCancelOpen(false); setActionError(undefined); answerNavigation(true); }}>{isZh ? "放弃修改" : "Discard changes"}</button>
        <button type="button" disabled={Boolean(busy)} onClick={() => void save()}>{isZh ? "保存" : "Save"}</button>
      </div></Drawer>
    </aside>
  );
}

function CanonPreview({ canon, isZh }: { readonly canon: NonNullable<AuthoringWorkspace["canon"]>; readonly isZh: boolean }) {
  const rows = [[isZh ? "一句话故事" : "Premise", canon.oneLine], [isZh ? "核心命题" : "Theme", canon.proposition], [isZh ? "主角与核心欲望" : "Protagonist", canon.protagonist], [isZh ? "主要冲突" : "Conflict", canon.conflict], [isZh ? "叙事视角与文风" : "Voice", canon.voice], [isZh ? "故事边界" : "Boundaries", canon.boundaries], [isZh ? "初始方向" : "Direction", canon.direction]];
  return <div className="ask-adopted-preview prose-body"><h3>{canon.title}</h3>{rows.filter(([, value]) => value).map(([label, value]) => <section key={label}><h4>{label}</h4><p>{value}</p></section>)}{canon.openQuestions?.length ? <section><h4>{isZh ? "待定项" : "Open questions"}</h4><ul>{canon.openQuestions.map((item) => <li key={item}>{item}</li>)}</ul></section> : null}</div>;
}
