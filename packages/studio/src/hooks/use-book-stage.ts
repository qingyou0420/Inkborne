/**
 * Shared GET /books/:id/stage with a module-level cache so chrome and pages
 * share one request per book / data version. SSE write/weave/book events
 * drop the cache so the next hook read refetches.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useState } from "react";
import type { BookStageView } from "../lib/book-stage";
import { useChatStore } from "../store/chat";
import { fetchJson } from "./use-api";

const cache = new Map<string, { version: number; data: BookStageView }>();
const inflight = new Map<string, Promise<BookStageView | null>>();
let epoch = 0;
const listeners = new Set<() => void>();

export function shouldInvalidateBookStageEvent(event: string, data?: { status?: string } | null): boolean {
  if (event === "authoring:run") {
    return data?.status === "completed" || data?.status === "failed" || data?.status === "partial" || data?.status === "cancelled";
  }
  if (event === "weave:progress" || event === "book:creating") return false;
  return /^(write|weave|book|truth|rewrite|revise):/.test(event);
}

export function invalidateBookStage(bookId?: string): void {
  if (bookId) {
    cache.delete(bookId);
    for (const key of [...inflight.keys()]) {
      if (key.startsWith(`${bookId}@`)) inflight.delete(key);
    }
  } else {
    cache.clear();
    inflight.clear();
  }
  epoch += 1;
  for (const notify of listeners) notify();
}

export function loadBookStage(bookId: string, version: number): Promise<BookStageView | null> {
  const key = `${bookId}@${version}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = fetchJson<BookStageView>(`/books/${encodeURIComponent(bookId)}/stage`)
    .then((data) => {
      // A pre-adoption request may finish after invalidation and a newer read.
      if (inflight.get(key) === promise) cache.set(bookId, { version, data });
      return data;
    })
    .catch(() => null)
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

export function useBookStage(bookId: string | undefined): BookStageView | null {
  const version = useChatStore((state) => state.bookDataVersion);
  const cached = bookId ? cache.get(bookId) : undefined;
  const [data, setData] = useState<BookStageView | null>(
    cached && cached.version === version ? cached.data : null,
  );
  const [tick, setTick] = useState(epoch);

  useEffect(() => {
    const onInvalidate = () => setTick(epoch);
    listeners.add(onInvalidate);
    return () => {
      listeners.delete(onInvalidate);
    };
  }, []);

  useEffect(() => {
    if (!bookId) {
      setData(null);
      return;
    }
    const hit = cache.get(bookId);
    if (hit && hit.version === version) {
      setData(hit.data);
      return;
    }
    let cancelled = false;
    void loadBookStage(bookId, version).then((next) => {
      if (!cancelled) setData(next);
    });
    return () => {
      cancelled = true;
    };
  }, [bookId, version, tick]);

  return data;
}
