import { useState, useEffect, useCallback, useRef } from "react";
import { runGuardedNavigation } from "../lib/edit-navigation";

export type HashRoute =
  | { page: "dashboard" }
  | { page: "chat" }
  | { page: "book"; bookId: string }
  | { page: "book-outline"; bookId: string }
  | { page: "book-settings"; bookId: string }
  | { page: "book-ask"; bookId: string; sessionId?: string }
  | { page: "book-ground"; bookId: string }
  | { page: "book-weave"; bookId: string }
  | { page: "book-write"; bookId: string }
  | { page: "author" }
  | { page: "book-intro" }
  | { page: "book-create"; sessionId?: string }
  | { page: "services" }
  | { page: "project-settings"; section?: "advanced" }
  | { page: "service-detail"; serviceId: string }
  | { page: "chapter"; bookId: string; chapterNumber: number }
  | { page: "analytics"; bookId: string }
  | { page: "truth"; bookId: string }
  | { page: "daemon" }
  | { page: "logs" }
  | { page: "genres" }
  | { page: "style" }
  | { page: "translation" }
  | { page: "import"; tab?: "chapters" | "canon" | "fanfic" | "spinoff" | "imitation" }
  | { page: "radar" }
  | { page: "doctor" }
  | { page: "update" }
  | { page: "play"; projectId: string }
  | { page: "film"; projectId: string }
  | { page: "flow"; projectId: string }
  | { page: "film-author"; projectId: string }
  | { page: "film-studio"; projectId: string }
  | { page: "short"; storyId: string }
  | { page: "short-settings"; storyId: string }
  | { page: "short-analytics"; storyId: string };

