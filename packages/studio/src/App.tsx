import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { useHashRoute } from "./hooks/use-hash-route";
import type { HashRoute } from "./hooks/use-hash-route";
import { BookWorkspaceNav, type BookWorkspaceTab } from "./components/BookWorkspaceNav";
import { BrandMark } from "./components/BrandMark";
import { StudioHeader } from "./components/StudioHeader";
import { Dashboard, type HomeBookSummary } from "./pages/Dashboard";
import { NewBookIntro } from "./components/NewBookIntro";
import { isStartupHomeHash, startupBookRoute } from "./lib/home-navigation";
import "./ink-home.css";
import { ChatPage } from "./pages/ChatPage";
import { BookDetail } from "./pages/BookDetail";
import { BookStudy } from "./pages/BookStudy";
import { AuthorPage } from "./pages/AuthorPage";
import { OutlineWorkspace } from "./pages/OutlineWorkspace";
import { BookGround } from "./pages/BookGround";
import { AskCanonPanel } from "./components/AskCanonPanel";
import { BookAskPage } from "./pages/BookAskPage";
import { ToastHost } from "./components/ToastHost";
import { ChapterReader } from "./pages/ChapterReader";
import { Analytics } from "./pages/Analytics";
import { ServiceListPage } from "./pages/ServiceListPage";
import { ServiceDetailPage } from "./pages/ServiceDetailPage";
import { ProjectSettings } from "./pages/ProjectSettings";
import { TruthFiles } from "./pages/TruthFiles";
import { DaemonControl } from "./pages/DaemonControl";
import { LogViewer } from "./pages/LogViewer";
import { GenreManager } from "./pages/GenreManager";
import { StyleManager } from "./pages/StyleManager";
import { TranslationManager } from "./pages/TranslationManager";
import { ImportManager } from "./pages/ImportManager";
import { RadarView } from "./pages/RadarView";
import { DoctorView } from "./pages/DoctorView";
import { CheckUpdate } from "./pages/CheckUpdate";
import { ShortReader } from "./pages/ShortReader";
import { ShortSettings } from "./pages/ShortSettings";
import { StoryPlayer } from "./pages/StoryPlayer";
import { StoryGraphTree } from "./pages/StoryGraphTree";
const FlowView = lazy(() => import("./pages/FlowView"));
const FilmWizard = lazy(() => import("./pages/FilmWizard"));
import { LanguageSelector } from "./pages/LanguageSelector";
import { BookBusyCard } from "./components/BookBusyCard";
import { useNewSSEMessages, useSSE } from "./hooks/use-sse";
import { invalidateBookStage, shouldInvalidateBookStageEvent } from "./hooks/use-book-stage";
import { useSessionEvents } from "./hooks/use-session-events";
import { useTheme } from "./hooks/use-theme";
import { useI18n } from "./hooks/use-i18n";
import { setAppLanguage, tr } from "./lib/app-language";
import { invalidateApiPaths, invalidationPathsForChapterMutationSse, postApi, useApi } from "./hooks/use-api";
import { X } from "lucide-react";
import { useChatStore } from "./store/chat";
import { applyAppearanceToDocument } from "./lib/appearance";
import { usePreferencesStore } from "./store/preferences";

const PAGE_SHELL = "mx-auto w-full max-w-[880px] px-8 pt-10 pb-16 fade-in";
const PAGE_SHELL_WIDE = "mx-auto w-full max-w-[1200px] px-8 pt-10 pb-16 fade-in";

export function deriveBookChromeTab(route: HashRoute): BookWorkspaceTab | null {
  switch (route.page) {
    case "book":
    case "analytics":
      return "study";
    case "book-ask":
      return "ask";
    case "book-ground":
    case "truth":
      return "ground";
    case "book-weave":
    case "book-outline":
      return "weave";
    case "book-write":
    case "book-settings":
    case "chapter":
      return "write";
    default:
      return null;
  }
}

export type { HashRoute as Route } from "./hooks/use-hash-route";

export function deriveActiveBookId(route: HashRoute): string | undefined {
  if ("bookId" in route) return route.bookId;
  return undefined;
}

export function isBookCreateChatRoute(route: HashRoute): boolean {
  return route.page === "book-create";
}

export function deriveStartupGate(input: {
  readonly ready: boolean;
  readonly projectError: string | null;
}): "ready" | "loading" | "error" {
  if (input.ready) return "ready";
  return input.projectError ? "error" : "loading";
}

