import { useEffect, useRef, useCallback, useState } from "react";
import { SSE_RECONNECT_EVENT } from "../lib/engine-connection";

export interface SSEMessage {
  readonly event: string;
  readonly data: unknown;
  readonly timestamp: number;
  /** Monotonic sequence for cursor-based consumers; survives ring-buffer trimming. */
  readonly seq: number;
}

export const STUDIO_SSE_EVENTS = [
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
  "daemon:chapter",
  "daemon:started",
  "daemon:stopped",
  "daemon:error",
  "agent:start",
  "agent:complete",
  "agent:error",
  "session:title",
  "audit:start",
  "audit:complete",
  "audit:error",
  "revise:start",
  "revise:complete",
  "revise:error",
  "rewrite:start",
  "rewrite:complete",
  "rewrite:error",
  "style:start",
  "style:complete",
  "style:error",
  "import:start",
  "import:complete",
  "import:error",
  "fanfic:start",
  "fanfic:complete",
  "fanfic:error",
  "fanfic:refresh:start",
  "fanfic:refresh:complete",
  "fanfic:refresh:error",
  "draft:delta",
  "radar:start",
  "radar:complete",
  "radar:error",
  "log",
  "llm:progress",
  "weave:start",
  "weave:progress",
  "weave:complete",
  "weave:error",
  "authoring:run",
  "ping",
] as const;

export function collectNewSSEMessages(
  messages: ReadonlyArray<SSEMessage>,
  cursor: number | null,
): { readonly fresh: ReadonlyArray<SSEMessage>; readonly nextCursor: number | null } {
  if (messages.length === 0) return { fresh: [], nextCursor: cursor };
  const latest = messages[messages.length - 1]!.seq;
  if (cursor === null) return { fresh: [], nextCursor: latest };
  if (latest <= cursor) return { fresh: [], nextCursor: cursor };
  return { fresh: messages.filter((message) => message.seq > cursor), nextCursor: latest };
}

export function useNewSSEMessages(
  messages: ReadonlyArray<SSEMessage>,
  handler: (message: SSEMessage) => void,
): void {
  const cursorRef = useRef<number | null>(null);

  useEffect(() => {
    const { fresh, nextCursor } = collectNewSSEMessages(messages, cursorRef.current);
    cursorRef.current = nextCursor;
    for (const message of fresh) {
      handler(message);
    }
  }, [handler, messages]);
}

export function useSSE(url = "/api/v1/events") {
  const [messages, setMessages] = useState<ReadonlyArray<SSEMessage>>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const seqRef = useRef(0);
  const openedOnceRef = useRef(false);
  const connectedRef = useRef(false);

  useEffect(() => {
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      const reconnect = openedOnceRef.current && !connectedRef.current;
      connectedRef.current = true;
      openedOnceRef.current = true;
      setConnected(true);
      if (reconnect && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(SSE_RECONNECT_EVENT));
      }
    };
    es.onerror = () => {
      connectedRef.current = false;
      setConnected(false);
    };

    const handleEvent = (e: MessageEvent) => {
      try {
        const data = e.data ? JSON.parse(e.data) : null;
        // Compute outside the state updater: React StrictMode may invoke
        // updaters twice to verify purity.
        seqRef.current += 1;
        const message: SSEMessage = { event: e.type, data, timestamp: Date.now(), seq: seqRef.current };
        setMessages((prev) => [...prev.slice(-99), message]);
      } catch {
        // ignore parse errors
      }
    };

    for (const event of STUDIO_SSE_EVENTS) {
      es.addEventListener(event, handleEvent);
    }

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [url]);

  const clear = useCallback(() => setMessages([]), []);

  return { messages, connected, clear };
}
