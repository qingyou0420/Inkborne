/**
 * Classify local-engine vs upstream failures and keep a short local diagnostic ring.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type EngineFailureKind = "http" | "upstream" | "transient" | "unreachable" | "unknown";

export const ENGINE_CONNECTION_EVENT = "inkborne:engine-connection";
export const SSE_RECONNECT_EVENT = "inkborne:sse-reconnect";
export const ENGINE_HEALTH_PATH = "/api/v1/health";
export const ENGINE_HEALTH_TIMEOUT_MS = 800;
export const READ_RETRY_DELAY_MS = 400;

export const TRANSIENT_CONNECTION_MESSAGE = "请求暂时失败，请重试；若正文已出现可先刷新";
export const ENGINE_UNREACHABLE_MESSAGE = "本地引擎暂时无响应。可点重新连接，不必重启整个应用。";
export const UPSTREAM_FETCH_MESSAGE = "上游服务暂时失败，请稍后重试";

export interface EngineConnectionDetail {
  readonly status: "ready" | "checking" | "unreachable";
  readonly healthOk?: boolean;
  readonly pid?: number;
}

export interface RequestDiagnostic {
  readonly at: string;
  readonly method: string;
  readonly route: string;
  readonly durationMs: number;
  readonly category: EngineFailureKind;
  readonly rawKind: string;
  readonly status?: number;
  readonly healthOk?: boolean;
  readonly runId?: string;
  readonly instancePid?: number;
}

const DIAGNOSTIC_LIMIT = 40;
const diagnostics: RequestDiagnostic[] = [];
const inflightGets = new Map<string, Promise<unknown>>();
const recoveryReads = new Map<string, number>();
const recoveryOpen = new Set<string>();
let connectionStatus: EngineConnectionDetail["status"] = "ready";
let healthInFlight: Promise<{ ok: boolean; pid?: number }> | null = null;

export function routeTemplate(path: string): string {
  return path
    .replace(/[?#].*$/, "")
    .replace(/\/(books|shorts)\/[^/]+/g, "/$1/:id")
    .replace(/\/authoring\/(?:artifacts|reports|runs)\/[^/]+/g, (match) => match.replace(/\/[^/]+$/, "/:id"))
    .replace(/\/chapters\/\d+/g, "/chapters/:n");
}

export function isBrowserNetworkError(raw: string): boolean {
  return /Failed to fetch|NetworkError|Load failed|network error/i.test(raw);
}

export function shouldRetryRead(method: string, attempt: number, kind: EngineFailureKind): boolean {
  return method.toUpperCase() === "GET" && attempt === 0 && kind === "transient";
}

export function applyApiFetchOutcome<T>(
  previous: T | null,
  result: { ok: true; data: T } | { ok: false; error: string },
): { data: T | null; error: string | null } {
  if (result.ok) return { data: result.data, error: null };
  return { data: previous, error: result.error };
}

export function recordRequestDiagnostic(entry: Omit<RequestDiagnostic, "at"> & { at?: string }): void {
  diagnostics.push({
    at: entry.at ?? new Date().toISOString(),
    method: entry.method,
    route: entry.route,
    durationMs: entry.durationMs,
    category: entry.category,
    rawKind: entry.rawKind,
    status: entry.status,
    healthOk: entry.healthOk,
    runId: entry.runId,
    instancePid: entry.instancePid,
  });
  if (diagnostics.length > DIAGNOSTIC_LIMIT) diagnostics.splice(0, diagnostics.length - DIAGNOSTIC_LIMIT);
}

export function listRequestDiagnostics(): ReadonlyArray<RequestDiagnostic> {
  return diagnostics.slice();
}

export function clearRequestDiagnostics(): void {
  diagnostics.length = 0;
}

export function currentEngineConnectionStatus(): EngineConnectionDetail["status"] {
  return connectionStatus;
}

export function emitEngineConnection(detail: EngineConnectionDetail, options?: { readonly force?: boolean }): void {
  if (detail.status === "unreachable") {
    recoveryReads.clear();
    recoveryOpen.clear();
  }
  const changed = connectionStatus !== detail.status;
  connectionStatus = detail.status;
  if (!changed && !options?.force) return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<EngineConnectionDetail>(ENGINE_CONNECTION_EVENT, { detail }));
}

export function connectionReadyShouldRefetch(previous: EngineConnectionDetail["status"], next: EngineConnectionDetail["status"]): boolean {
  return next === "ready" && previous === "unreachable";
}

export function invalidatePathMatches(subscribed: string, paths: ReadonlyArray<string>): boolean {
  return paths.some((path) => {
    if (subscribed === path) return true;
    const subscribedBase = subscribed.split("?")[0] ?? subscribed;
    const pathBase = path.split("?")[0] ?? path;
    return subscribedBase === pathBase && !path.includes("?");
  });
}

export async function mergeInflightGet<T>(url: string, run: () => Promise<T>): Promise<T> {
  const existing = inflightGets.get(url);
  if (existing) return existing as Promise<T>;
  const pending = run().finally(() => { inflightGets.delete(url); });
  inflightGets.set(url, pending);
  return pending;
}

export function hasInflightGet(url: string): boolean {
  return inflightGets.has(url);
}

export function beginRecoveryRead(url: string): boolean {
  const used = recoveryReads.get(url) ?? 0;
  if (used >= 1) return recoveryOpen.has(url) || inflightGets.has(url);
  recoveryReads.set(url, 1);
  recoveryOpen.add(url);
  return true;
}

export function resetRecoveryRead(url: string): void {
  recoveryReads.delete(url);
  recoveryOpen.delete(url);
}

export function endRecoveryRead(url: string): void {
  recoveryOpen.delete(url);
}

export function exportRequestDiagnostics(): string {
  return `${JSON.stringify({ exportedAt: new Date().toISOString(), diagnostics: listRequestDiagnostics() }, null, 2)}\n`;
}

export function downloadRequestDiagnostics(): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([exportRequestDiagnostics()], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = "inkborne-request-diagnostics.json";
  link.click();
  URL.revokeObjectURL(href);
}

async function probeHttpHealth(fetchImpl: typeof fetch, timeoutMs: number): Promise<{ ok: boolean; pid?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(ENGINE_HEALTH_PATH, { cache: "no-store", signal: controller.signal });
    if (!res.ok) return { ok: false };
    const json = await res.json() as { ok?: unknown; pid?: unknown };
    const pid = typeof json.pid === "number" ? json.pid : undefined;
    return { ok: json.ok === true, pid };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export function probeEngineHealth(
  deps?: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number },
): Promise<{ ok: boolean; pid?: number }> {
  if (healthInFlight) return healthInFlight;
  const fetchImpl = deps?.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  if (!fetchImpl) return Promise.resolve({ ok: false });
  const run = probeHttpHealth(fetchImpl, deps?.timeoutMs ?? ENGINE_HEALTH_TIMEOUT_MS)
    .finally(() => { healthInFlight = null; });
  healthInFlight = run;
  return run;
}

export async function classifyNetworkFailure(
  raw: string,
  deps?: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number },
): Promise<{ kind: EngineFailureKind; message: string; healthOk: boolean; pid?: number }> {
  const previous = connectionStatus;
  const health = await probeEngineHealth(deps);
  if (health.ok) {
    if (previous === "unreachable") {
      emitEngineConnection({ status: "ready", healthOk: true, pid: health.pid });
    }
    return { kind: "transient", message: TRANSIENT_CONNECTION_MESSAGE, healthOk: true, pid: health.pid };
  }
  emitEngineConnection({ status: "unreachable", healthOk: false });
  return { kind: "unreachable", message: ENGINE_UNREACHABLE_MESSAGE, healthOk: false };
}

export function classifyHttpFailureMessage(message: string): { kind: EngineFailureKind; message: string } {
  if (isBrowserNetworkError(message)) {
    return { kind: "upstream", message: UPSTREAM_FETCH_MESSAGE };
  }
  return { kind: "http", message };
}
