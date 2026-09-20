/**
 * Poll a four-stage authoring run after a wait=false start.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useState } from "react";
import { fetchJson, StudioApiError } from "./use-api";
import { pollWeaveRun } from "../lib/weave-editor-state";

export const AUTHORING_RUN_NOT_FOUND_LIMIT = 10;

export function keepPollingAuthoringRunError(cause: unknown, consecutiveErrors: number): boolean {
  const missing = cause instanceof StudioApiError && cause.status === 404;
  return !(missing && consecutiveErrors >= AUTHORING_RUN_NOT_FOUND_LIMIT);
}

export interface AuthoringRunView {
  readonly runId: string;
  readonly status: string;
  readonly stage?: string;
  readonly operation?: string;
  readonly progressDone?: number;
  readonly progressTotal?: number;
  readonly progressLabel?: string;
  readonly error?: string;
  readonly createdAt?: string;
  readonly producedArtifactIds?: ReadonlyArray<string>;
  readonly reportId?: string;
  readonly scope?: string;
}

export function isAuthoringRunActive(status?: string): boolean {
  return status === "running" || status === "pausing";
}

export function isAuthoringRunSettled(status?: string): boolean {
  return status === "completed" || status === "partial" || status === "failed" || status === "cancelled" || status === "paused";
}

export function isBackgroundAuthoringStart(result: { runId?: string; status?: string; artifactId?: string; reportId?: string }): boolean {
  return Boolean(result.runId && result.status === "running" && !result.artifactId && !result.reportId);
}

export function formatAuthoringRunElapsed(createdAt?: string, now = Date.now()): string {
  if (!createdAt) return "";
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) return "";
  const sec = Math.max(0, Math.floor((now - parsed) / 1000));
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

export function useAuthoringRun(
  bookId: string | undefined,
  runId: string | null,
  draftId?: string,
): {
  readonly run: AuthoringRunView | null;
  readonly error: string | null;
  readonly elapsed: string;
  readonly active: boolean;
  readonly settled: boolean;
  readonly retry: () => void;
} {
  const [run, setRun] = useState<AuthoringRunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!runId || (!bookId && !draftId)) {
      setRun(null);
      setError(null);
      return undefined;
    }
    const query = bookId
      ? `bookId=${encodeURIComponent(bookId)}`
      : `draftId=${encodeURIComponent(draftId ?? "")}`;
    return pollWeaveRun({
      read: () => fetchJson<AuthoringRunView>(`/authoring/runs/${encodeURIComponent(runId)}?${query}`),
      update: (next) => {
        setRun(next);
        setError(null);
      },
      error: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
      settled: async () => undefined,
      keepPollingOnError: keepPollingAuthoringRunError,
    });
  }, [bookId, draftId, runId, epoch]);

  useEffect(() => {
    if (!run || !isAuthoringRunActive(run.status)) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run]);

  return {
    run,
    error,
    elapsed: formatAuthoringRunElapsed(run?.createdAt, now),
    active: isAuthoringRunActive(run?.status),
    settled: Boolean(run && isAuthoringRunSettled(run.status)),
    retry: () => setEpoch((value) => value + 1),
  };
}
