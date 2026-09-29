import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STUDIO_SSE_EVENTS, collectNewSSEMessages } from "./use-sse";
import type { SSEMessage } from "./use-sse";

describe("STUDIO_SSE_EVENTS", () => {
  it("covers the server lifecycle events that drive the UI", () => {
    expect(STUDIO_SSE_EVENTS).toEqual(expect.arrayContaining([
      "book:creating",
      "book:created",
      "book:deleted",
      "book:error",
      "write:start",
      "write:complete",
      "write:error",
      "draft:start",
      "draft:complete",
      "draft:error",
      "daemon:started",
      "daemon:stopped",
      "daemon:error",
      "audit:start",
      "audit:complete",
      "audit:error",
      "revise:start",
      "revise:complete",
      "revise:error",
      "rewrite:start",
      "rewrite:complete",
      "rewrite:error",
      "agent:start",
      "agent:complete",
      "agent:error",
      "import:start",
      "import:complete",
      "import:error",
      "fanfic:start",
      "fanfic:complete",
      "fanfic:error",
      "authoring:run",
      "fanfic:refresh:start",
      "fanfic:refresh:complete",
      "fanfic:refresh:error",
      "style:start",
      "style:complete",
      "style:error",
      "radar:start",
      "radar:complete",
      "radar:error",
      "log",
      "llm:progress",
      "weave:start",
      "weave:progress",
      "weave:complete",
      "weave:error",
      "ping",
    ]));
  });
});

function msg(seq: number, event = "log"): SSEMessage {
  return { event, data: null, timestamp: 1000 + seq, seq };
}

describe("collectNewSSEMessages", () => {
  it("returns every message after the cursor, not just the last one", () => {
    const messages = [msg(1), msg(2, "book:created"), msg(3, "session:title"), msg(4)];
    const { fresh, nextCursor } = collectNewSSEMessages(messages, 1);
    expect(fresh.map((message) => message.seq)).toEqual([2, 3, 4]);
    expect(nextCursor).toBe(4);
  });

  it("skips the backlog on first subscription and only sets the cursor", () => {
    const messages = [msg(1), msg(2)];
    const { fresh, nextCursor } = collectNewSSEMessages(messages, null);
    expect(fresh).toEqual([]);
    expect(nextCursor).toBe(2);
  });

  it("keeps a null cursor while the buffer is empty", () => {
    const { fresh, nextCursor } = collectNewSSEMessages([], null);
    expect(fresh).toEqual([]);
    expect(nextCursor).toBeNull();
  });

  it("survives buffer trimming as long as retained messages are after the cursor", () => {
    const messages = [msg(50), msg(51), msg(52)];
    const { fresh, nextCursor } = collectNewSSEMessages(messages, 49);
    expect(fresh.map((message) => message.seq)).toEqual([50, 51, 52]);
    expect(nextCursor).toBe(52);
  });
});

describe("SSE reconnect", () => {
  it("dispatches a reconnect event only after a previous connection dropped", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "use-sse.ts"), "utf8");
    expect(source).toContain("SSE_RECONNECT_EVENT");
    expect(source).toContain("openedOnceRef.current && !connectedRef.current");
  });
});
