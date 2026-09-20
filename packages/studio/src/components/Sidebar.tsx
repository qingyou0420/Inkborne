import { useEffect, useMemo, useState } from "react";
import { useApi } from "../hooks/use-api";
import type { SSEMessage } from "../hooks/use-sse";
import {
  applyBookCollectionEvent,
  shouldRefetchBookCollections,
} from "../hooks/use-book-activity";
import type { TFunction } from "../hooks/use-i18n";
import { tr } from "../lib/app-language";
import {
  forgetBookCreateSessionIfMatches,
  setProjectChatSessionId,
  startFreshBookCreateSession,
} from "../pages/chat-page-state";
import { useChatStore } from "../store/chat";
import { BrandMark } from "./BrandMark";
import { ConfirmDialog } from "./ConfirmDialog";
import { PRODUCT_VERSION } from "../lib/product-version";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { SIDEBAR_CREATE_ITEM_KEYS } from "../lib/sidebar-create-items";
import type { AuthorPublic } from "../lib/author-profile";
import {
  Settings,
  Cpu,
  Activity,
  Plus,
  ScrollText,
  BookPlus,
  Boxes,
  Wand2,
  RefreshCw,
  Feather,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  User,
} from "lucide-react";

interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly chaptersWritten: number;
}

interface Nav {
  toDashboard: () => void;
  toAuthor: () => void;
  toChat: () => void;
  toBook: (id: string) => void;
  toBookSettings: (id: string) => void;
  toAsk: (id: string) => void;
  toOutline: (id: string) => void;
  toBookCreate: () => void;
  toServices: () => void;
  toProjectSettings: () => void;
  toDaemon: () => void;
  toLogs: () => void;
  toGenres: () => void;
  toStyle: () => void;
  toTranslation: () => void;
  toImport: (tab?: "chapters" | "canon" | "fanfic" | "spinoff" | "imitation") => void;
  toRadar: () => void;
  toDoctor: () => void;
  toCheckUpdate: () => void;
  toFilmStudio: (id: string) => void;
  toShort: (id: string) => void;
  toShortSettings: (id: string) => void;
  toShortAnalytics: (id: string) => void;
}

