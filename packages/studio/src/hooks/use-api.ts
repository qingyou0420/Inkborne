import { useState, useEffect, useCallback, useRef } from "react";
import { localizeKnownRuntimeMessage } from "../lib/error-copy";
import {
  ENGINE_CONNECTION_EVENT,
  READ_RETRY_DELAY_MS,
  SSE_RECONNECT_EVENT,
  beginRecoveryRead,
  classifyHttpFailureMessage,
  classifyNetworkFailure,
  connectionReadyShouldRefetch,
  currentEngineConnectionStatus,
  endRecoveryRead,
  invalidatePathMatches,
  isBrowserNetworkError,
  mergeInflightGet,
  recordRequestDiagnostic,
  resetRecoveryRead,
  routeTemplate,
  shouldRetryRead,
  type EngineConnectionDetail,
  type EngineFailureKind,
} from "../lib/engine-connection";

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
  kind: EngineFailureKind = "unknown";
  healthOk?: boolean;
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

  const bookCover = normalized.match(/^\/api\/v1\/books\/([^/]+)\/cover$/);
  if (bookCover) {
    return ["/api/v1/books", `/api/v1/books/${bookCover[1]}`];
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
        const classified = classifyHttpFailureMessage(json.error);
        const error = new StudioApiError(
          classified.kind === "upstream" ? classified.message : localizeKnownRuntimeMessage(json.error),
          undefined,
          res.status,
        );
        error.kind = classified.kind;
        return error;
      }
      if (json.error && typeof json.error === "object") {
        const payload = json.error as {
          code?: unknown;
          message?: unknown;
          owner?: BookLockOwnerInfo;
          details?: unknown;
        };
        const rawMessage = typeof payload.message === "string" && payload.message.trim()
          ? payload.message
          : `${res.status} ${res.statusText}`.trim();
        const classified = classifyHttpFailureMessage(rawMessage);
        const message = classified.kind === "upstream"
          ? classified.message
          : localizeKnownRuntimeMessage(rawMessage);
        const code = typeof payload.code === "string" ? payload.code : undefined;
        const error = new StudioApiError(message, code, res.status, payload.owner, payload.details);
        error.kind = classified.kind;
        return error;
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
  const method = String(init.method ?? "GET").toUpperCase();
  if (method === "GET") {
    return mergeInflightGet(url, () => fetchJsonUnmerged<T>(url, init, { fetchImpl }));
  }
  return fetchJsonUnmerged<T>(url, init, { fetchImpl });
}

async function fetchJsonUnmerged<T>(
  url: string,
  init: RequestInit,
  deps: { readonly fetchImpl: typeof fetch },
): Promise<T> {
  const fetchImpl = deps.fetchImpl;
  const method = String(init.method ?? "GET").toUpperCase();
  const started = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(url, { cache: "no-store", ...init });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (isBrowserNetworkError(raw)) {
      const classified = await classifyNetworkFailure(raw, { fetchImpl });
      recordRequestDiagnostic({
        method,
        route: routeTemplate(url),
        durationMs: Date.now() - started,
        category: classified.kind,
        rawKind: e instanceof Error ? e.name : "Error",
        healthOk: classified.healthOk,
        instancePid: classified.pid,
      });
      const error = new StudioApiError(classified.message);
      error.kind = classified.kind;
      error.healthOk = classified.healthOk;
      throw error;
    }
    throw e;
  }

  if (!res.ok) {
    const error = await readError(res);
    recordRequestDiagnostic({
      method,
      route: routeTemplate(url),
      durationMs: Date.now() - started,
      category: error.kind,
      rawKind: `http-${res.status}`,
      status: res.status,
    });
    if (error.code === "BOOK_BUSY") emitBookBusy(error);
    if (method === "DELETE" && (res.status === 404 || error.code === "NOT_FOUND")) {
      invalidateApiPaths(deriveInvalidationPaths(url));
    }
    throw error;
  }

  if (res.status === 204) {
    if (method === "DELETE") {
      invalidateApiPaths(deriveInvalidationPaths(url));
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
    invalidateApiPaths(deriveInvalidationPaths(url));
  } else if (method !== "GET" && url.startsWith("/api/v1/author")) {
    invalidateApiPaths(["/api/v1/author"]);
  } else if (method !== "GET" && /\/books\/[^/]+\/cover$/.test(url)) {
    invalidateApiPaths(deriveInvalidationPaths(url));
  }
  return result;
}

