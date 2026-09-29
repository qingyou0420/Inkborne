import { describe, expect, it } from "vitest";
import type { SSEMessage } from "./use-sse";
import { collectNewSSEMessages } from "./use-sse";
import { bookCreatedRoute } from "./use-session-events";

function msg(event: string, timestamp: number, data: unknown = {}): SSEMessage {
  return { event, timestamp, data, seq: timestamp };
}

describe("collectNewSSEMessages for session events", () => {
  it("returns every event after the cursor instead of only the last one", () => {
    const created = msg("book:created", 1, { sessionId: "s1", bookId: "b1" });
    const complete = msg("agent:complete", 2, { sessionId: "s1" });

    expect(collectNewSSEMessages([created, complete], 0).fresh).toEqual([created, complete]);
    expect(collectNewSSEMessages([created, complete], 2).fresh).toEqual([]);
  });

  it("still sees new events when the SSE ring buffer keeps the same length", () => {
    const old1 = msg("agent:start", 1);
    const old2 = msg("agent:complete", 2);
    const next = msg("book:created", 3, { sessionId: "s1", bookId: "b1" });

    expect(collectNewSSEMessages([old1, old2], 0).fresh).toEqual([old1, old2]);
    expect(collectNewSSEMessages([old2, next], 2).fresh).toEqual([next]);
  });
});

describe("bookCreatedRoute", () => {
  it("lands 建书 in 书房, and 采用并建书 in 问心", () => {
    expect(bookCreatedRoute("book-create", "zui-ci")).toEqual({ page: "book", bookId: "zui-ci" });
    expect(bookCreatedRoute("book-create", "zui-ci", true)).toEqual({ page: "book-ask", bookId: "zui-ci" });
    expect(bookCreatedRoute("book-create", "zui-ci", false, "ask")).toEqual({ page: "book-ask", bookId: "zui-ci" });
    expect(bookCreatedRoute("dashboard", "zui-ci")).toBeNull();
  });
});
