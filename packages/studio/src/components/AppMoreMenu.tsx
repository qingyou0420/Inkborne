/**
 * All global configuration and secondary tools share one entry.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { useApi } from "../hooks/use-api";
import type { SSEMessage } from "../hooks/use-sse";
import { shouldRefetchBookCollections } from "../hooks/use-book-activity";
import type { TFunction } from "../hooks/use-i18n";
import type { AuthoringWorkspace } from "../lib/authoring-workspace";
import { workspaceQuery } from "../lib/authoring-workspace";
import {
  setProjectChatSessionId,
} from "../pages/chat-page-state";
import { useChatStore } from "../store/chat";
import { usePreferencesStore } from "../store/preferences";
import { AskSessionDrawer } from "./AskSessionDrawer";
import { BookSettingsDrawer } from "./BookSettingsDrawer";
import { BookToolsDrawer } from "./BookToolsDrawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "./ui/dropdown-menu";

interface BookSummary {
  readonly id: string;
  readonly title: string;
}

export interface AppMoreNav {
  toServices: () => void;
  toProjectSettings: (section?: "advanced") => void;
  toDashboard: () => void;
  toTruth?: (id: string) => void;
  toAuthor: () => void;
  toChat: (onAccepted?: () => void) => void;
  toAsk: (id: string, sessionId?: string) => void;
  toBookCreate: (sessionId?: string) => void;
  toDaemon: () => void;
  toLogs: () => void;
  toGenres: () => void;
  toStyle: () => void;
  toTranslation: () => void;
  toImport: (tab?: "chapters" | "canon" | "fanfic" | "spinoff" | "imitation") => void;
  toRadar: () => void;
  toDoctor: () => void;
  toCheckUpdate: () => void;
  toAnalytics: (id: string) => void;
  toFilmStudio: (id: string) => void;
}

export function AppMoreMenu({
  nav,
  sse,
  t,
  isZh,
  currentBookId,
}: {
  readonly nav: AppMoreNav;
  readonly sse: { messages: ReadonlyArray<SSEMessage> };
  readonly t: TFunction;
  readonly isZh: boolean;
  readonly currentBookId?: string;
}) {
  const { data, loading: booksLoading, error: booksError, refetch: refetchBooks } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const books = data?.books ?? [];
  const createDraftSession = useChatStore((s) => s.createDraftSession);
  const setInput = useChatStore((s) => s.setInput);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);
  const preferredBookId = usePreferencesStore((s) => s.currentBookId);
  const { data: authoring } = useApi<AuthoringWorkspace>(
    currentBookId ? `/authoring/workspace?${workspaceQuery(currentBookId)}` : "",
  );
  const authoringBook = authoring?.authoringBook === true;
  const showWorkTools = Boolean(currentBookId) && authoring?.authoringBook === false;
  const currentBook = books.find((book) => book.id === currentBookId);
  const bumpBookDataVersion = useChatStore((s) => s.bumpBookDataVersion);
  const [open, setOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [bookPanel, setBookPanel] = useState<"settings" | "tools" | null>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;
    if (shouldRefetchBookCollections(recent)) refetchBooks();
  }, [refetchBooks, sse.messages]);

  useEffect(() => {
    void refetchBooks();
  }, [bookDataVersion, refetchBooks]);

  const launchProjectMode = (kind: "short" | "interactive-film") => {
    nav.toChat(() => {
      const sessionId = createDraftSession(null, kind);
      setProjectChatSessionId(sessionId);
      setInput("");
    });
  };

  const items = [
      { group: isZh ? "工具" : "Tools", entries: [
        { label: t("nav.translation"), onClick: nav.toTranslation, testId: "more-translation" },
        { label: t("nav.genreTemplates"), onClick: nav.toGenres, testId: "more-genres" },
        { label: t("nav.style"), onClick: nav.toStyle, testId: "more-style" },
        { label: t("nav.radar"), onClick: nav.toRadar, testId: "more-radar" },
      ] },
      { group: isZh ? "运行" : "Runtime", entries: [
        { label: t("nav.daemon"), onClick: nav.toDaemon, testId: "more-daemon" },
        { label: t("nav.logs"), onClick: nav.toLogs, testId: "more-logs" },
        { label: t("nav.doctor"), onClick: nav.toDoctor, testId: "more-doctor" },
        { label: t("nav.checkUpdate"), onClick: nav.toCheckUpdate, testId: "more-update" },
      ] },
      { group: isZh ? "其他创作" : "Other", entries: [
        { label: t("nav.shorts"), onClick: () => launchProjectMode("short"), testId: "more-short" },
        { label: t("nav.film"), onClick: () => launchProjectMode("interactive-film"), testId: "more-film" },
      ] },
    ];

  return (
    <>
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        ref={menuTrigger}
        data-testid="nav-settings"
        className="ink-config-trigger"
        aria-label={isZh ? "配置" : "Settings"}
      >
        <Settings2 size={18} />
        <span>{isZh ? "配置" : "Settings"}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="ink-config-menu w-56 max-h-[min(72vh,560px)]">
        <DropdownMenuItem data-testid="settings-appearance" onClick={() => nav.toProjectSettings()}>
          {isZh ? "外观与字体" : "Appearance & fonts"}
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="nav-models" onClick={nav.toServices}>
          {isZh ? "模型配置" : "Model settings"}
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="more-author" onClick={nav.toAuthor}>
          {isZh ? "作者信息" : "Author profile"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="more-import" onClick={() => nav.toImport()}>
          {isZh ? "导入旧作" : "Import a work"}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="more-ask-history"
          onClick={() => { setOpen(false); setSessionsOpen(true); }}
        >
          {t("nav.history")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {currentBookId && showWorkTools ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{isZh ? "当前作品" : "Current work"}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuLabel className="max-w-64 truncate">{currentBook?.title ?? currentBookId}</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => { setOpen(false); setBookPanel("settings"); }}>{isZh ? "作品设置" : "Work settings"}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setOpen(false); setBookPanel("tools"); }}>{isZh ? "作品工具" : "Work tools"}</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : currentBookId ? (
          <DropdownMenuItem onClick={() => { setOpen(false); setBookPanel("settings"); }}>{isZh ? "作品设置" : "Work settings"}</DropdownMenuItem>
        ) : null}
        {items.map((section) => (
          <DropdownMenuSub key={section.group}>
            <DropdownMenuSubTrigger>{section.group}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
            {section.entries.map((entry) => (
              <DropdownMenuItem
                key={entry.testId}
                data-testid={entry.testId}
                onClick={entry.onClick}
              >
                {entry.label}
              </DropdownMenuItem>
            ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => nav.toProjectSettings("advanced")}>{isZh ? "高级" : "Advanced"}</DropdownMenuItem>
        {currentBookId && nav.toTruth ? (
          <DropdownMenuItem onClick={() => nav.toTruth?.(currentBookId)}>
            {authoringBook ? (isZh ? "原始资料（只读）" : "Source files (read-only)") : (isZh ? "原始资料" : "Source files")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
    <AskSessionDrawer
      open={sessionsOpen}
      onClose={() => setSessionsOpen(false)}
      returnFocus={menuTrigger}
      books={books}
      booksLoading={booksLoading}
      booksError={booksError}
      onReloadBooks={() => void refetchBooks()}
      currentBookId={currentBookId ?? preferredBookId ?? undefined}
      nav={nav}
      t={t}
      isZh={isZh}
    />
    {currentBookId ? (
      <BookSettingsDrawer key={`settings-${currentBookId}`} bookId={currentBookId} open={bookPanel === "settings"} onClose={() => setBookPanel(null)} t={t} isZh={isZh} onDeleted={() => { setBookPanel(null); bumpBookDataVersion(); nav.toDashboard(); }} />
    ) : null}
    {showWorkTools && currentBookId ? (
      <BookToolsDrawer key={`tools-${currentBookId}`} bookId={currentBookId} open={bookPanel === "tools"} onClose={() => setBookPanel(null)} t={t} isZh={isZh} onOpenAnalytics={() => nav.toAnalytics(currentBookId)} />
    ) : null}
    </>
  );
}
