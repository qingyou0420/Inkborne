import { useState, useEffect, useCallback } from "react";
import { localizeKnownRuntimeMessage } from "../lib/error-copy";

export const BOOK_BUSY_EVENT = "fantawriter:book-busy";

export interface BookLockOwnerInfo {
  readonly bookId?: string;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly heartbeatAt?: number;
  readonly heldMs?: number;
  readonly taskId?: string;
  readonly stage?: string;
  readonly inProcess?: boolean;
}

export class StudioApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
    readonly owner?: BookLockOwnerInfo,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "StudioApiError";
  }
}

const BASE = "/api/v1";
const API_INVALIDATE_EVENT = "inkos:api-invalidate";

interface ApiInvalidateDetail {
  readonly paths: ReadonlyArray<string>;
}

export function buildApiUrl(path: string): string | null {
  const normalized = String(path ?? "").trim();
  if (!normalized) return null;
  if (normalized.startsWith(`${BASE}/`) || normalized === BASE) {
    return normalized;
  }
  return normalized.startsWith("/") ? `${BASE}${normalized}` : `${BASE}/${normalized}`;
}

export function chapterMutationInvalidationPaths(
  bookId: string,
  chapterNumber: number,
): ReadonlyArray<string> {
  return [
    "/api/v1/books",
    `/api/v1/books/${bookId}`,
    `/api/v1/books/${bookId}/chapters/${chapterNumber}`,
    `/api/v1/books/${bookId}/chapters/${chapterNumber}/workspace`,
  ];
}

export function invalidationPathsForChapterMutationSse(input: {
  readonly event: string;
  readonly data: unknown;
}): ReadonlyArray<string> {
  if (!/^(rewrite|revise):complete$/.test(input.event)) return [];
  const data = input.data as { bookId?: unknown; chapterNumber?: unknown; chapter?: unknown } | null;
  const bookId = typeof data?.bookId === "string" ? data.bookId : "";
  const chapter = typeof data?.chapterNumber === "number"
    ? data.chapterNumber
    : typeof data?.chapter === "number"
      ? data.chapter
      : Number.NaN;
  if (!bookId || !Number.isInteger(chapter) || chapter < 1) return [];
  return chapterMutationInvalidationPaths(bookId, chapter);
}

const AUTHORING_RUN_TERMINAL = new Set(["completed", "failed", "partial", "cancelled"]);

/** Background ask-canon triage finishes as `authoring:run`; refresh the open workspace (no extra polling). */
export function invalidationPathsForAuthoringRunSse(input: {
  readonly event: string;
  readonly data: unknown;
}): ReadonlyArray<string> {
  if (input.event !== "authoring:run") return [];
  const data = input.data as { bookId?: unknown; draftId?: unknown; status?: unknown } | null;
  if (typeof data?.status !== "string" || !AUTHORING_RUN_TERMINAL.has(data.status)) return [];
  if (typeof data.bookId === "string" && data.bookId) {
    return [`/api/v1/authoring/workspace?bookId=${encodeURIComponent(data.bookId)}`];
  }
  if (typeof data.draftId === "string" && data.draftId) {
    return [`/api/v1/authoring/workspace?draftId=${encodeURIComponent(data.draftId)}`];
  }
  return [];
}

export function deriveInvalidationPaths(path: string): ReadonlyArray<string> {
  const normalized = buildApiUrl(path);
  if (!normalized) return [];

  if (
    normalized === "/api/v1/books/create" ||
    normalized === "/api/v1/fanfic/init" ||
    normalized === "/api/v1/spinoff/init" ||
    normalized === "/api/v1/imitation/init"
  ) {
    return ["/api/v1/books"];
  }

  const shortMutation = normalized.match(/^\/api\/v1\/shorts\/([^/]+)$/);
  if (shortMutation) {
    return ["/api/v1/shorts", normalized];
  }

  if (normalized === "/api/v1/author" || normalized.startsWith("/api/v1/author/")) {
    return ["/api/v1/author"];
  }

  if (normalized === "/api/v1/project") {
    return ["/api/v1/project"];
  }

  if (normalized.startsWith("/api/v1/project/")) {
    return ["/api/v1/project", normalized];
  }

  if (normalized.startsWith("/api/v1/authoring/")) {
    return [normalized, "/api/v1/authoring/workspace"];
  }

  const bookAction = normalized.match(/^\/api\/v1\/books\/([^/]+)\/(write-next|draft)$/);
  if (bookAction) {
    return ["/api/v1/books", `/api/v1/books/${bookAction[1]}`];
  }

  const chapterAction = normalized.match(/^\/api\/v1\/books\/([^/]+)\/chapters\/\d+\/(approve|reject)$/);
  if (chapterAction) {
    return ["/api/v1/books", `/api/v1/books/${chapterAction[1]}`];
  }

  const chapterMutation = normalized.match(/^\/api\/v1\/books\/([^/]+)\/(rewrite|revise|resync)\/(\d+)$/);
  if (chapterMutation) {
    return chapterMutationInvalidationPaths(chapterMutation[1]!, Number(chapterMutation[3]));
  }

  const chapterRestore = normalized.match(/^\/api\/v1\/books\/([^/]+)\/chapters\/(\d+)\/versions\/[^/]+\/restore$/);
  if (chapterRestore) {
    return chapterMutationInvalidationPaths(chapterRestore[1]!, Number(chapterRestore[2]));
  }

  const chapterBody = normalized.match(/^\/api\/v1\/books\/([^/]+)\/chapters\/(\d+)$/);
  if (chapterBody) {
    return chapterMutationInvalidationPaths(chapterBody[1]!, Number(chapterBody[2]));
  }

  const storyCard = normalized.match(/^\/api\/v1\/books\/([^/]+)\/story-card$/);
  if (storyCard) {
    return [
      `/api/v1/books/${storyCard[1]}/story-card`,
      `/api/v1/books/${storyCard[1]}/stage`,
      `/api/v1/books/${storyCard[1]}`,
    ];
  }

  const truthApply = normalized.match(/^\/api\/v1\/books\/([^/]+)\/truth-proposals\/[^/]+\/apply$/);
  if (truthApply) {
    return [
      `/api/v1/books/${truthApply[1]}/story-card`,
      `/api/v1/books/${truthApply[1]}/stage`,
    ];
  }

  const bookResource = normalized.match(/^\/api\/v1\/books\/([^/]+)$/);
  if (bookResource && bookResource[1] !== "create") {
    return ["/api/v1/books", normalized];
  }

  if (/^\/api\/v1\/daemon\/(start|stop)$/.test(normalized)) {
    return ["/api/v1/daemon"];
  }

  return [];
}

