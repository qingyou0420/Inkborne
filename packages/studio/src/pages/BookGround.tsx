/**
 * 研墨: candidate settings and adopted material in one directory.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useMemo, useRef, useState } from "react";
import "./ground-workspace.css";
import "../components/write-workspace.css";
import { AskStoryCard } from "../components/AskStoryCard";
import { AuthoringGroundPanel } from "../components/AuthoringGroundPanel";
import type { BookWorkspaceNavTarget } from "../components/BookWorkspaceNav";
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
  storyCardReady,
  type StoryCardDraft,
  type StoryCardResolved,
} from "../lib/story-card";
import { extractStoryFrameZone, type GroundFrameZone } from "../lib/story-frame-sections";
import { createGroundMaterialDrafts, saveGroundFrameZone, type GroundBasicsDraft } from "../lib/ground-drafts";
import { showToast } from "../lib/toast";
import { useChatStore } from "../store/chat";
import { ManuscriptView } from "../components/ManuscriptView";
import { useDraftDecision } from "../hooks/use-draft-decision";
import { registerNavigationGuard } from "../lib/edit-navigation";

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
  "w-full rounded-lg border border-border-strong bg-card px-3 py-2 font-serif text-[15px] leading-[26px] outline-none focus:ring-1 focus:ring-ring";

interface BookGroundProps {
  readonly bookId: string;
  readonly nav: Nav;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly isZh: boolean;
}

export function BookGround(props: BookGroundProps) {
  return <BookGroundWorkspace key={props.bookId} {...props} />;
}

function BookGroundWorkspace({
  bookId,
  nav,
  t,
  isZh,
}: BookGroundProps) {
  const { data: bookData, refetch: refetchBook } = useApi<{ book?: GroundBook }>(`/books/${bookId}`);
  const { data: filesData, refetch: refetchFiles } = useApi<{ files?: ReadonlyArray<TruthFile> }>(`/books/${bookId}/truth`);
  const { data: frameData, refetch: refetchFrame } = useApi<{ content?: string | null }>(`/books/${bookId}/truth/outline/story_frame.md`);
  const { data: hooksData, refetch: refetchHooks } = useApi<{ content?: string | null }>(`/books/${bookId}/truth/pending_hooks.md`);
  const { data: openData, refetch: refetchOpen } = useApi<{ content?: string | null }>(`/books/${bookId}/truth/open_questions.md`);
  const { data: cardData, refetch: refetchCard } = useApi<StoryCardResolved>(`/books/${bookId}/story-card`);
  const { data: intentData, refetch: refetchIntent } = useApi<{ content?: string | null }>(`/books/${bookId}/truth/author_intent.md`);
  const stageData = useBookStage(bookId);
  const bumpBookDataVersion = useChatStore((state) => state.bumpBookDataVersion);
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
  const materialDrafts = useMemo(() => createGroundMaterialDrafts(bookId), [bookId]);
  const restoredKeys = useRef(materialDrafts.keys());
  const restoredBasics = useRef(materialDrafts.get<GroundBasicsDraft>("$basics"));
  const restoredCard = useRef(materialDrafts.get<StoryCardDraft>("$story-card"));
  const [legacySectionId, setLegacySectionId] = useState<GroundSectionId | null>(() => {
    const key = restoredKeys.current.at(-1);
    if (!key) return null;
    if (key.startsWith("roles/")) return "characters";
    if (key === "$basics") return "basics";
    if (["$story-card", "theme", "author_intent.md"].includes(key)) return "summary";
    if (["ending", "pending_hooks.md"].includes(key)) return "ending";
    if (["open_questions.md", "$open-input"].includes(key)) return "open";
    return key === "world" || key === "conflict" ? key : null;
  });
  const roleDrafts = useRef<Record<string, string>>(Object.fromEntries(restoredKeys.current.filter((key) => key.startsWith("roles/")).map((key) => [key, materialDrafts.get(key) ?? ""])));
  const dirtyMaterials = useRef(new Set(restoredKeys.current));
  const [themeDraft, setThemeDraft] = useState(() => materialDrafts.get("theme") ?? "");
  const [worldDraft, setWorldDraft] = useState(() => materialDrafts.get("world") ?? "");
  const [conflictDraft, setConflictDraft] = useState(() => materialDrafts.get("conflict") ?? "");
  const [endingDraft, setEndingDraft] = useState(() => materialDrafts.get("ending") ?? "");
  const [hooksText, setHooksText] = useState(() => materialDrafts.get("pending_hooks.md") ?? "");
  const [intentDraft, setIntentDraft] = useState(() => materialDrafts.get("author_intent.md") ?? "");
  const [openDoc, setOpenDoc] = useState<OpenQuestionsDoc>(() => parseOpenQuestions(materialDrafts.get("open_questions.md") ?? ""));
  const [openDraft, setOpenDraft] = useState(() => materialDrafts.get("$open-input") ?? "");
  const [selectedRole, setSelectedRole] = useState<string | null>(() => restoredKeys.current.find((key) => key.startsWith("roles/")) ?? null);
  const [roleText, setRoleText] = useState("");
  const [saving, setSaving] = useState(false);
  const [legacyEditing, setLegacyEditing] = useState(false);
  const decision = useDraftDecision(isZh);
  const saveInFlight = useRef(false);
  const [platformDraft, setPlatformDraft] = useState(restoredBasics.current?.platform ?? "other");
  const [genreDraft, setGenreDraft] = useState(restoredBasics.current?.genre ?? "");
  const [targetDraft, setTargetDraft] = useState(restoredBasics.current?.target ?? "");
  const [wordsDraft, setWordsDraft] = useState(restoredBasics.current?.words ?? "");
  const [toneDraft, setToneDraft] = useState(restoredBasics.current?.tone ?? "");
  const [editingCard, setEditingCard] = useState(Boolean(restoredCard.current));
  const [cardDraft, setCardDraft] = useState<StoryCardDraft>(restoredCard.current ?? EMPTY_STORY_CARD);
  const confirmed = Boolean(stageData?.workflow?.groundConfirmedAt);
  const card = cardData?.card ?? EMPTY_STORY_CARD;

  useEffect(() => {
    const next = frameData?.content ?? "";
    if (!dirtyMaterials.current.has("theme")) setThemeDraft(extractStoryFrameZone(next, "theme").body);
    if (!dirtyMaterials.current.has("world")) setWorldDraft(extractStoryFrameZone(next, "world").body);
    if (!dirtyMaterials.current.has("conflict")) setConflictDraft(extractStoryFrameZone(next, "conflict").body);
    if (!dirtyMaterials.current.has("ending")) setEndingDraft(extractStoryFrameZone(next, "ending").body);
  }, [frameData?.content]);
  useEffect(() => {
    if (!dirtyMaterials.current.has("pending_hooks.md")) setHooksText(hooksData?.content ?? "");
  }, [hooksData?.content]);
  useEffect(() => {
    if (!dirtyMaterials.current.has("author_intent.md")) setIntentDraft(intentData?.content ?? "");
  }, [intentData?.content]);
  useEffect(() => {
    if (!dirtyMaterials.current.has("open_questions.md")) setOpenDoc(parseOpenQuestions(openData?.content ?? ""));
  }, [openData?.content]);
  useEffect(() => {
    if (!selectedRole && allRoleFiles[0]) setSelectedRole(allRoleFiles[0].name);
  }, [allRoleFiles, selectedRole]);
  useEffect(() => {
    if (!editingCard && cardData?.card) setCardDraft(cardData.card);
  }, [cardData?.card, editingCard]);

  const [roleLoading, setRoleLoading] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [roleRetry, setRoleRetry] = useState(0);
  useEffect(() => {
    if (!selectedRole) return;
    if (Object.hasOwn(roleDrafts.current, selectedRole) && dirtyMaterials.current.has(selectedRole)) {
      setRoleText(roleDrafts.current[selectedRole]);
      setRoleError(null);
      setRoleLoading(false);
      return;
    }
    let cancelled = false;
    setRoleLoading(true);
    setRoleError(null);
    setRoleText("");
    void fetchJson<{ content?: string | null }>(`/books/${bookId}/truth/${selectedRole}`).then((file) => {
      if (!cancelled) {
        const body = file.content ?? "";
        roleDrafts.current[selectedRole] = body;
        setRoleText(body);
      }
    }).catch((error: unknown) => {
      if (!cancelled) setRoleError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (!cancelled) setRoleLoading(false); });
    return () => { cancelled = true; };
  }, [bookId, selectedRole, roleRetry]);

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

  const rememberMaterial = (key: string, value: unknown) => {
    dirtyMaterials.current.add(key);
    materialDrafts.change(key, value);
  };
  const clearSavedMaterial = (key: string, submitted: ReturnType<typeof materialDrafts.capture>) => {
    if (materialDrafts.saved(key, submitted)) dirtyMaterials.current.delete(key);
  };
  const discardMaterial = (key: string) => {
    materialDrafts.discard(key);
    dirtyMaterials.current.delete(key);
  };
  const writeTruth = (file: string, content: string) => fetchJson(`/books/${bookId}/truth/${file}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const readLatestFrame = async () => (await fetchJson<{ content?: string | null }>(`/books/${bookId}/truth/outline/story_frame.md`)).content ?? "";

  const saveMaterials = async (write: () => Promise<void>) => {
    if (saveInFlight.current) return false;
    saveInFlight.current = true;
    setSaving(true);
    try {
      await write();
      warnIfConfirmed();
      await Promise.all([refetchFrame(), refetchHooks(), refetchOpen(), refetchFiles(), refetchIntent()]);
      refreshStage();
      showToast(isZh ? "已采用设定已保存" : "Adopted settings saved", "success");
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("common.error"), "error");
      return false;
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  const changeBasics = (patch: Partial<GroundBasicsDraft>) => {
    const next = { platform: platformDraft, genre: genreDraft, target: targetDraft, words: wordsDraft, tone: toneDraft, ...patch };
    rememberMaterial("$basics", next);
    setPlatformDraft(next.platform); setGenreDraft(next.genre); setTargetDraft(next.target); setWordsDraft(next.words); setToneDraft(next.tone);
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
  };

  const saveBasics = async () => {
    if (saveInFlight.current) return false;
    saveInFlight.current = true;
    const submitted = materialDrafts.capture("$basics");
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
      clearSavedMaterial("$basics", submitted);
      bumpBookDataVersion();
      await Promise.all([refetchBook(), refetchCard()]);
      showToast(isZh ? "已保存" : "Saved", "success");
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : t("common.error"), "error");
      return false;
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  const proposals = proposalsData?.proposals ?? [];
  const materialKeys = (): string[] => {
    switch (legacySectionId) {
      case "basics": return ["$basics"];
      case "summary": return ["$story-card", "theme", "author_intent.md"];
      case "characters": return selectedRole ? [selectedRole] : [];
      case "ending": return ["ending", "pending_hooks.md"];
      case "open": return ["open_questions.md", "$open-input"];
      case "world": case "conflict": return [legacySectionId];
      default: return [];
    }
  };
  const discardLegacy = () => {
    for (const key of materialKeys()) {
      discardMaterial(key);
      if (key === "theme") setThemeDraft(extractStoryFrameZone(frameData?.content ?? "", "theme").body);
      else if (key === "world") setWorldDraft(extractStoryFrameZone(frameData?.content ?? "", "world").body);
      else if (key === "conflict") setConflictDraft(extractStoryFrameZone(frameData?.content ?? "", "conflict").body);
      else if (key === "ending") setEndingDraft(extractStoryFrameZone(frameData?.content ?? "", "ending").body);
      else if (key === "pending_hooks.md") setHooksText(hooksData?.content ?? "");
      else if (key === "author_intent.md") setIntentDraft(intentData?.content ?? "");
      else if (key === "open_questions.md") setOpenDoc(parseOpenQuestions(openData?.content ?? ""));
      else if (key === "$open-input") setOpenDraft("");
      else if (key === "$story-card") setCardDraft(card);
      else if (key.startsWith("roles/")) { delete roleDrafts.current[key]; setRoleRetry((value) => value + 1); }
    }
    setEditingCard(false); setLegacyEditing(false);
  };
  const saveLegacy = async (): Promise<boolean> => {
    if (legacySectionId === "basics") { const saved = await saveBasics(); if (saved) setLegacyEditing(false); return saved; }
    if (legacySectionId === "open" && openDraft.trim()) {
      const next = addOpenQuestion(openDoc, openDraft);
      rememberMaterial("open_questions.md", serializeOpenQuestions(next)); setOpenDoc(next); discardMaterial("$open-input"); setOpenDraft("");
    }
    const keys = materialKeys().filter((key) => materialDrafts.has(key));
    const submissions = keys.map((key) => [key, materialDrafts.capture(key)] as const);
    const saved = await saveMaterials(async () => {
      for (const [key, submitted] of submissions) {
        if (key === "$story-card") await putApi(`/books/${bookId}/story-card`, { workingTitle: cardDraft.workingTitle, oneLine: cardDraft.oneLine, synopsis: cardDraft.synopsis });
        else if (["theme", "world", "conflict", "ending"].includes(key)) await saveGroundFrameZone(key as GroundFrameZone, materialDrafts.get(key) ?? "", isZh, readLatestFrame, async (next) => { await writeTruth("outline/story_frame.md", next); });
        else if (!key.startsWith("$")) await writeTruth(key, materialDrafts.get(key) ?? "");
        clearSavedMaterial(key, submitted);
      }
      await Promise.all([refetchBook(), refetchCard()]);
    });
    if (saved) { setLegacyEditing(false); setEditingCard(false); }
    return saved;
  };
  const finishLegacy = async (): Promise<boolean> => {
    if (saveInFlight.current) return false;
    if (!materialKeys().some((key) => materialDrafts.has(key))) { setLegacyEditing(false); setEditingCard(false); return true; }
    const answer = await decision.ask();
    if (answer === "cancel") { setLegacyEditing(true); return false; }
    if (answer === "discard") { discardLegacy(); return true; }
    return saveLegacy();
  };
  const startLegacyEdit = () => {
    if (legacySectionId === "basics") {
      if (!materialDrafts.has("$basics")) startBasicsEdit();
    }
    if (legacySectionId === "summary") setEditingCard(true);
    setLegacyEditing(true);
  };
  const legacyLeaveRef = useRef(finishLegacy);
  legacyLeaveRef.current = finishLegacy;
  const activeMaterialDirty = materialKeys().some((key) => materialDrafts.has(key));
  useEffect(() => {
    if (!legacySectionId || !activeMaterialDirty) return;
    return registerNavigationGuard(() => legacyLeaveRef.current());
  }, [legacySectionId, activeMaterialDirty]);
  const legacySaveRef = useRef(saveLegacy);
  legacySaveRef.current = saveLegacy;
  useEffect(() => {
    if (!legacyEditing) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !document.querySelector('[role="dialog"]')) { event.preventDefault(); void legacySaveRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [legacyEditing]);
  const materialInput = (key: string, value: string, change: (value: string) => void, label: string, rows = 10) => legacyEditing
    ? <textarea data-testid={key.startsWith("roles/") ? "ground-role-editor" : key === "pending_hooks.md" ? "ground-editor-hooks" : key === "author_intent.md" ? "ground-editor-intent" : `ground-editor-${key}`} value={value} onChange={(event) => { rememberMaterial(key, event.target.value); change(event.target.value); }} aria-label={label} rows={rows} className={EDITOR_CLASS} />
    : <ManuscriptView body={value || (isZh ? "尚未填写。" : "Not filled in yet.")} />;
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
        <h1 className="sr-only">{isZh ? "研墨" : "Ground"}</h1>
        {confirmed && (
          <p className="shrink-0 text-[13px] leading-5 text-muted-foreground" data-testid="ground-confirmed-stamp">
            {isZh ? "已定稿" : "Confirmed"} · {formatConfirmedDate(stageData?.workflow?.groundConfirmedAt, isZh)}
          </p>
        )}
      </header>

      <AuthoringGroundPanel
        bookId={bookId}
        isZh={isZh}
        legacySections={SECTIONS.map((section) => ({ id: section.id, label: isZh ? section.zh : section.en, ready: zoneReady[section.id] }))}
        legacySectionId={legacySectionId}
        onLegacySectionChange={(id) => setLegacySectionId(id as GroundSectionId | null)}
        legacyBusy={saving}
        onBeforeLegacyLeave={finishLegacy}
        legacyContent={<div className="ground-legacy-document space-y-6" data-testid="ground-legacy-files">
          <div className="version-state"><span>{isZh ? "已采用设定（旧书）" : "Adopted settings (legacy)"}</span>{materialKeys().some((key) => materialDrafts.has(key)) ? <span>{isZh ? "未保存修改" : "Unsaved changes"}</span> : null}</div>
          {proposals.length > 0 ? <details className="space-y-3" data-testid="ground-proposals"><summary>{isZh ? "正典变更待确认" : "Canon changes"}</summary>{proposals.map((proposal) => <TruthProposalCard key={proposal.id} bookId={bookId} proposal={proposal} isZh={isZh} onResolved={() => { void refetchProposals(); void refetchFiles(); void refetchFrame(); void refetchCard(); void refetchIntent(); }} />)}</details> : null}
          <h2 className="font-serif text-2xl">{SECTIONS.find((item) => item.id === legacySectionId)?.[isZh ? "zh" : "en"]}</h2>
          <fieldset disabled={saving} className="min-w-0 space-y-5">
          {legacySectionId === "basics" ? legacyEditing ? <div className="space-y-4" data-testid="ground-basics-edit">
            <label className="block text-sm">{isZh ? "平台" : "Platform"}<select value={platformDraft} onChange={(event) => changeBasics({ platform: event.target.value })} className={EDITOR_CLASS}>{GROUND_PLATFORM_VALUES.map((value) => <option key={value} value={value}>{platformLabel(value, isZh)}</option>)}</select></label>
            <label className="block text-sm">{isZh ? "题材" : "Genre"}<input value={genreDraft} onChange={(event) => changeBasics({ genre: event.target.value })} className={EDITOR_CLASS} /></label>
            <div className="grid grid-cols-2 gap-4"><label className="block text-sm">{isZh ? "目标章数" : "Target chapters"}<input type="number" min={1} value={targetDraft} onChange={(event) => changeBasics({ target: event.target.value })} className={EDITOR_CLASS} /></label><label className="block text-sm">{isZh ? "每章字数" : "Words per chapter"}<input type="number" min={100} value={wordsDraft} onChange={(event) => changeBasics({ words: event.target.value })} className={EDITOR_CLASS} /></label></div>
            <label className="block text-sm">{isZh ? "题材气质" : "Tone"}<input value={toneDraft} onChange={(event) => changeBasics({ tone: event.target.value })} className={EDITOR_CLASS} /></label>
          </div> : <div className="prose-body space-y-4" data-testid="ground-basics-summary"><p>{basicsBits.join(" · ") || "—"}</p><p>{isZh ? "题材气质" : "Tone"}：{card.tone?.trim() || "—"}</p></div> : null}
          {legacySectionId === "summary" ? <div className="space-y-6" data-testid="ground-story-card">
            <AskStoryCard card={legacyEditing ? cardDraft : { ...card, workingTitle: card.workingTitle || title }} editable={legacyEditing} hideConfirm isZh={isZh} derivedFromCanon={!legacyEditing && cardData?.source === "derived"} onChange={(patch) => { const next = mergeStoryCard(cardDraft, patch); rememberMaterial("$story-card", next); setCardDraft(next); }} />
            <section className="space-y-3"><h3 className="font-serif text-xl">{isZh ? "主题与基调" : "Theme and tone"}</h3>{materialInput("theme", themeDraft, setThemeDraft, isZh ? "主题与基调（已采用设定）" : "Theme and tone (adopted)")}</section>
            <details className="space-y-3"><summary className="text-sm">{isZh ? "作者意图" : "Author intent"}</summary>{materialInput("author_intent.md", intentDraft, setIntentDraft, isZh ? "作者意图（已采用设定）" : "Author intent (adopted)")}</details>
          </div> : null}
          {legacySectionId === "world" ? materialInput("world", worldDraft, setWorldDraft, isZh ? "世界规则（已采用设定）" : "World rules (adopted)", 14) : null}
          {legacySectionId === "characters" ? <div className="space-y-4">
            <label className="block text-sm">{isZh ? "人物" : "Character"}<select aria-label={isZh ? "选择人物" : "Select character"} className="ml-3 border-b border-border bg-background p-2" value={selectedRole ?? ""} onChange={async (event) => { const value = event.target.value; if (await finishLegacy()) setSelectedRole(value); }}>{allRoleFiles.map((file) => <option key={file.name} value={file.name}>{file.name.replace(/^roles\/(主要角色|次要角色|major|minor)\//, "").replace(/\.md$/, "")}</option>)}</select></label>
            {roleLoading ? <p role="status">{isZh ? "正在读取人物资料…" : "Loading character…"}</p> : roleError ? <p role="alert" className="text-destructive">{roleError}<button type="button" className="btn-ghost" onClick={() => setRoleRetry((value) => value + 1)}>{isZh ? "重试" : "Retry"}</button></p> : selectedRole ? materialInput(selectedRole, roleText, (value) => { roleDrafts.current[selectedRole] = value; setRoleText(value); }, isZh ? "人物正文（已采用设定）" : "Character (adopted)", 16) : <p className="text-muted-foreground">{isZh ? "还没有已采用的人物设定。" : "No adopted character settings yet."}</p>}
          </div> : null}
          {legacySectionId === "conflict" ? materialInput("conflict", conflictDraft, setConflictDraft, isZh ? "关系与主线（已采用设定）" : "Relations and plot (adopted)", 14) : null}
          {legacySectionId === "ending" ? <div className="space-y-6"><section className="space-y-3"><h3 className="font-serif text-xl">{isZh ? "终局" : "Ending"}</h3>{materialInput("ending", endingDraft, setEndingDraft, isZh ? "终局（已采用设定）" : "Ending (adopted)")}</section><section className="space-y-3"><h3 className="font-serif text-xl">{isZh ? "伏笔清单" : "Hooks"}</h3>{materialInput("pending_hooks.md", hooksText, setHooksText, isZh ? "伏笔（已采用设定）" : "Hooks (adopted)")}</section></div> : null}
          {legacySectionId === "open" ? <div className="space-y-5" data-testid="ground-open-questions">
            <ul className="space-y-3">{openDoc.items.map((item) => <li key={item.id} className="flex items-center gap-3 prose-body">{legacyEditing ? <input type="checkbox" aria-label={isZh ? `移除待定项：${item.text}` : `Remove ${item.text}`} onChange={() => { const next = removeOpenQuestion(openDoc, item.id); rememberMaterial("open_questions.md", serializeOpenQuestions(next)); setOpenDoc(next); }} /> : null}<span>{item.text}</span></li>)}</ul>
            {!openDoc.items.length ? <p className="text-muted-foreground">{isZh ? "暂无待定项" : "No open questions"}</p> : null}
            {legacyEditing ? <form className="flex gap-3" onSubmit={(event) => { event.preventDefault(); if (!openDraft.trim()) return; const next = addOpenQuestion(openDoc, openDraft); rememberMaterial("open_questions.md", serializeOpenQuestions(next)); setOpenDoc(next); discardMaterial("$open-input"); setOpenDraft(""); }}><input data-testid="open-question-input" value={openDraft} onChange={(event) => { if (event.target.value) rememberMaterial("$open-input", event.target.value); else discardMaterial("$open-input"); setOpenDraft(event.target.value); }} aria-label={isZh ? "新增待定项" : "New question"} placeholder={isZh ? "补充一条待定项" : "Add a question"} className={EDITOR_CLASS} /><button type="submit" className="btn-secondary">{isZh ? "添加" : "Add"}</button></form> : null}
            {legacyEditing ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="continue-with-open" checked={openDoc.continueWithOpen} onChange={(event) => { const next = { ...openDoc, continueWithOpen: event.target.checked }; rememberMaterial("open_questions.md", serializeOpenQuestions(next)); setOpenDoc(next); }} />{isZh ? CONTINUE_WITH_OPEN_MARK : "Continue with open questions"}</label> : openDoc.continueWithOpen ? <p className="text-sm text-muted-foreground">{isZh ? CONTINUE_WITH_OPEN_MARK : "Continue with open questions"}</p> : null}
          </div> : null}
          </fieldset>
          <div className="manuscript-action-buttons ground-document-actions">{legacyEditing ? <><button type="button" disabled={saving} onClick={() => void saveLegacy()}>{isZh ? "保存已采用设定" : "Save adopted material"}</button><button type="button" className="quiet" disabled={saving} onClick={() => void finishLegacy()}>{isZh ? "取消" : "Cancel"}</button></> : <button type="button" disabled={saving || (legacySectionId === "characters" && (!selectedRole || roleLoading || Boolean(roleError)))} onClick={startLegacyEdit}>{isZh ? "编辑" : "Edit"}</button>}</div>
          {decision.dialog}
        </div>}
      />

    </div>
  );
}