function decodePart(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function parseHash(hash: string): HashRoute {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?", 2);
  const sessionId = new URLSearchParams(query).get("session") || undefined;

  if (!path || path === "/") return { page: "dashboard" };
  if (path === "author") return { page: "author" };
  if (path === "chat") return { page: "chat" };
  if (path === "config" || path === "services") return { page: "services" };
  if (path === "settings") return { page: "project-settings" };
  if (path === "settings/advanced") return { page: "project-settings", section: "advanced" };
  if (path === "import") return { page: "import" };
  if (path === "translation") return { page: "translation" };
  if (path === "update") return { page: "update" };
  if (path === "genres") return { page: "genres" };
  if (path === "style") return { page: "style" };
  if (path === "radar") return { page: "radar" };
  if (path === "doctor") return { page: "doctor" };
  const importMatch = path.match(/^import\/(chapters|canon|fanfic|spinoff|imitation)$/);
  if (importMatch) return { page: "import", tab: importMatch[1] as "chapters" | "canon" | "fanfic" | "spinoff" | "imitation" };
  if (path === "book/new") return sessionId ? { page: "book-create", sessionId } : { page: "book-create" };
  if (path === "book/intro") return { page: "book-intro" };

  const serviceMatch = path.match(/^services\/([^/]+)$/);
  if (serviceMatch) return { page: "service-detail", serviceId: decodePart(serviceMatch[1]) };

  if (path === "logs") return { page: "logs" };
  if (path === "daemon") return { page: "daemon" };

  const bookAskMatch = path.match(/^book\/([^/]+)\/ask$/);
  if (bookAskMatch) return { page: "book-ask", bookId: decodePart(bookAskMatch[1]), ...(sessionId ? { sessionId } : {}) };

  const bookGroundMatch = path.match(/^book\/([^/]+)\/ground$/);
  if (bookGroundMatch) return { page: "book-ground", bookId: decodePart(bookGroundMatch[1]) };

  const bookWeaveMatch = path.match(/^book\/([^/]+)\/(?:weave|outline)$/);
  if (bookWeaveMatch) return { page: "book-weave", bookId: decodePart(bookWeaveMatch[1]) };

  const bookWriteMatch = path.match(/^book\/([^/]+)\/(?:write|settings)$/);
  if (bookWriteMatch) return { page: "book-write", bookId: decodePart(bookWriteMatch[1]) };

  const bookChatMatch = path.match(/^book\/([^/]+)\/chat$/);
  if (bookChatMatch) return { page: "book-ask", bookId: decodePart(bookChatMatch[1]) };

  const chapterMatch = path.match(/^book\/([^/]+)\/chapter\/([1-9]\d*)$/);
  if (chapterMatch) return { page: "chapter", bookId: decodePart(chapterMatch[1]), chapterNumber: Number(chapterMatch[2]) };
  const analyticsMatch = path.match(/^book\/([^/]+)\/analytics$/);
  if (analyticsMatch) return { page: "analytics", bookId: decodePart(analyticsMatch[1]) };
  const truthMatch = path.match(/^book\/([^/]+)\/truth$/);
  if (truthMatch) return { page: "truth", bookId: decodePart(truthMatch[1]) };

  const bookMatch = path.match(/^book\/([^/]+)$/);
  if (bookMatch) return { page: "book", bookId: decodePart(bookMatch[1]) };

  const playMatch = path.match(/^play\/([^/]+)$/);
  if (playMatch) return { page: "play", projectId: decodePart(playMatch[1]) };

  const filmMatch = path.match(/^film\/([^/]+)$/);
  if (filmMatch) return { page: "film", projectId: decodePart(filmMatch[1]) };

  const flowMatch = path.match(/^flow\/([^/]+)$/);
  if (flowMatch) return { page: "flow", projectId: decodePart(flowMatch[1]) };

  const filmAuthorMatch = path.match(/^film-author\/([^/]+)$/);
  if (filmAuthorMatch) return { page: "film-author", projectId: decodePart(filmAuthorMatch[1]) };

  const studioFilmMatch = path.match(/^studio\/film\/([^/]+)$/);
  if (studioFilmMatch) return { page: "film-studio", projectId: decodePart(studioFilmMatch[1]) };

  const shortSettingsMatch = path.match(/^short\/([^/]+)\/settings$/);
  if (shortSettingsMatch) return { page: "short-settings", storyId: decodePart(shortSettingsMatch[1]) };

  const shortAnalyticsMatch = path.match(/^short\/([^/]+)\/analytics$/);
  if (shortAnalyticsMatch) return { page: "short-analytics", storyId: decodePart(shortAnalyticsMatch[1]) };

  const shortMatch = path.match(/^short\/([^/]+)$/);
  if (shortMatch) return { page: "short", storyId: decodePart(shortMatch[1]) };

  return { page: "dashboard" };
}

function routeToHash(route: HashRoute): string {
  switch (route.page) {
    case "dashboard": return "#/";
    case "author": return "#/author";
    case "book-intro": return "#/book/intro";
    case "chat": return "#/chat";
    case "book": return `#/book/${encodeURIComponent(route.bookId)}`;
    case "book-outline":
    case "book-weave": return `#/book/${encodeURIComponent(route.bookId)}/weave`;
    case "book-settings":
    case "book-write": return `#/book/${encodeURIComponent(route.bookId)}/write`;
    case "logs": return "#/logs";
    case "daemon": return "#/daemon";
    case "genres": return "#/genres";
    case "style": return "#/style";
    case "radar": return "#/radar";
    case "doctor": return "#/doctor";
    case "chapter": return `#/book/${encodeURIComponent(route.bookId)}/chapter/${route.chapterNumber}`;
    case "analytics": return `#/book/${encodeURIComponent(route.bookId)}/analytics`;
    case "truth": return `#/book/${encodeURIComponent(route.bookId)}/truth`;
    case "book-ask": return `#/book/${encodeURIComponent(route.bookId)}/ask${route.sessionId ? `?session=${encodeURIComponent(route.sessionId)}` : ""}`;
    case "book-ground": return `#/book/${encodeURIComponent(route.bookId)}/ground`;
    case "book-create": return `#/book/new${route.sessionId ? `?session=${encodeURIComponent(route.sessionId)}` : ""}`;
    case "services": return "#/services";
    case "project-settings": return route.section === "advanced" ? "#/settings/advanced" : "#/settings";
    case "translation": return "#/translation";
    case "update": return "#/update";
    case "import": return route.tab ? `#/import/${route.tab}` : "#/import";
    case "service-detail": return `#/services/${encodeURIComponent(route.serviceId)}`;
    case "play": return `#/play/${encodeURIComponent(route.projectId)}`;
    case "film": return `#/film/${encodeURIComponent(route.projectId)}`;
    case "flow": return `#/flow/${encodeURIComponent(route.projectId)}`;
    case "film-author": return `#/film-author/${encodeURIComponent(route.projectId)}`;
    case "film-studio": return `#/studio/film/${encodeURIComponent(route.projectId)}`;
    case "short": return `#/short/${encodeURIComponent(route.storyId)}`;
    case "short-settings": return `#/short/${encodeURIComponent(route.storyId)}/settings`;
    case "short-analytics": return `#/short/${encodeURIComponent(route.storyId)}/analytics`;
    default: return "";
  }
}

export { parseHash, routeToHash }; // for testing

/** State changes associated with navigation run in the same accepted commit.
 * In particular, declining to leave a manuscript must not replace its chat.
 */
export function navigateWithGuard(
  current: HashRoute,
  next: HashRoute,
  commit: (next: HashRoute) => void,
  onAccepted?: () => void,
): Promise<boolean> {
  if (!onAccepted && routeToHash(next) === routeToHash(current)) return Promise.resolve(false);
  return runGuardedNavigation(() => {
    onAccepted?.();
    commit(next);
  });
}

export function useHashRoute() {
  const [route, setRouteState] = useState<HashRoute>(() => parseHash(window.location.hash));
  const currentRoute = useRef(route);

  const commitRoute = useCallback((next: HashRoute, replace = false) => {
    currentRoute.current = next;
    setRouteState(next);
    const hash = routeToHash(next);
    if (hash && window.location.hash !== hash) {
      if (replace) window.history.replaceState(null, "", hash);
      else window.location.hash = hash;
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const requested = parseHash(window.location.hash);
      const previousHash = routeToHash(currentRoute.current);
      if (routeToHash(requested) === previousHash) return;
      // Browser back/forward already changed the URL; restore it while the
      // editor stays mounted and asks whether to save, discard, or continue.
      window.history.replaceState(null, "", previousHash);
      void runGuardedNavigation(() => commitRoute(requested, true));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [commitRoute]);

  useEffect(() => {
    const canonical = routeToHash(route);
    if (canonical && window.location.hash !== canonical) {
      window.history.replaceState(null, "", canonical);
    }
  }, [route]);

  const setRoute = useCallback((newRoute: HashRoute, onAccepted?: () => void) => {
    void navigateWithGuard(currentRoute.current, newRoute, commitRoute, onAccepted);
  }, [commitRoute]);

  const nav = {
    toServices: () => setRoute({ page: "services" }),
    toServiceDetail: (id: string) => setRoute({ page: "service-detail", serviceId: id }),
  };

  return { route, setRoute, nav };
}