async function readJsonWithRetry<T>(url: string): Promise<T> {
  try {
    return await fetchJson<T>(url);
  } catch (cause) {
    const kind = cause instanceof StudioApiError ? cause.kind : "unknown";
    if (!shouldRetryRead("GET", 0, kind)) throw cause;
    await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAY_MS));
    return fetchJson<T>(url);
  }
}

export function shouldReuseInflightRefetch(input: {
  readonly inflightUrl?: string;
  readonly nextUrl: string;
  readonly inflightGeneration?: number;
  readonly currentGeneration: number;
}): boolean {
  return Boolean(
    input.inflightUrl
    && input.inflightUrl === input.nextUrl
    && input.inflightGeneration === input.currentGeneration
  );
}

export function shouldCommitApiResult(
  requestedUrl: string,
  currentUrl: string | null,
  generation: number,
  currentGeneration: number,
): boolean {
  return generation === currentGeneration && currentUrl === requestedUrl;
}

export function useApi<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dataRef = useRef<T | null>(null);
  dataRef.current = data;
  const errorRef = useRef<string | null>(null);
  errorRef.current = error;
  const refetchInflight = useRef<{ url: string; job: Promise<void>; generation: number } | null>(null);
  const generationRef = useRef(0);
  const requestedUrlRef = useRef<string | null>(null);

  const refetch = useCallback(async () => {
    const url = buildApiUrl(path);
    if (!url) {
      generationRef.current += 1;
      requestedUrlRef.current = null;
      refetchInflight.current = null;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (
      refetchInflight.current
      && shouldReuseInflightRefetch({
        inflightUrl: refetchInflight.current.url,
        nextUrl: url,
        inflightGeneration: refetchInflight.current.generation,
        currentGeneration: generationRef.current,
      })
    ) {
      return refetchInflight.current.job;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const pathChanged = requestedUrlRef.current !== url;
    requestedUrlRef.current = url;
    if (!dataRef.current || pathChanged) setLoading(true);
    const job = (async () => {
      try {
        const json = await readJsonWithRetry<T>(url);
        if (!shouldCommitApiResult(url, requestedUrlRef.current, generation, generationRef.current)) return;
        if (errorRef.current) {
          recordRequestDiagnostic({
            method: "GET",
            route: routeTemplate(url),
            durationMs: 0,
            category: "transient",
            rawKind: "recovery",
            healthOk: true,
          });
        }
        resetRecoveryRead(url);
        setData(json);
        setError(null);
      } catch (e) {
        if (!shouldCommitApiResult(url, requestedUrlRef.current, generation, generationRef.current)) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (shouldCommitApiResult(url, requestedUrlRef.current, generation, generationRef.current)) {
          setLoading(false);
        }
        endRecoveryRead(url);
      }
    })();
    refetchInflight.current = { url, job, generation };
    try {
      await job;
    } finally {
      if (refetchInflight.current?.job === job) refetchInflight.current = null;
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
      if (!detail?.paths || !invalidatePathMatches(url, detail.paths)) return;
      void refetch();
    };

    window.addEventListener(API_INVALIDATE_EVENT, handleInvalidate);
    return () => {
      window.removeEventListener(API_INVALIDATE_EVENT, handleInvalidate);
    };
  }, [path, refetch]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const previous = { status: currentEngineConnectionStatus() };
    const handleConnection = (event: Event) => {
      const status = (event as CustomEvent<EngineConnectionDetail>).detail?.status;
      if (!status) return;
      const should = connectionReadyShouldRefetch(previous.status, status);
      previous.status = status;
      if (!should) return;
      const url = buildApiUrl(path);
      if (!url || !beginRecoveryRead(url)) return;
      void refetch();
    };
    const handleSseReconnect = () => {
      const url = buildApiUrl(path);
      if (!url || !beginRecoveryRead(url)) return;
      void refetch();
    };
    window.addEventListener(ENGINE_CONNECTION_EVENT, handleConnection);
    window.addEventListener(SSE_RECONNECT_EVENT, handleSseReconnect);
    return () => {
      window.removeEventListener(ENGINE_CONNECTION_EVENT, handleConnection);
      window.removeEventListener(SSE_RECONNECT_EVENT, handleSseReconnect);
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
