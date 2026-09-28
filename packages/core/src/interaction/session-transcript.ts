import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { TranscriptEventSchema, type TranscriptEvent } from "./session-transcript-schema.js";
import type { SessionKind, TranscriptRole } from "./session-transcript-schema.js";

const SESSIONS_DIR = ".inkos/sessions";
const appendQueues = new Map<string, Promise<void>>();

export function sessionsDir(projectRoot: string): string {
  return join(projectRoot, SESSIONS_DIR);
}

export function transcriptPath(projectRoot: string, sessionId: string): string {
  return join(sessionsDir(projectRoot), `${sessionId}.jsonl`);
}

export function legacyBookSessionPath(projectRoot: string, sessionId: string): string {
  return join(sessionsDir(projectRoot), `${sessionId}.json`);
}

export async function readTranscriptEvents(
  projectRoot: string,
  sessionId: string,
): Promise<TranscriptEvent[]> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath(projectRoot, sessionId), "utf-8");
  } catch {
    return [];
  }

  const events: TranscriptEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = TranscriptEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) events.push(parsed.data);
    } catch {
      continue;
    }
  }

  return events.sort((a, b) => a.seq - b.seq);
}

export async function nextTranscriptSeq(projectRoot: string, sessionId: string): Promise<number> {
  return (await readLastTranscriptSeq(projectRoot, sessionId)) + 1;
}

export async function appendTranscriptEvent(
  projectRoot: string,
  event: TranscriptEvent,
): Promise<void> {
  await appendTranscriptEvents(projectRoot, event.sessionId, () => [event]);
}