export function Sidebar({ nav, activePage, sse, t }: {
  nav: Nav;
  activePage: string;
  sse: { messages: ReadonlyArray<SSEMessage> };
  t: TFunction;
}) {
  const { data: author } = useApi<AuthorPublic>("/author");
  const { data, refetch: refetchBooks, mutate: mutateBooks } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const sessions = useChatStore((s) => s.sessions);
  const sessionIdsByBook = useChatStore((s) => s.sessionIdsByBook);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);
  const loadSessionList = useChatStore((s) => s.loadSessionList);
  const loadSessionDetail = useChatStore((s) => s.loadSessionDetail);
  const activateSession = useChatStore((s) => s.activateSession);
  const createDraftSession = useChatStore((s) => s.createDraftSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const setInput = useChatStore((s) => s.setInput);
  const [renameTarget, setRenameTarget] = useState<{ sessionId: string; currentTitle: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; title: string } | null>(null);
  const [expandedTalkBooks, setExpandedTalkBooks] = useState<Set<string>>(new Set());
  const [sessionsExpanded, setSessionsExpanded] = useState(false);

  const books = data?.books ?? [];
  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;
    if (shouldRefetchBookCollections(recent)) {
      let appliedBooks = false;
      mutateBooks((current) => {
        const updatedBooks = applyBookCollectionEvent(current?.books ?? [], recent);
        if (!updatedBooks) return current;
        appliedBooks = true;
        return { books: updatedBooks };
      });
      if (!appliedBooks) {
        refetchBooks();
      }
    }
  }, [mutateBooks, refetchBooks, sse.messages]);

  useEffect(() => {
    if (!sessionsExpanded) return;
    for (const book of books) {
      void loadSessionList(book.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookDataVersion, loadSessionList, sessionsExpanded, books]);

  useEffect(() => {
    void refetchBooks();
  }, [bookDataVersion, refetchBooks]);

  useEffect(() => {
    if (activePage === "chat") {
      setSessionsExpanded(true);
    }
  }, [activePage]);

  const toggleTalkBook = (bookId: string) => {
    setExpandedTalkBooks((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      if (sessionIdsByBook[bookId] === undefined) {
        void loadSessionList(bookId);
      }
      return next;
    });
  };

  const sessionsByBook = useMemo(
    () =>
      Object.fromEntries(
        books.map((book) => [
          book.id,
          (sessionIdsByBook[book.id] ?? [])
            .map((sessionId) => sessions[sessionId])
            .filter(Boolean),
        ]),
      ) as Record<string, Array<(typeof sessions)[string]>>,
    [books, sessionIdsByBook, sessions],
  );

  const openSession = (bookId: string, sessionId: string) => {
    setInput("");
    activateSession(sessionId);
    nav.toAsk(bookId);
    void loadSessionDetail(sessionId);
  };

  const handleCreateSession = (bookId: string) => {
    setExpandedTalkBooks((prev) => new Set(prev).add(bookId));
    setSessionsExpanded(true);
    setInput("");
    createDraftSession(bookId, "book");
    nav.toAsk(bookId);
  };

  const handleOpenBookCreate = () => {
    startFreshBookCreateSession(createDraftSession);
    setInput("");
    nav.toBookCreate();
  };

  const launchProjectMode = (kind: "short" | "play" | "script" | "storyboard" | "interactive-film", playMode?: "guided" | "open") => {
    const sessionId = createDraftSession(null, kind, playMode);
    setProjectChatSessionId(sessionId);
    setInput("");
    nav.toChat();
  };

  const handleRenameConfirm = async () => {
    if (!renameTarget) return;
    const nextTitle = renameValue.trim();
    if (!nextTitle) return;
    await renameSession(renameTarget.sessionId, nextTitle);
    setRenameTarget(null);
    setRenameValue("");
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    const sessionId = deleteTarget.sessionId;
    await deleteSession(sessionId);
    forgetBookCreateSessionIfMatches(sessionId);
    setDeleteTarget(null);
  };

  const authorLabel = author?.name?.trim() || t("nav.signYourName");
  const authorAvatar = author?.hasAvatar
    ? `/api/v1/author/avatar${author.updatedAt ? `?v=${encodeURIComponent(author.updatedAt)}` : ""}`
    : "";

  return (
    <aside className="w-[260px] shrink-0 border-r border-border bg-background/80 backdrop-blur-md flex flex-col h-full overflow-hidden select-none">
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        <button
          type="button"
          data-testid="sidebar-author"
          onClick={nav.toDashboard}
          className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left ${
            activePage === "dashboard" ? "bg-secondary text-foreground" : "hover:bg-secondary/40"
          }`}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary text-sm text-primary-foreground">
            {authorAvatar
              ? <img src={authorAvatar} alt="" className="h-full w-full object-cover" />
              : (author?.name?.trim().slice(0, 1) || "墨")}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{authorLabel}</span>
          </span>
        </button>

        <div>
          <SectionHeader label={t("nav.createSection")} />
          <div className="grid grid-cols-2 gap-1" data-testid="sidebar-create-list">
            {SIDEBAR_CREATE_ITEM_KEYS.map((key) => (
              key === "nav.createNovel" ? (
                <CreateItem
                  key={key}
                  testId="sidebar-create-novel"
                  icon={<BookPlus size={16} />}
                  label={t(key)}
                  active={activePage === "book-create"}
                  onClick={handleOpenBookCreate}
                />
              ) : (
                <CreateItem
                  key={key}
                  testId="sidebar-create-short"
                  icon={<ScrollText size={16} />}
                  label={t(key)}
                  onClick={() => launchProjectMode("short")}
                />
              )
            ))}
          </div>
        </div>

        <div data-testid="sidebar-sessions">
          <SectionHeader
            label={t("nav.history")}
            expanded={sessionsExpanded}
            onToggle={() => {
              const next = !sessionsExpanded;
              setSessionsExpanded(next);
              if (next) {
                for (const book of books) {
                  if (sessionIdsByBook[book.id] === undefined) void loadSessionList(book.id);
                }
              }
            }}
          />
          <Collapse open={sessionsExpanded}>
            <div className="pt-1 space-y-1">
              {books.map((book) => {
                const bookSessions = sessionsByBook[book.id] ?? [];
                const isExpanded = expandedTalkBooks.has(book.id);
                return (
                  <div key={`talk-${book.id}`}>
                    <button
                      type="button"
                      onClick={() => toggleTalkBook(book.id)}
                      className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[14px] text-muted-foreground hover:text-foreground"
                    >
                      <ChevronRight size={12} className={isExpanded ? "rotate-90" : ""} />
                      <span className="truncate flex-1">{book.title}</span>
                    </button>
                    <Collapse open={isExpanded}>
                      <div>
                        {bookSessions.map((session) => {
                          const isActiveSession = activePage === `book:${book.id}` && activeSessionId === session.sessionId;
                          const label = getSessionLabel(session, t);
                          return (
                            <div
                              key={session.sessionId}
                              className={`group/session flex items-center rounded-md ${isActiveSession ? "bg-secondary/50" : "hover:bg-secondary/30"}`}
                            >
                              <button
                                type="button"
                                onClick={() => openSession(book.id, session.sessionId)}
                                className="flex min-w-0 flex-1 items-center gap-2 pl-7 pr-2 py-1.5 text-left text-[14px] leading-5"
                              >
                                <span className={`truncate flex-1 ${isActiveSession ? "text-foreground" : "text-muted-foreground"}`}>
                                  {label}
                                </span>
                                {session.isStreaming ? (
                                  <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
                                ) : (
                                  <span className="shrink-0 text-[12px] text-muted-foreground/70">
                                    {formatRelativeTime(session.sessionId)}
                                  </span>
                                )}
                              </button>
                              <DropdownMenu>
                                <DropdownMenuTrigger className="flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-0 group-hover/session:opacity-100 text-muted-foreground">
                                  <MoreHorizontal size={14} />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent side="right" align="start" className="w-36">
                                  <DropdownMenuItem
                                    onClick={() => {
                                      setRenameTarget({ sessionId: session.sessionId, currentTitle: label });
                                      setRenameValue(session.title ?? "");
                                    }}
                                  >
                                    <Pencil size={14} />
                                    <span>{tr("改名", "Rename")}</span>
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onClick={() => setDeleteTarget({ sessionId: session.sessionId, title: label })}
                                  >
                                    <Trash2 size={14} />
                                    <span>{tr("删除", "Delete")}</span>
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() => void handleCreateSession(book.id)}
                          className="w-full flex items-center gap-2 pl-7 pr-2 py-1.5 text-[13px] text-muted-foreground/50 hover:text-foreground"
                        >
                          <Plus size={12} />
                          <span>{t("nav.newAsk")}</span>
                        </button>
                      </div>
                    </Collapse>
                  </div>
                );
              })}
            </div>
          </Collapse>
        </div>

        <div>
          <SectionHeader label={t("nav.tools")} />
          <div className="grid grid-cols-2 gap-1" data-testid="sidebar-tools-list">
            <CreateItem
              label={t("nav.style")}
              icon={<Wand2 size={16} />}
              active={activePage === "style"}
              onClick={nav.toStyle}
              testId="sidebar-tool-style"
            />
            <CreateItem
              label={t("nav.genreTemplates")}
              icon={<Boxes size={16} />}
              active={activePage === "genres"}
              onClick={nav.toGenres}
              testId="sidebar-tool-genres"
            />
          </div>
        </div>

        <div>
          <SectionHeader label={t("nav.system")} />
          <div className="grid grid-cols-2 gap-1" data-testid="sidebar-system-list">
            <CreateItem
              label={t("nav.config")}
              icon={<Cpu size={16} />}
              active={activePage === "services"}
              onClick={nav.toServices}
              testId="sidebar-system-config"
            />
            <CreateItem
              label={t("nav.projectSettings")}
              icon={<Settings size={16} />}
              active={activePage === "project-settings"}
              onClick={nav.toProjectSettings}
              testId="sidebar-system-project"
            />
            <CreateItem
              label={t("nav.authorProfile")}
              icon={<User size={16} />}
              active={activePage === "author"}
              onClick={nav.toAuthor}
              testId="sidebar-system-author"
            />
            <CreateItem
              label={t("nav.daemon")}
              icon={<Feather size={16} />}
              active={activePage === "daemon"}
              onClick={nav.toDaemon}
              testId="sidebar-system-daemon"
            />
            <CreateItem
              label={t("nav.logs")}
              icon={<Activity size={16} />}
              active={activePage === "logs"}
              onClick={nav.toLogs}
              testId="sidebar-system-logs"
            />
            <CreateItem
              label={t("nav.checkUpdate")}
              icon={<RefreshCw size={16} />}
              active={activePage === "update"}
              onClick={nav.toCheckUpdate}
              testId="nav-check-update"
            />
          </div>
        </div>
      </div>

      <div
        className="shrink-0 border-t border-border/40 px-4 py-2"
        data-testid="sidebar-brand"
      >
        <div className="flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
          <BrandMark className="h-3 w-3 rounded-full" />
          <span>墨生万象 · Inkborne · v{PRODUCT_VERSION}</span>
        </div>
      </div>

      <ConfirmDialog
        open={renameTarget !== null}
        title={t("nav.renameAsk")}
        message=""
        confirmLabel={tr("保存", "Save")}
        cancelLabel={tr("取消", "Cancel")}
        onConfirm={() => void handleRenameConfirm()}
        onCancel={() => {
          setRenameTarget(null);
          setRenameValue("");
        }}
      >
        <input
          id="session-rename-input"
          autoFocus
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleRenameConfirm();
            }
          }}
          placeholder={tr("输入新标题", "Enter a new title")}
          className="mt-3 h-10 w-full rounded-lg border border-border-strong bg-card px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t("nav.deleteAsk")}
        message={`${t("nav.deleteAskHint")}\n\n"${deleteTarget?.title ?? ""}"`}
        confirmLabel={tr("删除", "Delete")}
        cancelLabel={tr("取消", "Cancel")}
        variant="danger"
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => setDeleteTarget(null)}
      />
    </aside>
  );
}

function getSessionLabel(
  session: { sessionId: string; title: string | null; messages: ReadonlyArray<{ role: string; content: string }> },
  t: TFunction,
): string {
  if (session.title) return session.title;
  const firstUserMsg = session.messages.find((m) => m.role === "user")?.content?.trim();
  if (firstUserMsg) {
    const oneLine = firstUserMsg.replace(/\s+/g, " ");
    return oneLine.length > 20 ? `${oneLine.slice(0, 20)}…` : oneLine;
  }
  return t("nav.newAskPlaceholder");
}

function formatRelativeTime(sessionId: string): string {
  const rawTs = Number(sessionId.split("-")[0]);
  if (!Number.isFinite(rawTs)) return "";
  const diff = Date.now() - rawTs;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return tr("刚刚", "just now");
  if (minutes < 60) return tr(`${minutes} 分钟`, `${minutes}m`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tr(`${hours} 小时`, `${hours}h`);
  const days = Math.floor(hours / 24);
  if (days < 30) return tr(`${days} 天`, `${days}d`);
  const months = Math.floor(days / 30);
  return tr(`${months} 个月`, `${months}mo`);
}

function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

function SectionHeader({ label, expanded, onToggle }: {
  label: string;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  if (!onToggle) {
    return (
      <div className="px-3 mb-2.5">
        <span className="text-[13px] leading-5 font-medium text-muted-foreground">
          {label}
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group flex w-full items-center gap-1.5 px-3 py-2 text-left"
    >
      <span className="flex-1 text-[13px] leading-5 font-medium text-muted-foreground group-hover:text-foreground transition-colors">
        {label}
      </span>
      <ChevronRight
        size={15}
        className={`text-muted-foreground/50 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
      />
    </button>
  );
}

function CreateItem({ icon, label, active, onClick, testId }: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2.5 text-left text-[14px] leading-5 transition-all ${
        active
          ? "border border-border bg-secondary text-foreground font-medium shadow-sm"
          : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
      }`}
    >
      <span className={`shrink-0 ${active ? "text-primary" : ""}`}>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
