/**
 * Read a 落笔 SSE response: start, text deltas, then done or error.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  BOOK_BUSY_EVENT,
  StudioApiError,
  buildApiUrl,
  deriveInvalidationPaths,
  invalidateApiPaths,
} from "../hooks/use-api";
import type { TokenUsage } from "./token-usage";

export interface AuthoringStreamResult {
  readonly artifactId: string;
  readonly runId: string;
  readonly body: string;
  readonly wordCount: number;
  readonly status?: "completed" | "cancelled";
  readonly lengthNote?: string;
  readonly targetWordCount?: number;
  readonly usage?: TokenUsage;
  readonly version?: number;
}

export async function readAuthoringSse(
  response: Response,
  hooks: {
    readonly onStart?: (runId: string) => void;
    readonly onDelta?: (delta: string) => void;
  },
): Promise<AuthoringStreamResult> {
  if (!response.ok) {
    throw new StudioApiError(`写作没有开始（${response.status}）`, undefined, response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("写作没有返回正文");
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AuthoringStreamResult | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      let event = "message";
      const dataLines: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
      if (event === "start" && typeof data.runId === "string") hooks.onStart?.(data.runId);
      if (event === "delta" && typeof data.delta === "string") hooks.onDelta?.(data.delta);
      if (event === "error") {
        const code = typeof data.code === "string" ? data.code : undefined;
        const message = typeof data.message === "string" ? data.message : "写作中断了";
        const error = new StudioApiError(message, code, code === "BOOK_BUSY" ? 409 : 500, data.owner as StudioApiError["owner"]);
        if (code === "BOOK_BUSY" && typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent(BOOK_BUSY_EVENT, { detail: error }));
        }
        throw error;
      }
      if (event === "done") result = data as unknown as AuthoringStreamResult;
    }
  }
  if (!result) throw new Error("写作结束时没有带回正文");
  return result;
}

export async function postAuthoringStream(
  path: string,
  body: unknown,
  hooks: {
    readonly onStart?: (runId: string) => void;
    readonly onDelta?: (delta: string) => void;
  },
): Promise<AuthoringStreamResult> {
  const url = buildApiUrl(path);
  if (!url) throw new Error("写作地址不对");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const result = await readAuthoringSse(response, hooks);
  invalidateApiPaths(deriveInvalidationPaths(path));
  return result;
}
