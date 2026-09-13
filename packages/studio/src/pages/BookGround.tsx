/**
 * 研墨: catalog authoring panel + optional seven-section file editor.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useState } from "react";
import { AskStoryCard } from "../components/AskStoryCard";
import { AuthoringGroundPanel } from "../components/AuthoringGroundPanel";
import type { BookWorkspaceNavTarget } from "../components/BookWorkspaceNav";
import { LiteraryEmpty } from "../components/LiteraryEmpty";
import { StageDot } from "../components/StageDot";
import { TruthProposalCard, type PendingTruthProposal } from "../components/TruthProposalCard";
import { fetchJson, putApi, useApi } from "../hooks/use-api";
import { invalidateBookStage, useBookStage } from "../hooks/use-book-stage";
import type { TFunction } from "../hooks/use-i18n";
import type { Theme } from "../hooks/use-theme";
import { GROUND_PLATFORM_VALUES, platformLabel } from "../lib/copy-map";
import { GROUND_REEDIT_WARNING } from "../lib/ground-confirm";
import {
  addOpenQuestion,
  CONTINUE_WITH_OPEN_MARK,
  parseOpenQuestions,
  removeOpenQuestion,
  serializeOpenQuestions,
  type OpenQuestionsDoc,
} from "../lib/open-questions";
import { formatConfirmedDate } from "../lib/stage-copy";
import {
  EMPTY_STORY_CARD,
  mergeStoryCard,
  REOPEN_ASK_PROMPT,
  storyCardReady,
  type StoryCardDraft,
  type StoryCardResolved,
} from "../lib/story-card";
import { extractStoryFrameZone, replaceStoryFrameZone, type GroundFrameZone } from "../lib/story-frame-sections";
import { showToast } from "../lib/toast";
import { useChatStore } from "../store/chat";

type GroundSectionId = "basics" | "summary" | "world" | "characters" | "conflict" | "ending" | "open";

interface Nav extends BookWorkspaceNavTarget {
  readonly toDashboard: () => void;
  readonly toTruth: (bookId: string) => void;
}

interface TruthFile {
  readonly name: string;
  readonly size: number;
}

interface GroundBook {
  readonly title?: string;
  readonly platform?: string;
  readonly genre?: string;
  readonly targetChapters?: number;
  readonly chapterWordCount?: number;
  readonly status?: string;
}

const SECTIONS: ReadonlyArray<{ id: GroundSectionId; zh: string; en: string }> = [
  { id: "basics", zh: "基础设定", en: "Basics" },
  { id: "summary", zh: "故事概要", en: "Summary" },
  { id: "world", zh: "世界规则", en: "World" },
  { id: "characters", zh: "人物设定", en: "People" },
  { id: "conflict", zh: "关系与主线", en: "Conflict" },
  { id: "ending", zh: "结局与伏笔", en: "Ending" },
  { id: "open", zh: "其他待定项", en: "Open" },
];

const EDITOR_CLASS =
  "w-full rounded-[10px] border border-border-strong bg-card px-3 py-2 font-serif text-[15px] leading-[26px] outline-none focus:ring-1 focus:ring-ring";

function scrollToSection(id: GroundSectionId): void {
  document.getElementById(`ground-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function BookGround({
  bookId,
  nav,
  t,
  isZh,
}: {
  readonly bookId: string;
  readonly nav: Nav;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly isZh: boolean;
}) {
  const { data: bookData, refetch: refetchBook } = useApi<{ book?: GroundBook }>(`/books/${bookId}`);
  const { data: filesData, refetch: refetchFiles } = useApi<{ files?: ReadonlyArray<TruthFile> }>(`/books/${bookId}/truth`);
  const { data: frameData, refetch: refetchFrame } = useApi<{ content?: string | null }>(`/books/${bookId}/truth/outline/story_frame.md`);
  const { data: hooksData, refetch: refetchHooks } = useApi<{ content?: string | null }>(`/books/${bookId}/truth/pending_hooks.md`);
  const { data: openData, refetch: refetchOpen } = useApi<{ content?: string | null }>(`/books/${bookId}/truth/open_questions.md`);
  const { data: cardData, refetch: refetchCard } = useApi<StoryCardResolved>(`/books/${bookId}/story-card`);
  const { data: intentData, refetch: refetchIntent } = useApi<{ content?: string | null }>(`/books/${bookId}/truth/author_intent.md`);
  const stageData = useBookStage(bookId);
  const bumpBookDataVersion = useChatStore((state) => state.bumpBookDataVersion);
  const createDraftSession = useChatStore((state) => state.createDraftSession);
  const setInput = useChatStore((state) => state.setInput);
  const refreshStage = () => {
    invalidateBookStage(bookId);
    bumpBookDataVersion();
  };
  const { data: proposalsData, refetch: refetchProposals } = useApi<{ proposals?: ReadonlyArray<PendingTruthProposal> }>(
    `/books/${bookId}/truth-proposals?status=pending`,
  );
  const book = bookData?.book;
  const title = book?.title ?? bookId;
  const files = filesData?.files ?? [];
  const roleFiles = files.filter((file) => /^roles\/(主要角色|major)\//.test(file.name));
  const allRoleFiles = files.filter((file) => file.name.startsWith("roles/"));
  const [frameText, setFrameText] = useState("");
  const [themeDraft, setThemeDraft] = useState("");
  const [worldDraft, setWorldDraft] = useState("");
  const [conflictDraft, setConflictDraft] = useState("");
  const [endingDraft, setEndingDraft] = useState("");
  const [hooksText, setHooksText] = useState("");
  const [intentDraft, setIntentDraft] = useState("");
  const [openDoc, setOpenDoc] = useState<OpenQuestionsDoc>({ items: [], continueWithOpen: false });
  const [openDraft, setOpenDraft] = useState("");
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [roleText, setRoleText] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingBasics, setEditingBasics] = useState(false);
  const [platformDraft, setPlatformDraft] = useState("other");
  const [genreDraft, setGenreDraft] = useState("");
  const [targetDraft, setTargetDraft] = useState("");
  const [wordsDraft, setWordsDraft] = useState("");
  const [toneDraft, setToneDraft] = useState("");
  const [editingCard, setEditingCard] = useState(false);
  const [cardDraft, setCardDraft] = useState<StoryCardDraft>(EMPTY_STORY_CARD);
  const confirmed = Boolean(stageData?.workflow?.groundConfirmedAt);
  const card = cardData?.card ?? EMPTY_STORY_CARD;
  const storyCardSettled = Boolean(cardData && (cardData.askDone || cardData.source !== "none"));

  useEffect(() => {
    const next = frameData?.content ?? "";
    setFrameText(next);
    setThemeDraft(extractStoryFrameZone(next, "theme").body);
    setWorldDraft(extractStoryFrameZone(next, "world").body);
    setConflictDraft(extractStoryFrameZone(next, "conflict").body);
    setEndingDraft(extractStoryFrameZone(next, "ending").body);
  }, [frameData?.content]);
  useEffect(() => {
    setHooksText(hooksData?.content ?? "");
  }, [hooksData?.content]);
  useEffect(() => {
    setIntentDraft(intentData?.content ?? "");
  }, [intentData?.content]);
  useEffect(() => {
    setOpenDoc(parseOpenQuestions(openData?.content ?? ""));
  }, [openData?.content]);
  useEffect(() => {
    if (!selectedRole && allRoleFiles[0]) setSelectedRole(allRoleFiles[0].name);
  }, [allRoleFiles, selectedRole]);
  useEffect(() => {
    if (!editingCard && cardData?.card) setCardDraft(cardData.card);
  }, [cardData?.card, editingCard]);

  const { data: roleFile } = useApi<{ content?: string | null }>(
    selectedRole ? `/books/${bookId}/truth/${selectedRole}` : "",
  );
  useEffect(() => {
    setRoleText(roleFile?.content ?? "");
  }, [roleFile?.content, selectedRole]);

  const zoneReady: Record<GroundSectionId, boolean> = {
    basics: Boolean((book?.targetChapters ?? 0) > 0 && (book?.chapterWordCount ?? 0) > 0 && book?.genre?.trim()),
    summary: storyCardReady(card),
    world: worldDraft.trim().length > 0,
    characters: roleFiles.length >= 1,
    conflict: conflictDraft.trim().length > 0,
    ending: endingDraft.trim().length > 0,
    open: openDoc.items.length === 0 || openDoc.continueWithOpen,
  };

  const warnIfConfirmed = () => {
    if (confirmed) showToast(isZh ? GROUND_REEDIT_WARNING.zh : GROUND_REEDIT_WARNING.en, "info");
  };

  const saveTruth = async (file: string, content: string) => {
    setSaving(true);
    try {
      await fetchJson(`/books/${bookId}/truth/${file}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      warnIfConfirmed();
      await Promise.all([refetchFrame(), refetchHooks(), refetchOpen(), refetchFiles(), refetchIntent()]);
      refreshStage();
      showToast(isZh ? "已保存" : "Saved", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("common.error"), "error");
    } finally {
      setSaving(false);
    }
  };

  const saveZone = async (zone: GroundFrameZone, body: string) => {
    const next = replaceStoryFrameZone(frameText, zone, body, isZh);
    setFrameText(next);
    await saveTruth("outline/story_frame.md", next);
  };

  const saveEnding = async () => {
    const next = replaceStoryFrameZone(frameText, "ending", endingDraft, isZh);
    setFrameText(next);
    setSaving(true);
    try {
      await fetchJson(`/books/${bookId}/truth/outline/story_frame.md`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: next }),
      });
      await fetchJson(`/books/${bookId}/truth/pending_hooks.md`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: hooksText }),
      });
      warnIfConfirmed();
      await Promise.all([refetchFrame(), refetchHooks(), refetchOpen(), refetchFiles(), refetchIntent()]);
      refreshStage();
      showToast(isZh ? "已保存" : "Saved", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("common.error"), "error");
    } finally {
      setSaving(false);
    }
  };

  const startBasicsEdit = () => {
    setPlatformDraft(
      book?.platform && (GROUND_PLATFORM_VALUES as readonly string[]).includes(book.platform)
        ? book.platform
        : "other",
    );
    setGenreDraft(book?.genre ?? card.genre ?? "");
    setTargetDraft(book?.targetChapters ? String(book.targetChapters) : "");
    setWordsDraft(book?.chapterWordCount ? String(book.chapterWordCount) : "");
    setToneDraft(card.tone ?? "");
    setEditingBasics(true);
  };

  const saveBasics = async () => {
    setSaving(true);
    try {
      await Promise.all([
        putApi(`/books/${bookId}`, {
          platform: platformDraft,
          genre: genreDraft,
          targetChapters: Number(targetDraft) || undefined,
          chapterWordCount: Number(wordsDraft) || undefined,
        }),
        putApi(`/books/${bookId}/story-card`, { genre: genreDraft, tone: toneDraft }),
      ]);
      setEditingBasics(false);
      bumpBookDataVersion();
      await Promise.all([refetchBook(), refetchCard()]);
      showToast(isZh ? "已保存" : "Saved", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("common.error"), "error");
    } finally {
      setSaving(false);
    }
  };

  const saveStoryCard = async () => {
    setSaving(true);
    try {
      await putApi(`/books/${bookId}/story-card`, {
        workingTitle: cardDraft.workingTitle,
        oneLine: cardDraft.oneLine,
        synopsis: cardDraft.synopsis,
      });
      setEditingCard(false);
      bumpBookDataVersion();
      await Promise.all([refetchCard(), refetchBook()]);
      showToast(isZh ? "已保存" : "Saved", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("common.error"), "error");
    } finally {
      setSaving(false);
    }
  };

  const reopenAsk = () => {
    createDraftSession(bookId, "book");
    setInput(isZh ? REOPEN_ASK_PROMPT.zh : REOPEN_ASK_PROMPT.en);
    nav.toAsk(bookId);
  };

  const proposals = proposalsData?.proposals ?? [];
  const basicsBits = [
    book?.platform ? platformLabel(book.platform, isZh) : "",
    book?.targetChapters && book.targetChapters > 0
      ? (isZh ? `${book.targetChapters} 章` : `${book.targetChapters} ch`)
      : "",
    book?.chapterWordCount && book.chapterWordCount > 0
      ? (isZh ? `每章 ${book.chapterWordCount} 字` : `${book.chapterWordCount} words/ch`)
      : "",
    book?.genre?.trim() ?? "",
  ].filter(Boolean);

  return (
    <div className="space-y-6 fade-in" data-testid="book-ground-page">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="eyebrow text-[13px] font-medium text-muted-foreground">{isZh ? `《${title}》` : title}</p>
          <h1 className="font-serif text-[32px] font-medium leading-10">{isZh ? "研墨" : "Ground"}</h1>
          <p className="text-[15px] leading-7 text-muted-foreground">
            {isZh ? "按本书需要生成并采用设定，再去织卷。" : "Generate and adopt the settings this book needs, then weave."}
          </p>
        </div>
        {confirmed && (
          <p className="shrink-0 pt-8 text-[13px] leading-5 text-muted-foreground" data-testid="ground-confirmed-stamp">
            {isZh ? "已定稿" : "Confirmed"} · {formatConfirmedDate(stageData?.workflow?.groundConfirmedAt, isZh)}
          </p>
        )}
      </header>

      <AuthoringGroundPanel bookId={bookId} isZh={isZh} />

      <nav
        className="sticky top-0 z-10 flex flex-wrap gap-2 bg-background/85 py-2 backdrop-blur"
        data-testid="ground-toc"
      >
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            data-testid={`ground-toc-${item.id}`}
            onClick={() => scrollToSection(item.id)}
            className="inline-flex items-center gap-2 rounded-full bg-secondary px-3 py-1 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <StageDot state={zoneReady[item.id] ? "done" : "blocked"} />
            {isZh ? item.zh : item.en}
          </button>
        ))}
      </nav>

      {proposals.length > 0 && (
        <div className="space-y-3" data-testid="ground-proposals">
          <div className="literary-kicker">{isZh ? "正典变更待确认" : "Canon changes"}</div>
          {proposals.map((proposal) => (
            <TruthProposalCard
              key={proposal.id}
              bookId={bookId}
              proposal={proposal}
              isZh={isZh}
              onResolved={() => {
                void refetchProposals();
                void refetchFiles();
                void refetchFrame();
                void refetchCard();
                void refetchIntent();
              }}
            />
          ))}
        </div>
      )}

      <div className="space-y-10">
        <section id="ground-basics" className="space-y-4" data-testid="ground-section-basics">
          <SectionHead index={1} label={isZh ? "基础设定" : "Basics"} ready={zoneReady.basics} />
          {editingBasics ? (
            <div className="space-y-3" data-testid="ground-basics-edit">
              <label className="block space-y-1.5">
                <span className="text-[13px] text-muted-foreground">{isZh ? "平台" : "Platform"}</span>
                <select
                  value={platformDraft}
                  onChange={(event) => setPlatformDraft(event.target.value)}
                  className="w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-sm"
                >
                  {GROUND_PLATFORM_VALUES.map((value) => (
                    <option key={value} value={value}>{platformLabel(value, isZh)}</option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1.5">
                <span className="text-[13px] text-muted-foreground">{isZh ? "题材" : "Genre"}</span>
                <input
                  value={genreDraft}
                  onChange={(event) => setGenreDraft(event.target.value)}
                  className="w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-sm"
                />
                <p className="text-[12px] text-muted-foreground">
                  {isZh ? "改题材会影响后续生成的题材规则" : "Changing genre affects later genre rules"}
                </p>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1.5">
                  <span className="text-[13px] text-muted-foreground">{isZh ? "目标章数" : "Target chapters"}</span>
                  <input
                    type="number"
                    min={1}
                    value={targetDraft}
                    onChange={(event) => setTargetDraft(event.target.value)}
                    className="w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-sm"
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-[13px] text-muted-foreground">{isZh ? "每章字数" : "Words per chapter"}</span>
                  <input
                    type="number"
                    min={1000}
                    value={wordsDraft}
                    onChange={(event) => setWordsDraft(event.target.value)}
                    className="w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <label className="block space-y-1.5">
                <span className="text-[13px] text-muted-foreground">{isZh ? "题材气质" : "Tone"}</span>
                <input
                  value={toneDraft}
                  onChange={(event) => setToneDraft(event.target.value)}
                  className="w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-sm"
                />
              </label>
              <div className="flex gap-2">
                <button type="button" disabled={saving} onClick={() => void saveBasics()} className="btn-secondary">
                  {isZh ? "保存" : "Save"}
                </button>
                <button type="button" onClick={() => setEditingBasics(false)} className="btn-ghost">
                  {isZh ? "取消" : "Cancel"}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-[15px] leading-7" data-testid="ground-basics-summary">
                {basicsBits.join(" · ") || "—"}
              </p>
              <p className="text-[13px] text-muted-foreground">
                {isZh ? "题材气质" : "Tone"}：{card.tone?.trim() || "—"}
              </p>
              <button type="button" onClick={startBasicsEdit} className="btn-secondary">
                {isZh ? "编辑" : "Edit"}
              </button>
            </div>
          )}
        </section>

        <section id="ground-summary" className="space-y-4" data-testid="ground-section-summary">
          <SectionHead index={2} label={isZh ? "故事概要" : "Summary"} ready={zoneReady.summary} />
          {storyCardSettled || editingCard ? (
            <div className="space-y-3" data-testid="ground-story-card">
              <AskStoryCard
                card={editingCard ? cardDraft : { ...card, workingTitle: card.workingTitle || title }}
                editable={editingCard}
                hideConfirm
                isZh={isZh}
                derivedFromCanon={!editingCard && cardData?.source === "derived"}
                onChange={(patch) => setCardDraft((prev) => mergeStoryCard(prev, patch))}
              />
              {editingCard ? (
                <div className="flex gap-2">
                  <button type="button" data-testid="ground-story-card-edit" disabled={saving} onClick={() => void saveStoryCard()} className="btn-secondary">
                    {isZh ? "保存" : "Save"}
                  </button>
                  <button type="button" onClick={() => { setEditingCard(false); setCardDraft(card); }} className="btn-ghost">
                    {isZh ? "取消" : "Cancel"}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  data-testid="ground-story-card-edit"
                  onClick={() => { setCardDraft(card); setEditingCard(true); }}
                  className="btn-secondary"
                >
                  {isZh ? "编辑" : "Edit"}
                </button>
              )}
            </div>
          ) : (
            <div data-testid="ground-story-empty">
              <LiteraryEmpty
                title={isZh ? "故事卡还没落下" : "No story card yet"}
                subtitle={isZh ? "从问心里重新推敲前提，把书名、一句话和梗概磨清。" : "Revisit the premise and settle the title, one-liner, and synopsis."}
                action={isZh ? "去问心推敲前提" : "Go to Ask"}
                onAction={reopenAsk}
              />
              <button
                type="button"
                onClick={() => {
                  setCardDraft({ ...EMPTY_STORY_CARD, workingTitle: title });
                  setEditingCard(true);
                }}
                className="btn-secondary"
              >
                {isZh ? "直接填写" : "Fill in directly"}
              </button>
            </div>
          )}
          <div className="space-y-2">
            <h3 className="font-serif text-[18px] font-medium leading-[26px]">{isZh ? "主题与基调" : "Theme and tone"}</h3>
            <textarea
              data-testid="ground-editor-theme"
              value={themeDraft}
              onChange={(event) => setThemeDraft(event.target.value)}
              rows={8}
              className={EDITOR_CLASS}
            />
            <button type="button" disabled={saving} onClick={() => void saveZone("theme", themeDraft)} className="btn-secondary">
              {isZh ? "保存" : "Save"}
            </button>
          </div>
          <details className="space-y-2">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {isZh ? "作者意图" : "Author intent"}
            </summary>
            <textarea
              data-testid="ground-editor-intent"
              value={intentDraft}
              onChange={(event) => setIntentDraft(event.target.value)}
              rows={8}
              className={EDITOR_CLASS}
            />
            <button type="button" disabled={saving} onClick={() => void saveTruth("author_intent.md", intentDraft)} className="btn-secondary">
              {isZh ? "保存" : "Save"}
            </button>
          </details>
        </section>

        <section id="ground-world" className="space-y-4" data-testid="ground-section-world">
          <SectionHead index={3} label={isZh ? "世界规则" : "World"} ready={zoneReady.world} />
          <textarea
            data-testid="ground-editor-world"
            value={worldDraft}
            onChange={(event) => setWorldDraft(event.target.value)}
            rows={12}
            placeholder={isZh ? "这个世界 3–5 条不可违反的铁律、质感与本书专属规则" : "3–5 inviolable rules, texture, and book-specific laws"}
            className={EDITOR_CLASS}
          />
          <button type="button" disabled={saving} onClick={() => void saveZone("world", worldDraft)} className="btn-secondary">
            {isZh ? "保存" : "Save"}
          </button>
        </section>

        <section id="ground-characters" className="space-y-4" data-testid="ground-section-characters">
          <SectionHead index={4} label={isZh ? "人物设定" : "People"} ready={zoneReady.characters} />
          <div className="flex flex-wrap gap-2">
            {allRoleFiles.length === 0 ? (
              <LiteraryEmpty
                title={isZh ? "还没有人物" : "No characters yet"}
                subtitle={isZh ? "用上方设定目录生成人物条目，或在这里手写主角。" : "Generate people from the catalog above, or write the protagonist here."}
                testId="ground-characters-empty"
              />
            ) : allRoleFiles.map((file) => (
              <button
                key={file.name}
                type="button"
                onClick={() => setSelectedRole(file.name)}
                className={`rounded-full px-3 py-1 text-[13px] ${selectedRole === file.name ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}
              >
                {file.name.replace(/^roles\/(主要角色|次要角色|major|minor)\//, "").replace(/\.md$/, "")}
              </button>
            ))}
          </div>
          {selectedRole && (
            <>
              <textarea
                data-testid="ground-role-editor"
                value={roleText}
                onChange={(event) => setRoleText(event.target.value)}
                rows={16}
                className={EDITOR_CLASS}
              />
              <button type="button" disabled={saving} onClick={() => void saveTruth(selectedRole, roleText)} className="btn-secondary">
                {isZh ? "保存" : "Save"}
              </button>
            </>
          )}
        </section>

        <section id="ground-conflict" className="space-y-4" data-testid="ground-section-conflict">
          <SectionHead index={5} label={isZh ? "关系与主线" : "Conflict"} ready={zoneReady.conflict} />
          <textarea
            data-testid="ground-editor-conflict"
            value={conflictDraft}
            onChange={(event) => setConflictDraft(event.target.value)}
            rows={12}
            placeholder={isZh ? "前台故事 / 后台故事各是什么，两条线怎么咬合" : "What are the front and back stories, and how do they lock?"}
            className={EDITOR_CLASS}
          />
          <button type="button" disabled={saving} onClick={() => void saveZone("conflict", conflictDraft)} className="btn-secondary">
            {isZh ? "保存" : "Save"}
          </button>
        </section>

        <section id="ground-ending" className="space-y-6" data-testid="ground-section-ending">
          <SectionHead index={6} label={isZh ? "结局与伏笔" : "Ending"} ready={zoneReady.ending} />
          <div className="space-y-2">
            <h3 className="font-serif text-[18px] font-medium leading-[26px]">{isZh ? "终局" : "Ending"}</h3>
            <textarea
              data-testid="ground-editor-ending"
              value={endingDraft}
              onChange={(event) => setEndingDraft(event.target.value)}
              rows={10}
              placeholder={isZh ? "最后一个镜头长什么样 + 全书 Objective 一句话" : "The last shot, plus the book Objective in one line"}
              className={EDITOR_CLASS}
            />
          </div>
          <div className="space-y-2">
            <h3 className="font-serif text-[18px] font-medium leading-[26px]">{isZh ? "伏笔清单" : "Hook list"}</h3>
            <textarea
              data-testid="ground-editor-hooks"
              value={hooksText}
              onChange={(event) => setHooksText(event.target.value)}
              rows={10}
              placeholder={isZh ? "一行一条，可写目标章" : "One hook per line; target chapter optional"}
              className={EDITOR_CLASS}
            />
          </div>
          <button type="button" disabled={saving} onClick={() => void saveEnding()} className="btn-secondary">
            {isZh ? "保存" : "Save"}
          </button>
        </section>

        <section id="ground-open" className="space-y-4" data-testid="ground-section-open">
          <SectionHead index={7} label={isZh ? "其他待定项" : "Open"} ready={zoneReady.open} />
          <div className="space-y-4" data-testid="ground-open-questions">
            {openDoc.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{isZh ? "暂无待定项" : "No open questions"}</p>
            ) : (
              <ul className="space-y-2">
                {openDoc.items.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 text-[15px]">
                    <input
                      type="checkbox"
                      onChange={() => {
                        const next = removeOpenQuestion(openDoc, item.id);
                        setOpenDoc(next);
                        void saveTruth("open_questions.md", serializeOpenQuestions(next));
                      }}
                    />
                    <span>{item.text}</span>
                  </li>
                ))}
              </ul>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const next = addOpenQuestion(openDoc, openDraft);
                setOpenDoc(next);
                setOpenDraft("");
                void saveTruth("open_questions.md", serializeOpenQuestions(next));
              }}
              className="flex gap-2"
            >
              <input
                data-testid="open-question-input"
                value={openDraft}
                onChange={(event) => setOpenDraft(event.target.value)}
                placeholder={isZh ? "回车添加待定项" : "Enter to add"}
                className="flex-1 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
              />
              <button type="submit" className="rounded-xl bg-secondary px-3 py-2 text-sm">{isZh ? "添加" : "Add"}</button>
            </form>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                data-testid="continue-with-open"
                checked={openDoc.continueWithOpen}
                onChange={(event) => {
                  const next = { ...openDoc, continueWithOpen: event.target.checked };
                  setOpenDoc(next);
                  void saveTruth("open_questions.md", serializeOpenQuestions(next));
                }}
              />
              {isZh ? CONTINUE_WITH_OPEN_MARK : "Continue with open questions"}
            </label>
          </div>
        </section>
      </div>

    </div>
  );
}

function SectionHead({
  index,
  label,
  ready,
}: {
  readonly index: number;
  readonly label: string;
  readonly ready: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="font-serif text-[18px] font-medium leading-[26px]">
        {index} {label}
      </h3>
      <StageDot state={ready ? "done" : "blocked"} />
    </div>
  );
}
