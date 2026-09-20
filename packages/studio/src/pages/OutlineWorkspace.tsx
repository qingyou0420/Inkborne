/**
 * 织卷: authoring full-book outline + tree editor. Old batch-10 weave CTA removed.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { fetchJson, useApi } from "../hooks/use-api";
import { showToast } from "../lib/toast";
import { workspaceQuery, type AuthoringWorkspace } from "../lib/authoring-workspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SSEMessage } from "../hooks/use-sse";
import type { BookWorkspaceNavTarget } from "../components/BookWorkspaceNav";
import { LiteraryEmpty } from "../components/LiteraryEmpty";
import { AuthoringWeavePanel } from "../components/AuthoringWeavePanel";
import {
  applyOutlineWorkspaceSave,
  applyVolumeMapNodeEdit,
  findNodeById,
  HARD_CHAPTER_TITLE_CHARS,

  MAX_CHAPTER_TITLE_CHARS,
  normalizeVolumeMapChapterHeadings,
  outlineEditorSource,
  parseVolumeMapTree,
  splitOutlineTitleAndSummary,
  tidyVolumeMapMarkdown,
  truncateOutlineLabel,
  type VolumeMapChapterNode,
  type VolumeMapNoteNode,
} from "../lib/volume-map-tree";
import { appendUnplannedChapter, saveOutlineMap } from "../lib/weave-editor-state";
import {
  outlineTreeVolumeLabel,
} from "../lib/outline-weave";
import { formatVolumeArriveCopy } from "../lib/copy-map";
import { weaveGuideWhenUngrounded } from "../lib/stage-copy";
import { useBookStage } from "../hooks/use-book-stage";
import { StageDot } from "../components/StageDot";
import { ManuscriptView } from "../components/ManuscriptView";
import { useDraftDecision } from "../hooks/use-draft-decision";
import { registerNavigationGuard } from "../lib/edit-navigation";
import { List, MoreHorizontal } from "lucide-react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
}

interface BookData {
  readonly book: {
    readonly id: string;
    readonly title: string;
    readonly language?: string;
    readonly targetChapters?: number;
  };
  readonly chapters: ReadonlyArray<ChapterMeta>;
  readonly nextChapter: number;
}

interface Nav extends BookWorkspaceNavTarget {
  toDashboard: () => void;
  toChapter: (bookId: string, num: number) => void;
}

type Filter = "all" | "coarse" | "pending" | "refined";
const pendingOutlineEdits = new Map<string, { nodeId: string; title: string; summary: string }>();
let unloadGuardInstalled = false;
function installUnloadGuard() {
  if (unloadGuardInstalled || typeof window === "undefined") return;
  unloadGuardInstalled = true;
  window.addEventListener("beforeunload", (event) => {
    if (pendingOutlineEdits.size === 0) return;
    event.preventDefault(); event.returnValue = "";
  });
}

function isRefinedChapter(node: VolumeMapChapterNode): boolean {
  return node.kind === "chapter" && Boolean(node.title.trim() || node.summary.trim());
}

function nodeVisible(
  node: VolumeMapChapterNode,
  filter: Filter,
  query: string,
): boolean {
  if (filter === "coarse" && node.kind !== "range") return false;
  if (filter === "pending" && (node.kind !== "range" && isRefinedChapter(node))) return false;
  if (filter === "refined" && !isRefinedChapter(node)) return false;
  if (!query) return true;
  const hay = `${node.title} ${node.summary} ${node.chapterNumber}`.toLowerCase();
  return hay.includes(query);
}

type OutlineWorkspaceProps = {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse?: { readonly messages: ReadonlyArray<SSEMessage> };
};

export function OutlineWorkspace(props: OutlineWorkspaceProps) {
  return <OutlineWorkspaceBook key={props.bookId} {...props} />;
}

function OutlineWorkspaceBook({
  bookId,
  nav,
  theme: _theme,
  t,
  sse: _sse,
}: OutlineWorkspaceProps) {
  const { data, loading, error } = useApi<BookData>(`/books/${bookId}`);
  const { data: authoring, refetch: refetchAuthoring } = useApi<AuthoringWorkspace>(`/authoring/workspace?${workspaceQuery(bookId)}`);
  const authoringBook = authoring?.authoringBook === true;
  const restoredEdit = useRef(pendingOutlineEdits.get(bookId));
  const [volumeMap, setVolumeMap] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(restoredEdit.current?.nodeId ?? null);
  const [titleDraft, setTitleDraft] = useState(restoredEdit.current?.title ?? "");
  const [summaryDraft, setSummaryDraft] = useState(restoredEdit.current?.summary ?? "");
  const [saving, setSaving] = useState(false);
  const [editingSelected, setEditingSelected] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const weaveBeforeLeave = useRef<(() => Promise<boolean>) | null>(null);
  const registerWeaveBeforeLeave = useCallback((guard: (() => Promise<boolean>) | null) => { weaveBeforeLeave.current = guard; }, []);
  const mapState = useRef({ current: "", pending: false });
  const mapReady = useRef(false);
  const [mapLoading, setMapLoading] = useState(true);
  const mounted = useRef(true);
  const replaceVolumeMap = useCallback((content: string) => {
    mapState.current.current = content;
    setVolumeMap(content);
  }, []);

  const stage = useBookStage(bookId);
  const [pageError, setPageError] = useState<string | null>(null);
  const [splitHint, setSplitHint] = useState(false);
  const [notesOpen, setNotesOpen] = useState<Record<string, boolean>>({});
  const [preferredVolume, setPreferredVolume] = useState<{ startChapter: number; endChapter: number } | null>(null);

  const isZh = data?.book.language !== "en";
  const decision = useDraftDecision(isZh);
  const outlineSource = authoring?.candidateWeave?.body || volumeMap;
  const tree = useMemo(() => parseVolumeMapTree(outlineSource), [outlineSource]);
  const written = useMemo(
    () => new Set((data?.chapters ?? []).filter((chapter) => chapter.status).map((chapter) => chapter.number)),
    [data?.chapters],
  );
  const groundDone = Boolean(
    stage && (stage.steps.ground === "done" || stage.stage === "weave" || stage.stage === "write"),
  );

  useEffect(() => {
    mounted.current = true;
    mapReady.current = false;
    let cancelled = false;
    void fetchJson<{ content?: string | null }>(`/books/${bookId}/truth/outline/volume_map.md`)
      .then((file) => { if (!cancelled) { replaceVolumeMap(file.content ?? ""); mapReady.current = true; } })
      .catch((error) => { if (!cancelled) setPageError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!cancelled) setMapLoading(false); });
    return () => { cancelled = true; mounted.current = false; };
  }, [bookId, replaceVolumeMap]);

  const BOOK_OUTLINE_ID = "weave-book";

  useEffect(() => {
    if (selectedId || !data) return;
    setSelectedId(BOOK_OUTLINE_ID);
  }, [data, selectedId, tree]);

  const showingBookOutline = selectedId === BOOK_OUTLINE_ID;
  const selected = selectedId && !showingBookOutline ? findNodeById(tree, selectedId) : undefined;
  const detachedDraft = !showingBookOutline && !selected ? pendingOutlineEdits.get(bookId) : undefined;

  useEffect(() => {
    if (!selected) return;
    const source = outlineEditorSource(selected, { language: isZh ? "zh" : "en" });
    const draft = pendingOutlineEdits.get(bookId);
    setTitleDraft(draft?.nodeId === selected.id ? draft.title : source.title);
    setSummaryDraft(draft?.nodeId === selected.id ? draft.summary : source.summary);
    setSplitHint(source.split);
  }, [bookId, isZh, selected]);

  const changeDraft = (title: string, summary: string) => {
    if (!selected || mapState.current.pending) return;
    setTitleDraft(title); setSummaryDraft(summary);
    const source = outlineEditorSource(selected, { language: isZh ? "zh" : "en" });
    if (title === source.title && summary === source.summary) pendingOutlineEdits.delete(bookId);
    else pendingOutlineEdits.set(bookId, { nodeId: selected.id, title, summary });
  };
  useEffect(() => { installUnloadGuard(); }, []);

  const visibleVolumes = tree.volumes
    .map((volume) => ({
      ...volume,
      chapters: volume.chapters.filter((node) => nodeVisible(node, filter, query.trim().toLowerCase())),
    }))
    .filter((volume) => {
      if (volume.chapters.length > 0) return true;
      if (query && !`${volume.title} ${volume.body} ${volume.okr}`.toLowerCase().includes(query.trim().toLowerCase())) return false;
      return filter === "all";
    });
  const visibleOrphans = tree.orphanChapters.filter((node) => nodeVisible(node, filter, query.trim().toLowerCase()));
  const targetChapters = data?.book.targetChapters && data.book.targetChapters > 0
    ? data.book.targetChapters
    : Math.max(tree.chapterCount, 1);
  const plannedChapters = tree.chapterCount;

  const reloadVolumeMap = () => {
    mapReady.current = false;
    setMapLoading(true);
    void fetchJson<{ content?: string | null }>(`/books/${bookId}/truth/outline/volume_map.md`)
      .then((body) => { if (mounted.current) { replaceVolumeMap(body.content ?? ""); mapReady.current = true; setPageError(null); } })
      .catch((error) => { if (mounted.current) setPageError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (mounted.current) setMapLoading(false); });
  };

  const persistMap = async (next: string) => {
    await fetchJson(`/books/${bookId}/truth/outline/volume_map.md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: next }),
    });
    // In-flight saves can finish after navigation; the next mount will load the saved file.
    if (mounted.current) setVolumeMap(next);
  };

  const applySelectedDraft = (current: string, persistSplit = false): string => {
    if (!selected || selected.kind === "volume") return current;
    const language = isZh ? "zh" : "en";
    let nextTitle = titleDraft;
    let nextSummary = summaryDraft;
    if (selected.kind === "chapter" || selected.kind === "range") {
      const split = splitOutlineTitleAndSummary(titleDraft, summaryDraft, { language });
      nextTitle = split.title;
      nextSummary = split.summary;
      if (split.split) {
        setTitleDraft(split.title);
        setSummaryDraft(split.summary);
        setSplitHint(true);
      }
      if (persistSplit && (selected.title !== nextTitle || selected.summary !== nextSummary)) {
        return applyVolumeMapNodeEdit(current, selected.id, {
          title: nextTitle,
          summary: nextSummary,
        });
      }
    }
    return applyOutlineWorkspaceSave(current, selected.id, nextTitle, nextSummary, { language });
  };

  const saveMap = async (transform: (current: string) => string, savesDraft = false): Promise<boolean> => {
    if (mapState.current.pending || !mapReady.current) return false;
    const savingDraft = pendingOutlineEdits.get(bookId);
    setSaving(true);
    setPageError(null);
    try {
      const saved = await saveOutlineMap(mapState.current, transform, persistMap);
      if (saved && savesDraft && pendingOutlineEdits.get(bookId) === savingDraft) pendingOutlineEdits.delete(bookId);
      return saved;
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Save failed");
      return false;
    } finally {
      setSaving(false);
    }
  };
  const saveSelected = async (persistSplit = false) => {
    if (detachedDraft) {
      setPageError(isZh ? "原条目已不在卷纲中。手稿已保留，可用「新增一章」另存。" : "The original entry is no longer in the outline. Add a chapter to save the retained draft.");
      return false;
    }
    const saved = await saveMap((current) => applySelectedDraft(current, persistSplit), true);
    if (saved) setEditingSelected(false);
    return saved;
  };

  const finishSelected = async (): Promise<boolean> => {
    if (mapState.current.pending) return false;
    if (!pendingOutlineEdits.has(bookId)) { setEditingSelected(false); return true; }
    const answer = await decision.ask();
    if (answer === "cancel") { setEditingSelected(true); return false; }
    if (answer === "save") return saveSelected();
    pendingOutlineEdits.delete(bookId);
    if (selected) { const source = outlineEditorSource(selected, { language: isZh ? "zh" : "en" }); setTitleDraft(source.title); setSummaryDraft(source.summary); }
    setEditingSelected(false); return true;
  };
  const selectedLeaveRef = useRef(finishSelected);
  selectedLeaveRef.current = finishSelected;
  const selectedDirty = pendingOutlineEdits.has(bookId);
  useEffect(() => {
    if (showingBookOutline || !selectedDirty) return;
    return registerNavigationGuard(() => selectedLeaveRef.current());
  }, [showingBookOutline, selectedDirty]);

  const selectNode = async (id: string) => {
    if (id === selectedId || mapState.current.pending) return;
    if (showingBookOutline && !authoringBook && weaveBeforeLeave.current && !(await weaveBeforeLeave.current())) return;
    if (!showingBookOutline && !authoringBook && !(await finishSelected())) return;
    setEditingSelected(false);
    const node = findNodeById(tree, id);
    if (node?.kind === "volume" && node.startChapter != null && node.endChapter != null) {
      setPreferredVolume({ startChapter: node.startChapter, endChapter: node.endChapter });
    } else if (node) {
      const owner = tree.volumes.find((volume) => volume.chapters.some((chapter) => chapter.id === node.id) || volume.notes.some((note) => note.id === node.id));
      if (owner?.startChapter != null && owner.endChapter != null) {
        setPreferredVolume({ startChapter: owner.startChapter, endChapter: owner.endChapter });
      }
    }
    setSelectedId(id);
  };
  const saveCurrentRef = useRef<() => Promise<unknown>>(async () => undefined);
  saveCurrentRef.current = () => saveSelected();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!showingBookOutline && editingSelected && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !document.querySelector('[role="dialog"]')) {
        event.preventDefault(); void saveCurrentRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showingBookOutline, editingSelected]);

  const addFirstChapter = async () => {
    if (mapState.current.pending) return;
    if (showingBookOutline && weaveBeforeLeave.current && !(await weaveBeforeLeave.current())) return;
    if (!showingBookOutline && !detachedDraft && !(await finishSelected())) return;
    let addedChapter = 0;
    const saved = await saveMap((current) => {
      // Save the selected draft and append against that result in one file write.
      const next = appendUnplannedChapter(showingBookOutline || detachedDraft ? current : applySelectedDraft(current), data?.nextChapter ?? 1);
      addedChapter = next.chapterNumber;
      return detachedDraft ? applyOutlineWorkspaceSave(next.content, `chapter:${addedChapter}`, detachedDraft.title, detachedDraft.summary, { language: isZh ? "zh" : "en" }) : next.content;
    }, !showingBookOutline);
    if (saved) { setSelectedId(`chapter:${addedChapter}`); setEditingSelected(false); }
  };

  const tidyOutline = async (deep = false) => {
    if (mapState.current.pending) return;
    if (detachedDraft) { await saveSelected(); return; }
    if (!showingBookOutline) {
      const source = selected && outlineEditorSource(selected, { language: isZh ? "zh" : "en" });
      if (source && (titleDraft !== source.title || summaryDraft !== source.summary)) {
        setPageError(isZh ? "请先保存当前修改，再整理卷纲。" : "Save your current edits before tidying.");
        return;
      }
    }
    const language = isZh ? "zh" : "en";
    await saveMap((current) => deep
      ? tidyVolumeMapMarkdown(current, language)
      : normalizeVolumeMapChapterHeadings(current, { language }));
  };

  const goWrite = async () => { if (await finishSelected()) (nav.toWrite ?? nav.toBookSettings)(bookId); };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 space-y-4">
        <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
        <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
      </div>
    );
  }
  if (error) return <div className="text-destructive p-8">Error: {error}</div>;
  if (!data) return null;

  const empty = tree.volumeCount === 0 && tree.chapterCount === 0;
  const ungrounded = stage !== null && !groundDone;
  const guide = weaveGuideWhenUngrounded(isZh);

  return (
    <div className="space-y-5 fade-in" data-testid="outline-workspace">
      <h1 className="sr-only">{isZh ? "织卷" : "Weave"}</h1>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" className="btn-ghost inline-flex items-center gap-2" aria-expanded={directoryOpen} onClick={() => setDirectoryOpen((value) => !value)}><List size={16} />{isZh ? "卷章目录" : "Outline directory"}</button>
        <div className="text-xs text-muted-foreground" data-testid="outline-stats">
          {tree.volumeCount === 0
            ? (isZh ? `全书 ${targetChapters} 章 · 尚未分卷` : `${targetChapters} chapters · no volumes yet`)
            : (isZh
              ? `已排 ${plannedChapters} / 目标 ${targetChapters} 章 · ${tree.volumeCount} 卷`
              : `${plannedChapters} / ${targetChapters} outlined · ${tree.volumeCount} volumes`)}
        </div>
      </div>

      {ungrounded ? (
        <div
          className="rounded-xl border border-border/50 bg-secondary/30 px-3 py-2 text-sm text-muted-foreground"
          data-testid="outline-ungrounded"
        >
          {guide.subtitle}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => (nav.toGround ?? nav.toTruth ?? nav.toBook)(bookId)}
          >
            {guide.action}
          </button>
        </div>
      ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={isZh ? "搜索卷 / 章" : "Search"}
              className="rounded-[10px] border border-border-strong bg-card px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                data-testid="outline-filter"
                className="btn-ghost inline-flex items-center gap-1 text-[13px]"
              >
                {isZh ? "筛选" : "Filter"} ▾
                <span className="text-muted-foreground">
                  {filter === "all"
                    ? (isZh ? "全部" : "All")
                    : filter === "coarse"
                      ? (isZh ? "仅粗纲" : "Coarse")
                      : filter === "pending"
                        ? (isZh ? "待细化" : "To refine")
                        : (isZh ? "已细化" : "Refined")}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {([
                  ["all", isZh ? "全部" : "All"],
                  ["coarse", isZh ? "仅粗纲" : "Coarse"],
                  ["pending", isZh ? "待细化" : "To refine"],
                  ["refined", isZh ? "已细化" : "Refined"],
                ] as const).map(([item, label]) => (
                  <DropdownMenuItem
                    key={item}
                    data-testid={`outline-filter-${item}`}
                    onClick={() => setFilter(item)}
                  >
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

            <div className={`one-workspace ${!directoryOpen ? "directory-collapsed" : ""}`} data-testid="outline-split">
              <div className="one-directory flex flex-col" hidden={!directoryOpen}>
                <button
                  type="button"
                  className={`dir-item ${showingBookOutline ? "active" : ""}`}
                  data-testid="outline-book-outline"
                  onClick={() => void selectNode(BOOK_OUTLINE_ID)}
                >
                  {t("weave.bookOutline")}
                  <small>{isZh ? "全书规划" : "Book plan"}</small>
                </button>
                <p className="px-3 py-2 text-xs text-muted-foreground">{isZh ? "已采用卷纲" : "Adopted outline"}</p>
                <div className="flex-1">
                {visibleVolumes.map((volume) => (
                  <div key={volume.id}>
                    <button
                      type="button"
                      data-testid="outline-volume-label"
                      onClick={() => void selectNode(volume.id)}
                      className={`dir-item ${selectedId === volume.id ? "active" : ""}`}
                      title={volume.title}
                    >
                      {outlineTreeVolumeLabel(volume.volumeNumber, volume.title, isZh) || (isZh ? "未命名卷" : "Untitled volume")}
                    </button>
                    {volume.chapters.map((node) => (
                      <ChapterRow
                        key={node.id}
                        node={node}
                        selected={selectedId === node.id}
                        written={written.has(node.chapterNumber)}
                        onClick={() => void selectNode(node.id)}
                        isZh={isZh}
                      />
                    ))}
                    {volume.notes.length > 0 && (
                      <NotesFold
                        notes={volume.notes}
                        open={Boolean(notesOpen[volume.id])}
                        onToggle={() => setNotesOpen((prev) => ({ ...prev, [volume.id]: !prev[volume.id] }))}
                        selectedId={selectedId}
                        onSelect={(id) => void selectNode(id)}
                        isZh={isZh}
                      />
                    )}
                  </div>
                ))}
                {visibleOrphans.map((node) => (
                  <ChapterRow
                    key={node.id}
                    node={node}
                    selected={selectedId === node.id}
                    written={written.has(node.chapterNumber)}
                    onClick={() => void selectNode(node.id)}
                    isZh={isZh}
                  />
                ))}
                {tree.orphanNotes.length > 0 && (
                  <NotesFold
                    notes={tree.orphanNotes}
                    open={Boolean(notesOpen.orphan)}
                    onToggle={() => setNotesOpen((prev) => ({ ...prev, orphan: !prev.orphan }))}
                    selectedId={selectedId}
                    onSelect={(id) => void selectNode(id)}
                    isZh={isZh}
                  />
                )}
                </div>
                <div className="flex items-center gap-3 border-t border-border/30 px-3 py-2">
                  <DropdownMenu><DropdownMenuTrigger className="btn-ghost inline-flex items-center gap-2" aria-label={isZh ? "卷纲操作" : "Outline operations"}><MoreHorizontal size={17} />{isZh ? "卷纲操作" : "Outline operations"}</DropdownMenuTrigger><DropdownMenuContent align="start">
                  {authoringBook ? (
                    <DropdownMenuItem disabled>
                      {isZh ? "请到全书规划中编辑候选" : "Edit candidates in Book outline"}
                    </DropdownMenuItem>
                  ) : (
                    <>
                  <DropdownMenuItem
                    data-testid="outline-add-chapter"
                    onClick={() => void addFirstChapter()}
                    disabled={saving || mapLoading || !mapReady.current}
                  >
                    {isZh ? "新增一章" : "Add chapter"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="outline-tidy"
                    title={isZh ? "只整理超长短题。按住 Alt 深度整理卷头与备注。" : "Normalize long titles. Hold Alt for a deep tidy."}
                    onClick={(event) => void tidyOutline(event.altKey)}
                    disabled={saving || mapLoading || !mapReady.current}
                  >
                    {isZh ? "整理卷纲" : "Tidy volumes"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="outline-tidy-deep"
                    onClick={() => void tidyOutline(true)}
                    disabled={saving || mapLoading || !mapReady.current}
                  >
                    {isZh ? "深度整理" : "Deep tidy"}
                  </DropdownMenuItem>
                    </>
                  )}
                  </DropdownMenuContent></DropdownMenu>
                </div>
              </div>

              <div className="one-document space-y-4 min-h-[360px]" data-testid="outline-detail">
                <div hidden={!showingBookOutline && !authoringBook}>
                  <AuthoringWeavePanel
                    bookId={bookId}
                    targetChapters={targetChapters}
                    isZh={isZh}
                    active={showingBookOutline || authoringBook}
                    preferredVolume={preferredVolume}
                    selectedNodeId={showingBookOutline ? null : selectedId}
                    adoptedMap={volumeMap}
                    onRegisterBeforeLeave={registerWeaveBeforeLeave}
                    onGoAsk={() => nav.toAsk(bookId)}
                    onChanged={() => { void refetchAuthoring(); }}
                    onAdopted={() => {
                      void reloadVolumeMap();
                      void refetchAuthoring();
                    }}
                  />
                </div>
                {!showingBookOutline && !authoringBook && <div className="space-y-4">
                <p className="text-xs text-muted-foreground">{isZh ? "已采用卷纲" : "Adopted outline"}{selectedDirty ? (isZh ? " · 未保存修改" : " · Unsaved changes") : ""}</p>
                {detachedDraft ? (
                  <div className="space-y-3">
                    <p role="status" className="text-sm text-muted-foreground">{isZh ? "原条目已不在卷纲中，手稿已保留。点击左侧「新增一章」可另存。" : "The original entry was removed. Add a chapter to save this retained draft."}</p>
                    <input aria-label={isZh ? "保留的标题" : "Retained title"} value={detachedDraft.title} readOnly className="w-full bg-background font-serif text-xl" />
                    <textarea aria-label={isZh ? "保留的手稿" : "Retained draft"} value={detachedDraft.summary} readOnly rows={8} className="w-full bg-background text-sm leading-6" />
                  </div>
                ) : empty ? (
                  <LiteraryEmpty
                    title={isZh ? "还没有卷纲" : "No volume outline yet"}
                    subtitle={isZh ? "用左侧「全书大纲」生成，或在下面手动加章。" : "Generate from Book outline, or add a chapter by hand."}
                    testId="outline-empty"
                  />
                ) : !selected ? (
                  <p className="text-sm text-muted-foreground">{isZh ? "点左侧任意一章" : "Pick a chapter on the left"}</p>
                ) : selected.kind === "volume" ? (
                  <VolumeDetail volumeTitle={selected.title} okr={selected.okr} startChapter={selected.startChapter} endChapter={selected.endChapter} locked={selected.startChapter != null && selected.endChapter != null} isZh={isZh} />
                ) : !editingSelected ? <>
                  <ManuscriptView body={`## ${titleDraft || selected.title}\n\n${summaryDraft}`} />
                  <div className="manuscript-action-buttons ground-document-actions">{authoringBook ? <p className="text-sm text-muted-foreground">{isZh ? "请到全书规划中编辑候选并采用。新四阶段书不直接改已采用卷纲。" : "Edit the candidate in Book outline, then adopt. Direct edits to the adopted map are disabled for four-stage books."}</p> : <button type="button" disabled={saving || mapLoading} onClick={() => setEditingSelected(true)}>{isZh ? "编辑" : "Edit"}</button>}{selected.kind === "chapter" ? <button type="button" className="quiet" onClick={() => void goWrite()}>{isZh ? "去落笔" : "Go to Write"}</button> : null}</div>
                </> : selected.kind === "note" ? (
                  <>
                    <div className="text-xs text-muted-foreground">{isZh ? "备注" : "Note"}</div>
                    <input
                      value={titleDraft}
                      onChange={(event) => changeDraft(event.target.value, summaryDraft)}
                      readOnly={saving || mapLoading}
                      aria-label={isZh ? "备注标题" : "Note title"}
                      className="w-full rounded-lg border border-border/50 bg-secondary/20 px-3 py-2 font-serif text-xl outline-none focus:border-primary/50"
                    />
                    <textarea
                      value={summaryDraft}
                      onChange={(event) => changeDraft(titleDraft, event.target.value)}
                      rows={8}
                      readOnly={saving || mapLoading}
                      aria-label={isZh ? "备注内容" : "Note content"}
                      className="w-full rounded-lg border border-border/50 bg-secondary/20 px-3 py-2 text-sm leading-6 outline-none focus:border-primary/50"
                    />
                    <div className="manuscript-action-buttons ground-document-actions">{authoringBook ? <p className="text-sm text-muted-foreground">{isZh ? "请到全书规划中编辑候选并采用。" : "Edit the candidate in Book outline, then adopt."}</p> : <button type="button" disabled={saving || mapLoading || !mapReady.current} onClick={() => void saveSelected()}>{isZh ? "保存已采用卷纲" : "Save adopted outline"}</button>}<button type="button" className="quiet" disabled={saving} onClick={() => void finishSelected()}>{isZh ? "取消" : "Cancel"}</button></div>
                  </>
                ) : (
                  <>
                    <div className="text-xs text-muted-foreground">
                      {selected.kind === "range" && selected.endChapter
                        ? (isZh ? `第 ${selected.chapterNumber}–${selected.endChapter} 章（粗纲）` : `Ch. ${selected.chapterNumber}–${selected.endChapter} (coarse)`)
                        : (isZh ? `第 ${selected.chapterNumber} 章` : `Chapter ${selected.chapterNumber}`)}
                    </div>
                    <label className="block space-y-1">
                      <span className="text-[13px] text-muted-foreground">{isZh ? "短题" : "Short title"}</span>
                      <div className="relative">
                        <input
                          value={titleDraft}
                          maxLength={selected.kind === "range" ? undefined : (isZh ? HARD_CHAPTER_TITLE_CHARS : HARD_CHAPTER_TITLE_CHARS * 2)}
                          onChange={(event) => changeDraft(event.target.value, summaryDraft)}
                          readOnly={saving || mapLoading}
                          className="w-full rounded-[10px] border border-border-strong bg-card px-3 py-2 pr-14 font-serif text-xl outline-none focus:ring-1 focus:ring-ring"
                        />
                        {selected.kind !== "range" && (
                          <span
                            className={`absolute bottom-2 right-3 text-[12px] tabular-nums ${
                              [...titleDraft].length > (isZh ? MAX_CHAPTER_TITLE_CHARS : MAX_CHAPTER_TITLE_CHARS * 2)
                                ? "text-seal"
                                : "text-muted-foreground"
                            }`}
                            data-testid="outline-title-count"
                          >
                            {isZh
                              ? `${[...titleDraft].length} / 12`
                              : `${[...titleDraft].length} / 24`}
                          </span>
                        )}
                      </div>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-xs text-muted-foreground">{isZh ? "提要" : "Summary"}</span>
                      <textarea
                        value={summaryDraft}
                        onChange={(event) => changeDraft(titleDraft, event.target.value)}
                        rows={8}
                        readOnly={saving || mapLoading}
                        className="w-full rounded-lg border border-border/50 bg-secondary/20 px-3 py-2 text-sm leading-6 outline-none focus:border-primary/50"
                      />
                    </label>
                    {splitHint && (
                      <p className="text-xs text-muted-foreground">{isZh ? "标题偏长，已拆成短题与提要。" : "Long title was split into title + summary."}</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (authoringBook) {
                            showToast(isZh ? "请到全书规划中编辑候选并采用。" : "Edit the candidate in Book outline, then adopt.", "info");
                            return;
                          }
                          void saveSelected(true);
                        }}
                        disabled={saving || mapLoading || !mapReady.current || authoringBook}
                        className="btn-secondary disabled:opacity-50"
                      >
                        {saving
                          ? t("common.loading")
                          : authoringBook
                            ? (isZh ? "请到全书规划中采用" : "Adopt from Book outline")
                            : (isZh ? "保存已采用卷纲" : "Save adopted outline")}
                      </button>
                      <button type="button" className="btn-ghost" disabled={saving} onClick={() => void finishSelected()}>{isZh ? "取消" : "Cancel"}</button>
                      {selected.kind === "chapter" && (
                        <button
                          type="button"
                          data-testid="outline-go-write"
                          onClick={() => void goWrite()}
                          disabled={saving || mapLoading || !mapReady.current}
                          className="btn-ghost"
                        >
                          {isZh ? "去落笔 →" : "Go write →"}
                        </button>
                      )}
                    </div>
                  </>
                )}
                </div>}
              </div>
            </div>

      {pageError && <p role="alert" className="text-sm text-destructive">{pageError} {!mapReady.current && <button type="button" disabled={mapLoading} onClick={reloadVolumeMap}>{isZh ? "重新加载卷纲" : "Reload outline"}</button>}</p>}
      {decision.dialog}
    </div>
  );
}

function VolumeDetail({
  volumeTitle,
  okr,
  startChapter,
  endChapter,
  locked,
  isZh,
}: {
  readonly volumeTitle: string;
  readonly okr: string;
  readonly startChapter?: number;
  readonly endChapter?: number;
  readonly locked: boolean;
  readonly isZh: boolean;
}) {
  const copy = formatVolumeArriveCopy(okr, isZh);
  return (
    <div className="space-y-3" data-testid="outline-volume-detail">
      <div className="font-serif text-2xl">{volumeTitle}</div>
      <div className="text-sm text-muted-foreground">
        {startChapter && endChapter
          ? (isZh ? `第 ${startChapter}–${endChapter} 章` : `Ch. ${startChapter}–${endChapter}`)
          : (isZh ? "章范围未定" : "Range unset")}
        {" · "}
        {locked ? (isZh ? "已锁" : "Locked") : (isZh ? "未锁" : "Unlocked")}
      </div>
      {copy.arrive && (
        <div>
          <div className="text-xs text-muted-foreground">{isZh ? "本卷要抵达" : "Arrive at"}</div>
          <p className="text-sm leading-6">{copy.arrive}</p>
        </div>
      )}
      {copy.mustLand && (
        <div>
          <div className="text-xs text-muted-foreground">{isZh ? "卷末必须落下" : "Must land"}</div>
          <p className="text-sm leading-6">{copy.mustLand}</p>
        </div>
      )}
    </div>
  );
}

function NotesFold({
  notes,
  open,
  onToggle,
  selectedId,
  onSelect,
  isZh,
}: {
  readonly notes: ReadonlyArray<VolumeMapNoteNode>;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly isZh: boolean;
}) {
  return (
    <div data-testid="outline-notes">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/30"
      >
        {open ? "▾" : "▸"} {isZh ? `备注（${notes.length}）` : `Notes (${notes.length})`}
      </button>
      {open && notes.map((note) => (
        <button
          key={note.id}
          type="button"
          onClick={() => onSelect(note.id)}
          className={`w-full truncate px-7 py-1.5 text-left text-sm ${
            selectedId === note.id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/30"
          }`}
        >
          {truncateOutlineLabel(note.title || (isZh ? "备注" : "Note"))}
        </button>
      ))}
    </div>
  );
}

function ChapterRow({
  node,
  selected,
  written,
  onClick,
  isZh,
}: {
  readonly node: VolumeMapChapterNode;
  readonly selected: boolean;
  readonly written: boolean;
  readonly onClick: () => void;
  readonly isZh: boolean;
}) {
  const coarse = node.kind === "range";
  const label = coarse && node.endChapter
    ? (isZh ? `第 ${node.chapterNumber}–${node.endChapter} 章（粗纲）` : `Ch. ${node.chapterNumber}–${node.endChapter} (coarse)`)
    : (isZh ? `第 ${node.chapterNumber} 章` : `Ch. ${node.chapterNumber}`);
  const shortTitle = splitOutlineTitleAndSummary(node.title, node.summary, { language: isZh ? "zh" : "en" }).title;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={coarse ? "outline-coarse-row" : "outline-chapter-row"}
      className={`flex w-full items-center gap-2 px-5 py-1.5 text-left text-sm border-b border-border/20 ${
        coarse ? "text-muted-foreground/70" : ""
      } ${selected ? "bg-primary/10 text-primary" : "hover:bg-muted/30 text-muted-foreground"}`}
    >
      {coarse ? null : <StageDot state={written ? "done" : "todo"} />}
      <span className="truncate">{label}{shortTitle ? ` ${truncateOutlineLabel(shortTitle)}` : ""}</span>
    </button>
  );
}