export function invalidateApiPaths(paths: ReadonlyArray<string>): void {
  if (!paths.length || typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent<ApiInvalidateDetail>(API_INVALIDATE_EVENT, {
    detail: { paths: [...new Set(paths)] },
  }));
}

function emitBookBusy(error: StudioApiError): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(BOOK_BUSY_EVENT, { detail: error }));
}

async function readError(res: Response): Promise<StudioApiError> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const json = await res.json() as { error?: unknown };
      if (typeof json.error === "string" && json.error.trim()) {
        return new StudioApiError(localizeKnownRuntimeMessage(json.error), undefined, res.status);
      }
      if (json.error && typeof json.error === "object") {
        const payload = json.error as {
          code?: unknown;
          message?: unknown;
          owner?: BookLockOwnerInfo;
          details?: unknown;
        };
        const message = typeof payload.message === "string" && payload.message.trim()
          ? localizeKnownRuntimeMessage(payload.message)
          : localizeKnownRuntimeMessage(`${res.status} ${res.statusText}`.trim());
        const code = typeof payload.code === "string" ? payload.code : undefined;
        return new StudioApiError(message, code, res.status, payload.owner, payload.details);
      }
    } catch {
      // fall through
    }
  }
  return new StudioApiError(
    localizeKnownRuntimeMessage(`${res.status} ${res.statusText}`.trim()),
    undefined,
    res.status,
  );
}

export async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
  deps?: { readonly fetchImpl?: typeof fetch },
): Promise<T> {
  const url = buildApiUrl(path);
  if (!url) {
    throw new Error("API path is required");
  }

  const fetchImpl = deps?.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, { cache: "no-store", ...init });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (/Failed to fetch|NetworkError/i.test(raw)) {
      throw new StudioApiError(localizeKnownRuntimeMessage(raw));
    }
    throw e;
  }
  const method = String(init.method ?? "GET").toUpperCase();

  if (!res.ok) {
    const error = await readError(res);
    if (error.code === "BOOK_BUSY") emitBookBusy(error);
    if (method === "DELETE" && (res.status === 404 || error.code === "NOT_FOUND")) {
      invalidateApiPaths(deriveInvalidationPaths(path));
    }
    throw error;
  }

  if (res.status === 204) {
    if (method === "DELETE") {
      invalidateApiPaths(deriveInvalidationPaths(path));
    }
    return undefined as T;
  }

  const contentType = res.headers.get("content-type") ?? "";
  let result: T;
  if (!contentType.includes("application/json")) {
    const text = await res.text();
    if (!text.trim()) {
      result = undefined as T;
    } else {
      result = JSON.parse(text) as T;
    }
  } else {
    result = await res.json() as T;
  }

  if (method === "DELETE") {
    invalidateApiPaths(deriveInvalidationPaths(path));
  } else if (method !== "GET" && url.startsWith("/api/v1/author")) {
    invalidateApiPaths(["/api/v1/author"]);
  }
  return result;
}

export function useApi<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const url = buildApiUrl(path);
    if (!url) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const json = await fetchJson<T>(url);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const url = buildApiUrl(path);
    if (!url || typeof window === "undefined") {
      return;
    }

    const handleInvalidate = (event: Event) => {
      const detail = (event as CustomEvent<ApiInvalidateDetail>).detail;
      if (!detail?.paths.includes(url)) return;
      void refetch();
    };

    window.addEventListener(API_INVALIDATE_EVENT, handleInvalidate);
    return () => {
      window.removeEventListener(API_INVALIDATE_EVENT, handleInvalidate);
    };
  }, [path, refetch]);

  return { data, loading, error, refetch, mutate: setData };
}

export async function postApi<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetchJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  invalidateApiPaths(deriveInvalidationPaths(path));
  return result;
}

export async function putApi<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetchJson<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  invalidateApiPaths(deriveInvalidationPaths(path));
  return result;
}