export function App() {
  const { route, setRoute: setHashRoute } = useHashRoute();
  const startupResumeAllowed = useRef(isStartupHomeHash(window.location.hash));
  const [startupResumePending, setStartupResumePending] = useState(startupResumeAllowed.current);
  const setRoute = useCallback((nextRoute: HashRoute, onAccepted?: () => void) => {
    // Explicit navigation wins, including a return to the bookshelf while loading.
    startupResumeAllowed.current = false;
    setStartupResumePending(false);
    setHashRoute(nextRoute, onAccepted);
  }, [setHashRoute]);
  const sse = useSSE();
  const { theme, setTheme } = useTheme();
  const { t, lang: currentLang } = useI18n();
  const uiFont = usePreferencesStore((s) => s.uiFont);
  const proseFont = usePreferencesStore((s) => s.proseFont);
  const proseSize = usePreferencesStore((s) => s.proseSize);
  const proseLeading = usePreferencesStore((s) => s.proseLeading);
  const showStudioImage = usePreferencesStore((s) => s.showStudioImage);
  const paperTone = usePreferencesStore((s) => s.paperTone);
  const lastStages = usePreferencesStore((s) => s.lastStages);
  const lastChapters = usePreferencesStore((s) => s.lastChapters);
  const setLastChapter = usePreferencesStore((s) => s.setLastChapter);
  const currentBookIdPref = usePreferencesStore((s) => s.currentBookId);
  const setCurrentBookId = usePreferencesStore((s) => s.setCurrentBookId);
  const setLastStage = usePreferencesStore((s) => s.setLastStage);
  const { data: project, error: projectError, refetch: refetchProject } = useApi<{ language: string; languageExplicit: boolean }>("/project");
  const [showLanguageSelector, setShowLanguageSelector] = useState(false);
  const [ready, setReady] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const { data: startupBooks, error: startupBooksError } = useApi<{ books: ReadonlyArray<HomeBookSummary> }>(ready && startupResumePending ? "/books" : "");

  useEffect(() => {
    if (!startupResumePending) return;
    if (route.page !== "dashboard" || !startupResumeAllowed.current) {
      startupResumeAllowed.current = false;
      setStartupResumePending(false);
      return;
    }
    if (!ready || showLanguageSelector) return;
    if (startupBooksError) {
      startupResumeAllowed.current = false;
      setStartupResumePending(false);
      return;
    }
    if (!startupBooks) return;
    startupResumeAllowed.current = false;
    setStartupResumePending(false);
    const target = startupBookRoute(startupBooks.books, lastStages);
    if (target) setHashRoute(target);
  }, [startupResumePending, route.page, ready, showLanguageSelector, startupBooks, startupBooksError, lastStages, setHashRoute]);

  const isDark = theme === "dark";

  // 全局语言同步：app-language 是模块级单例，供用不了 hook 的代码（lib 纯函数、
  // store slice）读取。这里在渲染期同步赋值，让子组件在同一次渲染里调用 tr() 时
  // 就读到正确语言（只用 effect 的话，effect 要等本次渲染提交后才执行，本次渲染
  // 里的 tr() 会读到旧语言）。赋值是幂等的模块变量写入，StrictMode 重复渲染无影
  // 响；下面的 effect 在语言加载完成和切换时再设置一次，保证提交后的值也正确。
  setAppLanguage(currentLang);
  useEffect(() => {
    setAppLanguage(currentLang);
  }, [currentLang]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
  }, [isDark]);

  useEffect(() => {
    applyAppearanceToDocument({
      uiFont,
      proseFont,
      proseSize,
      proseLeading,
      showStudioImage,
      paperTone,
      currentBookId: currentBookIdPref,
      lastStages,
      lastChapters,
    });
  }, [uiFont, proseFont, proseSize, proseLeading, showStudioImage, paperTone, currentBookIdPref, lastStages, lastChapters]);

  useEffect(() => {
    if (project) {
      if (!project.languageExplicit) {
        setShowLanguageSelector(true);
      }
      setReady(true);
    }
  }, [project]);

  useSessionEvents(sse, route, setRoute);
  const bumpBookDataVersion = useChatStore((state) => state.bumpBookDataVersion);

  const nav = {
    toDashboard: () => setRoute({ page: "dashboard" }),
    toAuthor: () => setRoute({ page: "author" }),
    toChat: (onAccepted?: () => void) => setRoute({ page: "chat" }, onAccepted),
    toBook: (bookId: string) => setRoute({ page: "book", bookId }),
    toAsk: (bookId: string, sessionId?: string) => setRoute({ page: "book-ask", bookId, ...(sessionId ? { sessionId } : {}) }),
    toGround: (bookId: string) => setRoute({ page: "book-ground", bookId }),
    toWeave: (bookId: string) => setRoute({ page: "book-weave", bookId }),
    toWrite: (bookId: string) => setRoute({ page: "book-write", bookId }),
    toOutline: (bookId: string) => setRoute({ page: "book-weave", bookId }),
    toBookSettings: (bookId: string) => setRoute({ page: "book-write", bookId }),
    toBookCreate: (sessionId?: string) => setRoute({ page: "book-create", ...(sessionId ? { sessionId } : {}) }),
    toBookIntro: () => setRoute({ page: "book-intro" }),
    toChapter: (bookId: string, chapterNumber: number) =>
      setRoute({ page: "chapter", bookId, chapterNumber }),
    toAnalytics: (bookId: string) => setRoute({ page: "analytics", bookId }),
    toServices: () => setRoute({ page: "services" }),
    toProjectSettings: (section?: "advanced") => setRoute({ page: "project-settings", ...(section ? { section } : {}) }),
    toServiceDetail: (id: string) => setRoute({ page: "service-detail", serviceId: id }),
    toTruth: (bookId: string) => setRoute({ page: "truth", bookId }),
    toDaemon: () => setRoute({ page: "daemon" }),
    toLogs: () => setRoute({ page: "logs" }),
    toGenres: () => setRoute({ page: "genres" }),
    toStyle: () => setRoute({ page: "style" }),
    toTranslation: () => setRoute({ page: "translation" }),
    toImport: (tab?: "chapters" | "canon" | "fanfic" | "spinoff" | "imitation") => setRoute({ page: "import", ...(tab ? { tab } : {}) }),
    toRadar: () => setRoute({ page: "radar" }),
    toDoctor: () => setRoute({ page: "doctor" }),
    toCheckUpdate: () => setRoute({ page: "update" }),
    toPlay: (projectId: string) => setRoute({ page: "play", projectId }),
    toFilm: (projectId: string) => setRoute({ page: "film", projectId }),
    toFlow: (projectId: string) => setRoute({ page: "flow", projectId }),
    toFilmAuthor: (projectId: string) => setRoute({ page: "film-author", projectId }),
    toFilmStudio: (projectId: string) => setRoute({ page: "film-studio", projectId }),
    toShort: (storyId: string) => setRoute({ page: "short", storyId }),
    toShortSettings: (storyId: string) => setRoute({ page: "short-settings", storyId }),
    toShortAnalytics: (storyId: string) => setRoute({ page: "short-analytics", storyId }),
  };

  const activeBookId = deriveActiveBookId(route);
  const bookChromeTab = deriveBookChromeTab(route);
  const showBookChrome = Boolean(activeBookId && bookChromeTab);

  useEffect(() => {
    if (activeBookId) setCurrentBookId(activeBookId);
    if (route.page === "chapter") setLastChapter(route.bookId, route.chapterNumber);
    if (
      activeBookId
      && (bookChromeTab === "ask" || bookChromeTab === "ground" || bookChromeTab === "weave" || bookChromeTab === "write")
    ) {
      setLastStage(activeBookId, bookChromeTab);
    }
  }, [activeBookId, bookChromeTab, route, setCurrentBookId, setLastStage, setLastChapter]);

  useEffect(() => {
    if (bookChromeTab !== "write") setFocusMode(false);
  }, [bookChromeTab]);

  useEffect(() => {
    if (!focusMode) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      if (event.key === "Escape") setFocusMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusMode]);

  const onStageSse = useCallback((message: { event: string; data: unknown }) => {
    const chapterPaths = invalidationPathsForChapterMutationSse(message);
    if (chapterPaths.length) invalidateApiPaths(chapterPaths);
    if (!shouldInvalidateBookStageEvent(message.event)) return;
    const data = message.data as { bookId?: string } | null;
    invalidateBookStage(typeof data?.bookId === "string" ? data.bookId : activeBookId);
    bumpBookDataVersion();
  }, [activeBookId, bumpBookDataVersion]);
  useNewSSEMessages(sse.messages, onStageSse);

  const startupGate = deriveStartupGate({ ready, projectError });

  if (startupGate === "error") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-2xl border border-destructive/30 bg-destructive/5 p-6 space-y-4">
          <div>
            <h1 className="text-lg font-semibold text-destructive">无法加载项目配置 / Failed to load project config</h1>
            <p className="mt-2 text-sm text-muted-foreground break-all">{projectError}</p>
          </div>
          {/* 项目配置没加载出来，语言未知，所以这屏中英双语并排展示。 */}
          <p className="text-sm text-muted-foreground">
            请检查项目根目录下的 inkos.json 是否存在且为合法 JSON，然后重试。
            <br />
            Check that inkos.json in the project root exists and is valid JSON, then retry.
          </p>
          <button
            type="button"
            onClick={() => refetchProject()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            重试 / Retry
          </button>
        </div>
      </div>
    );
  }

  if (startupGate === "loading") {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-5">
        <BrandMark className="w-16 h-16 rounded-full" />
        <div className="font-serif text-2xl text-foreground">墨生万象</div>
        <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (showLanguageSelector) {
    return (
      <LanguageSelector
        onSelect={async (lang) => {
          await postApi("/project/language", { language: lang });
          setShowLanguageSelector(false);
          refetchProject();
        }}
      />
    );
  }

  return (
    <div className={`h-screen bg-background text-foreground flex overflow-hidden font-sans ${showBookChrome ? "in-book" : ""} ${focusMode ? "focus-mode" : ""}`}>
      <div className="flex-1 flex flex-col min-w-0 bg-background">
        <StudioHeader
          nav={nav}
          t={t}
          isZh={currentLang !== "en"}
          isDark={isDark}
          onToggleTheme={() => setTheme(isDark ? "light" : "dark")}
          studyCurrent={route.page === "dashboard"}
          sse={sse}
          currentBookId={activeBookId}
        />
        {showBookChrome && activeBookId && bookChromeTab ? (
          <div className="book-chrome-strip flex items-center justify-between">
            <BookWorkspaceNav
              bookId={activeBookId}
              active={bookChromeTab}
              nav={nav}
              isZh={currentLang !== "en"}
              t={t}
              onFocusMode={() => setFocusMode(true)}
            />
          </div>
        ) : null}
        {focusMode ? (
          <button
            type="button"
            className="focus-mode-exit"
            onClick={() => setFocusMode(false)}
          >
            <X size={14} />
            {t("nav.exitFocus")}
          </button>
        ) : null}

        {/* Main Content Area */}
        <main className="ink-main flex-1 relative overflow-y-auto scroll-smooth">
          {route.page === "dashboard" && (
            <div className="one-page fade-in">
              {startupResumePending ? <div className="ink-home-loading" role="status">{t("common.loading")}</div> : <Dashboard nav={nav} sse={sse} theme={theme} t={t} />}
            </div>
          )}
          {route.page === "book-intro" && <div className="one-page fade-in"><NewBookIntro isZh={currentLang !== "en"} onEnterAsk={nav.toBookCreate} /></div>}
          {route.page === "author" && (
            <div className={PAGE_SHELL}>
              <AuthorPage nav={nav} t={t} isZh={currentLang !== "en"} />
            </div>
          )}
          {route.page === "short" && (
            <div className={PAGE_SHELL}>
              <ShortReader storyId={route.storyId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "short-settings" && (
            <div className={PAGE_SHELL}>
              <ShortSettings storyId={route.storyId} nav={nav} t={t} />
            </div>
          )}
          {route.page === "short-analytics" && (
            <div className={PAGE_SHELL_WIDE}>
              <Analytics bookId={route.storyId} kind="short" nav={nav} theme={theme} t={t} />
            </div>
          )}
          {isBookCreateChatRoute(route) && (
            <div className="ask-workspace h-full min-h-0 min-w-0" data-testid="book-create-ask">
              <ChatPage
                mode="book-create"
                resumeSessionId={route.page === "book-create" ? route.sessionId : undefined}
                nav={nav}
                theme={theme}
                t={t}
                sse={sse}
              />
              <AskCanonPanel isZh={currentLang !== "en"} resumeSessionId={route.page === "book-create" ? route.sessionId : undefined} onAdopted={(id) => nav.toAsk(id)} />
            </div>
          )}
          {route.page === "chat" && (
            <div className="absolute inset-0 flex min-w-0">
              <ChatPage
                mode="project-chat"
                nav={nav}
                theme={theme}
                t={t}
                sse={sse}
              />
            </div>
          )}
          {route.page === "book" && (
            <div className="one-book-page fade-in">
              <BookStudy bookId={route.bookId} nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "book-ask" && (
            <div className="absolute inset-0 flex min-w-0 flex-col" data-testid="book-ask-page">
              <BookAskPage
                bookId={route.bookId}
                resumeSessionId={route.sessionId}
                nav={nav}
                theme={theme}
                t={t}
                sse={sse}
              />
            </div>
          )}
          {route.page === "book-ground" && (
            <div className="one-book-page fade-in">
              <BookGround bookId={route.bookId} nav={nav} theme={theme} t={t} isZh={currentLang !== "en"} />
            </div>
          )}
          {(route.page === "book-outline" || route.page === "book-weave") && (
            <div className="one-book-page fade-in">
              <OutlineWorkspace bookId={route.bookId} nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {(route.page === "book-settings" || route.page === "book-write") && (
            <div className="one-book-page fade-in">
              <BookDetail bookId={route.bookId} nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "chapter" && (
            <div className="one-book-page fade-in">
              <ChapterReader bookId={route.bookId} chapterNumber={route.chapterNumber} nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "analytics" && (
            <div className={PAGE_SHELL_WIDE}>
              <Analytics bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "services" && (
            <div className={PAGE_SHELL}>
              <ServiceListPage nav={nav} />
            </div>
          )}
          {route.page === "project-settings" && (
            <div className={PAGE_SHELL}>
              <ProjectSettings nav={nav} theme={theme} t={t} setTheme={setTheme} section={route.section} />
            </div>
          )}
          {route.page === "service-detail" && (
            <div className={PAGE_SHELL}>
              <ServiceDetailPage serviceId={route.serviceId} nav={nav} />
            </div>
          )}
          {route.page === "truth" && (
            <div className={PAGE_SHELL}>
              <TruthFiles bookId={route.bookId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "daemon" && (
            <div className={PAGE_SHELL}>
              <DaemonControl nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "logs" && (
            <div className={PAGE_SHELL}>
              <LogViewer nav={nav} theme={theme} t={t} sse={sse} />
            </div>
          )}
          {route.page === "genres" && (
            <div className={PAGE_SHELL}>
              <GenreManager nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "style" && (
            <div className={PAGE_SHELL}>
              <StyleManager nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "translation" && (
            <div className={PAGE_SHELL_WIDE}>
              <TranslationManager nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "import" && (
            <div className={PAGE_SHELL}>
              <ImportManager nav={nav} theme={theme} t={t} initialTab={route.tab} />
            </div>
          )}
          {route.page === "radar" && (
            <div className={PAGE_SHELL}>
              <RadarView nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "doctor" && (
            <div className={PAGE_SHELL}>
              <DoctorView nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "update" && (
            <div className={PAGE_SHELL}>
              <CheckUpdate nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "play" && (
            <div className={PAGE_SHELL}>
              <StoryPlayer projectId={route.projectId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "film" && (
            <div className={PAGE_SHELL}>
              <StoryGraphTree projectId={route.projectId} nav={nav} theme={theme} t={t} />
            </div>
          )}
          {route.page === "film-author" && (
            <div className="absolute inset-0 flex min-w-0">
              <ChatPage
                activeBookId={route.projectId}
                mode="interactive-film-authoring"
                nav={nav}
                theme={theme}
                t={t}
                sse={sse}
              />
            </div>
          )}
          {route.page === "film-studio" && (
            <Suspense fallback={<div className="p-6 text-sm">{tr("加载创作向导…", "Loading creation wizard…")}</div>}>
              <FilmWizard projectId={route.projectId} nav={nav} theme={theme} t={t} sse={sse} />
            </Suspense>
          )}
          {route.page === "flow" && (
            <Suspense fallback={<div className="p-6 text-sm">{tr("加载流程图…", "Loading flow view…")}</div>}>
              <FlowView projectId={route.projectId} nav={nav} theme={theme} t={t} />
            </Suspense>
          )}
        </main>
      </div>
      <BookBusyCard />
      <ToastHost />
    </div>
  );
}
