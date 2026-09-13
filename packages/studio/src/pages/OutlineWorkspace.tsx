/**
 * 织卷: authoring full-book outline + tree editor. Old batch-10 weave CTA removed.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { fetchJson, useApi } from "../hooks/use-api";
import { useEffect, useMemo, useState } from "react";
import type { SSEMessage } from "../hooks/use-sse";
import type { BookWorkspaceNavTarget } from "../components/BookWorkspaceNav";
import { LiteraryEmpty } from "../components/LiteraryEmpty";
import { AuthoringWeavePanel } from "../components/AuthoringWeavePanel";
import {
  applyOutlineWorkspaceSave,
  applyVolumeMapNodeEdit,
  findNodeById,
  HARD_CHAPTER_TITLE_CHARS,
  insertChapterStub,
  lockedNamedVolumeCount,
  MAX_CHAPTER_TITLE_CHARS,
  normalizeVolumeMapChapterHeadings,
  outlineEditorSource,
  parseVolumeMapTree,
  recommendedOutlineNodeId,
  splitOutlineTitleAndSummary,
  tidyVolumeMapMarkdown,
  truncateOutlineLabel,
  type VolumeMapChapterNode,
  type VolumeMapNoteNode,
} from "../lib/volume-map-tree";
import {
  outlineTreeVolumeLabel,
} from "../lib/outline-weave";
import { formatVolumeArriveCopy } from "../lib/copy-map";
import { weaveGuideWhenUngrounded } from "../lib/stage-copy";
import { useBookStage } from "../hooks/use-book-stage";
import { StageDot } from "../components/StageDot";
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

export function OutlineWorkspace({
  bookId,
  nav,
  theme: _theme,
  t,
  sse: _sse,
}: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse?: { readonly messages: ReadonlyArray<SSEMessage> };
}) {
  const { data, loading, error } = useApi<BookData>(`/books/${bookId}`);
  const [volumeMap, setVolumeMap] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [summaryDraft, setSummaryDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const stage = useBookStage(bookId);
  const [pageError, setPageError] = useState<string | null>(null);
  const [splitHint, setSplitHint] = useState(false);
  const [notesOpen, setNotesOpen] = useState<Record<string, boolean>>({});

  const isZh = data?.book.language !== "en";
  const tree = useMemo(() => parseVolumeMapTree(volumeMap), [volumeMap]);
  const written = useMemo(
    () => new Set((data?.chapters ?? []).filter((chapter) => chapter.status).map((chapter) => chapter.number)),
    [data?.chapters],
  );
  const groundDone = Boolean(
    stage && (stage.steps.ground === "done" || stage.stage === "weave" || stage.stage === "write"),
  );

  useEffect(() => {
    void Promise.all([
      fetchJson<{ content?: string | null }>(`/books/${bookId}/truth/outline/volume_map.md`).catch(() => ({ content: "" })),
      fetchJson<{ candidateWeave?: { body?: string } }>(`/authoring/workspace?bookId=${encodeURIComponent(bookId)}`).catch(() => ({ candidateWeave: undefined })),
    ]).then(([file, workspace]) => {
      const adopted = file.content ?? "";
      setVolumeMap(adopted.trim() ? adopted : (workspace.candidateWeave?.body ?? ""));
    }).catch(() => setVolumeMap(""));
  }, [bookId]);

  useEffect(() => {
    if (selectedId || !data) return;
    setSelectedId(recommendedOutlineNodeId(tree, data.nextChapter));
  }, [data, selectedId, tree]);

  const selected = selectedId ? findNodeById(tree, selectedId) : undefined;

  useEffect(() => {
    if (!selected) return;
    const source = outlineEditorSource(selected, { language: isZh ? "zh" : "en" });
    setTitleDraft(source.title);
    setSummaryDraft(source.summary);
    setSplitHint(source.split);
  }, [isZh, selected]);

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
  const lockedVolumes = lockedNamedVolumeCount(tree);
  const plannedChapters = tree.chapterCount;

  const reloadVolumeMap = () => {
    void fetchJson<{ content?: string | null }>(`/books/${bookId}/truth/outline/volume_map.md`)
      .then((body) => setVolumeMap(body.content ?? ""))
      .catch(() => setVolumeMap(""));
  };

  const persistMap = async (next: string) => {
    await fetchJson(`/books/${bookId}/truth/outline/volume_map.md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: next }),
    });
    setVolumeMap(next);
  };

  const saveSelected = async (persistSplit = false) => {
    if (!selected) return;
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
        const next = applyVolumeMapNodeEdit(volumeMap, selected.id, {
          title: nextTitle,
          summary: nextSummary,
        });
        if (next === volumeMap) return;
        setSaving(true);
        setPageError(null);
        try {
          await persistMap(next);
        } catch (err) {
          setPageError(err instanceof Error ? err.message : "Save failed");
        } finally {
          setSaving(false);
        }
        return;
      }
    }
    const next = applyOutlineWorkspaceSave(volumeMap, selected.id, nextTitle, nextSummary, { language });
    if (next === volumeMap) return;
    setSaving(true);
    setPageError(null);
    try {
      await persistMap(next);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const addFirstChapter = async () => {
    const next = insertChapterStub(volumeMap, data?.nextChapter ?? 1);
    setSaving(true);
    setPageError(null);
    try {
      await persistMap(next);
      setSelectedId(`chapter:${data?.nextChapter ?? 1}`);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const tidyOutline = async (deep = false) => {
    const language = isZh ? "zh" : "en";
    const next = deep
      ? tidyVolumeMapMarkdown(volumeMap, language)
      : normalizeVolumeMapChapterHeadings(volumeMap, { language });
    if (next === volumeMap) return;
    setSaving(true);
    setPageError(null);
    try {
      await persistMap(next);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const goWrite = () => (nav.toWrite ?? nav.toBookSettings)(bookId);

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
      <header className="space-y-1">
        <p className="eyebrow text-[13px] font-medium text-muted-foreground">{isZh ? `《${data.book.title}》` : data.book.title}</p>
        <h1 className="font-serif text-[32px] font-medium leading-10">{isZh ? "织卷" : "Weave"}</h1>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground" data-testid="outline-stats">
          {isZh
            ? `已排 ${plannedChapters} / 目标 ${targetChapters} 章 · 已锁 ${lockedVolumes} / ${tree.volumeCount} 卷`
            : `${plannedChapters} / ${targetChapters} outlined · ${lockedVolumes} / ${tree.volumeCount} locked volumes`}
        </div>
      </div>

      <AuthoringWeavePanel
        bookId={bookId}
        targetChapters={targetChapters}
        isZh={isZh}
        onAdopted={() => {
          void reloadVolumeMap();
          (nav.toWrite ?? nav.toBookSettings)?.(bookId);
        }}
      />

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

          {empty ? (
            <LiteraryEmpty
              title={isZh ? "还没有卷纲" : "No volume outline yet"}
              subtitle={isZh ? "用上方「规划全书每章概要」生成，或在下面手动加章。" : "Use “plan every chapter” above, or add a chapter by hand."}
              testId="outline-empty"
            />
          ) : (
            <div className="grid gap-5 md:grid-cols-[280px_1fr]" data-testid="outline-split">
              <div className="rounded-2xl border border-border/40 overflow-hidden flex flex-col">
                <div className="flex-1">
                {visibleVolumes.map((volume) => (
                  <div key={volume.id}>
                    <button
                      type="button"
                      data-testid="outline-volume-label"
                      onClick={() => setSelectedId(volume.id)}
                      className={`w-full truncate px-3 py-2 text-left text-sm font-medium border-b border-border/30 ${
                        selectedId === volume.id ? "bg-primary/10 text-primary" : "hover:bg-muted/30"
                      }`}
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
                        onClick={() => setSelectedId(node.id)}
                        isZh={isZh}
                      />
                    ))}
                    {volume.notes.length > 0 && (
                      <NotesFold
                        notes={volume.notes}
                        open={Boolean(notesOpen[volume.id])}
                        onToggle={() => setNotesOpen((prev) => ({ ...prev, [volume.id]: !prev[volume.id] }))}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
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
                    onClick={() => setSelectedId(node.id)}
                    isZh={isZh}
                  />
                ))}
                {tree.orphanNotes.length > 0 && (
                  <NotesFold
                    notes={tree.orphanNotes}
                    open={Boolean(notesOpen.orphan)}
                    onToggle={() => setNotesOpen((prev) => ({ ...prev, orphan: !prev.orphan }))}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    isZh={isZh}
                  />
                )}
                </div>
                <div className="flex items-center gap-3 border-t border-border/30 px-3 py-2">
                  <button
                    type="button"
                    data-testid="outline-add-chapter"
                    onClick={() => void addFirstChapter()}
                    
                    className="btn-ghost h-8 px-1 text-[13px] underline decoration-[color-mix(in_oklch,var(--foreground)_35%,transparent)] hover:decoration-seal disabled:opacity-40"
                  >
                    {isZh ? "新增一章" : "Add chapter"}
                  </button>
                  <button
                    type="button"
                    data-testid="outline-tidy"
                    title={isZh ? "只整理超长短题。按住 ⌥ 深度整理卷头与备注。" : "Normalize long titles. Hold ⌥ for a deep tidy."}
                    onClick={(event) => void tidyOutline(event.altKey)}
                    
                    className="btn-ghost h-8 px-1 text-[13px] underline decoration-[color-mix(in_oklch,var(--foreground)_35%,transparent)] hover:decoration-seal disabled:opacity-40"
                  >
                    {isZh ? "整理卷纲" : "Tidy volumes"}
                  </button>
                  <button
                    type="button"
                    data-testid="outline-tidy-deep"
                    onClick={() => void tidyOutline(true)}
                    
                    className="btn-ghost h-8 px-1 text-[13px] text-muted-foreground underline decoration-[color-mix(in_oklch,var(--foreground)_25%,transparent)] hover:decoration-seal disabled:opacity-40"
                  >
                    {isZh ? "深度整理" : "Deep tidy"}
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-border/40 p-5 space-y-4 min-h-[360px]" data-testid="outline-detail">
                {!selected ? (
                  <p className="text-sm text-muted-foreground">{isZh ? "点左侧任意一章" : "Pick a chapter on the left"}</p>
                ) : selected.kind === "volume" ? (
                  <VolumeDetail volumeTitle={selected.title} okr={selected.okr} startChapter={selected.startChapter} endChapter={selected.endChapter} locked={selected.startChapter != null && selected.endChapter != null} isZh={isZh} />
                ) : selected.kind === "note" ? (
                  <>
                    <div className="text-xs text-muted-foreground">{isZh ? "备注" : "Note"}</div>
                    <input
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onBlur={() => void saveSelected()}
                      
                      className="w-full rounded-lg border border-border/50 bg-secondary/20 px-3 py-2 font-serif text-xl outline-none focus:border-primary/50"
                    />
                    <textarea
                      value={summaryDraft}
                      onChange={(event) => setSummaryDraft(event.target.value)}
                      rows={8}
                      
                      className="w-full rounded-lg border border-border/50 bg-secondary/20 px-3 py-2 text-sm leading-6 outline-none focus:border-primary/50"
                    />
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
                          onChange={(event) => setTitleDraft(event.target.value)}
                          onBlur={() => void saveSelected(false)}
                          
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
                        onChange={(event) => setSummaryDraft(event.target.value)}
                        rows={8}
                        
                        className="w-full rounded-lg border border-border/50 bg-secondary/20 px-3 py-2 text-sm leading-6 outline-none focus:border-primary/50"
                      />
                    </label>
                    {splitHint && (
                      <p className="text-xs text-muted-foreground">{isZh ? "标题偏长，已拆成短题与提要。" : "Long title was split into title + summary."}</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void saveSelected(true)}
                        disabled={saving}
                        className="btn-secondary disabled:opacity-50"
                      >
                        {saving
                          ? t("common.loading")
                          : splitHint
                            ? (isZh ? "保存拆分" : "Save split")
                            : (isZh ? "保存" : "Save")}
                      </button>
                      {selected.kind === "chapter" && (
                        <button
                          type="button"
                          data-testid="outline-go-write"
                          onClick={goWrite}
                          className="btn-ghost"
                        >
                          {isZh ? "去落笔 →" : "Go write →"}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

      {pageError && <p className="text-sm text-destructive">{pageError}</p>}
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