export async function appendTranscriptEvents(
  projectRoot: string,
  sessionId: string,
  buildEvents: (context: {
    readonly events: ReadonlyArray<TranscriptEvent>;
    readonly nextSeq: number;
  }) => ReadonlyArray<TranscriptEvent> | Promise<ReadonlyArray<TranscriptEvent>>,
): Promise<TranscriptEvent[]> {
  const key = `${projectRoot}:${sessionId}`;
  const previous = appendQueues.get(key) ?? Promise.resolve();
  let result: TranscriptEvent[] = [];

  const next = previous.then(async () => {
    const needsEvents = callbackReadsEvents(buildEvents);
    const events = needsEvents ? await readTranscriptEvents(projectRoot, sessionId) : [];
    const lastSeq = needsEvents
      ? events.reduce((max, event) => Math.max(max, event.seq), 0)
      : await readLastTranscriptSeq(projectRoot, sessionId);
    const nextSeq = lastSeq + 1;
    const built = await buildEvents({ events, nextSeq });
    result = built.map((event) => TranscriptEventSchema.parse(event));
    if (result.length === 0) {
      if (needsEvents) await writeLastTranscriptSeq(projectRoot, sessionId, lastSeq);
      return;
    }

    const maxSeq = result.reduce((max, event) => Math.max(max, event.seq), lastSeq);
    await mkdir(sessionsDir(projectRoot), { recursive: true });
    // Claim the sequence before the append so a crash cannot reuse it.
    await writeLastTranscriptSeq(projectRoot, sessionId, maxSeq);
    await appendFile(
      transcriptPath(projectRoot, sessionId),
      `${result.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf-8",
    );
  });

  appendQueues.set(key, next.catch(() => undefined));
  await next;
  return result;
}

function seqPath(projectRoot: string, sessionId: string): string {
  return join(sessionsDir(projectRoot), `${sessionId}.seq`);
}

function callbackReadsEvents(buildEvents: { toString(): string }): boolean {
  const source = Function.prototype.toString.call(buildEvents);
  if (!source || source.includes("[native code]")) return true;
  return /\bevents\b/.test(source);
}

async function readLastTranscriptSeq(projectRoot: string, sessionId: string): Promise<number> {
  try {
    const raw = await readFile(seqPath(projectRoot, sessionId), "utf-8");
    const seq = Number(raw.trim());
    if (Number.isInteger(seq) && seq >= 0) return seq;
  } catch {
    // Sidecar is missing until the next append, or this session only has a jsonl.
  }
  return readLastSeqFromTail(projectRoot, sessionId);
}

async function writeLastTranscriptSeq(projectRoot: string, sessionId: string, seq: number): Promise<void> {
  await mkdir(sessionsDir(projectRoot), { recursive: true });
  await writeFile(seqPath(projectRoot, sessionId), `${seq}\n`, "utf-8");
}

async function readLastSeqFromTail(projectRoot: string, sessionId: string): Promise<number> {
  const path = transcriptPath(projectRoot, sessionId);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (info.size === 0) return 0;
    const chunkSize = Math.min(info.size, 256 * 1024);
    const buffer = Buffer.alloc(chunkSize);
    await handle.read(buffer, 0, chunkSize, info.size - chunkSize);
    let text = buffer.toString("utf8");
    if (info.size > chunkSize) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { seq?: unknown };
        if (typeof parsed.seq === "number" && Number.isInteger(parsed.seq) && parsed.seq >= 0) {
          return parsed.seq;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return 0;
  } finally {
    await handle?.close();
  }
  const events = await readTranscriptEvents(projectRoot, sessionId);
  return events.reduce((max, event) => Math.max(max, event.seq), 0);
}

function transcriptRoleForMessage(message: AgentMessage): TranscriptRole | null {
  if (!message || typeof message !== "object" || !("role" in message)) return null;
  const role = (message as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "toolResult" || role === "system"
    ? role
    : null;
}

function messageTimestamp(message: AgentMessage): number {
  if (message && typeof message === "object") {
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0) {
      return Math.floor(timestamp);
    }
  }
  return Date.now();
}

function toolCallIdForMessage(message: AgentMessage): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  if ((message as { role?: unknown }).role === "toolResult") {
    const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
    return typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : undefined;
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find(
    (item): item is { type: "toolCall"; id: string } =>
      !!item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "toolCall" &&
      typeof (item as { id?: unknown }).id === "string",
  );
  return block?.id;
}

export async function appendManualSessionMessages(
  projectRoot: string,
  sessionId: string,
  messages: ReadonlyArray<AgentMessage>,
  input = "",
  options: {
    readonly sessionKind?: SessionKind;
    readonly legacyDisplay?: {
      readonly thinking?: string;
      readonly toolExecutions?: readonly unknown[];
    };
  } = {},
): Promise<void> {
  const persistedMessages = messages
    .map((message) => ({ message, role: transcriptRoleForMessage(message) }))
    .filter((entry): entry is { message: AgentMessage; role: TranscriptRole } => entry.role !== null);
  if (persistedMessages.length === 0) return;

  const requestId = randomUUID();
  await appendTranscriptEvents(projectRoot, sessionId, ({ nextSeq }) => {
    let seq = nextSeq;
    const events: TranscriptEvent[] = [{
      type: "request_started",
      version: 1,
      sessionId,
      requestId,
      seq: seq++,
      timestamp: Date.now(),
      ...(options.sessionKind ? { sessionKind: options.sessionKind } : {}),
      input,
    }];

    let parentUuid: string | null = null;
    let lastAssistantUuid: string | null = null;
    for (const { message, role } of persistedMessages) {
      const uuid = randomUUID();
      const isToolResult = role === "toolResult";
      const toolCallId = toolCallIdForMessage(message);
      const legacyDisplay = role === "assistant" && options.legacyDisplay
        ? {
            ...(options.legacyDisplay.thinking ? { thinking: options.legacyDisplay.thinking } : {}),
            ...(options.legacyDisplay.toolExecutions?.length
              ? { toolExecutions: [...options.legacyDisplay.toolExecutions] }
              : {}),
          }
        : undefined;
      events.push({
        type: "message",
        version: 1,
        sessionId,
        requestId,
        uuid,
        parentUuid: isToolResult && lastAssistantUuid ? lastAssistantUuid : parentUuid,
        seq: seq++,
        role,
        timestamp: messageTimestamp(message),
        ...(toolCallId ? { toolCallId } : {}),
        ...(isToolResult && lastAssistantUuid
          ? { sourceToolAssistantUuid: lastAssistantUuid }
          : {}),
        ...(legacyDisplay && (legacyDisplay.thinking || legacyDisplay.toolExecutions?.length)
          ? { legacyDisplay }
          : {}),
        message,
      });
      if (role === "assistant") lastAssistantUuid = uuid;
      parentUuid = uuid;
    }

    events.push({
      type: "request_committed",
      version: 1,
      sessionId,
      requestId,
      seq,
      timestamp: Date.now(),
    });
    return events;
  });
}
