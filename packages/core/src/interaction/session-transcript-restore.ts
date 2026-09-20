import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { readTranscriptEvents } from "./session-transcript.js";
import {
  BookSessionSchema,
  type BookSession,
  type InteractionMessage,
  type ToolExecution,
  type PlayMode,
} from "./session.js";
import type { MessageEvent, SessionKind, TranscriptEvent } from "./session-transcript-schema.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function contentBlocks(message: Record<string, unknown>): unknown[] {
  return Array.isArray(message.content) ? message.content : [];
}

function hasTextContent(message: Record<string, unknown>): boolean {
  return contentBlocks(message).some(
    (block) =>
      isObject(block) &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.length > 0,
  );
}

function hasToolCallContent(message: Record<string, unknown>): boolean {
  return contentBlocks(message).some(
    (block) => isObject(block) && block.type === "toolCall" && typeof block.id === "string",
  );
}

function toolCallIds(message: Record<string, unknown>): string[] {
  return contentBlocks(message)
    .filter(
      (block): block is Record<string, unknown> =>
        isObject(block) && block.type === "toolCall" && typeof block.id === "string",
    )
    .map((block) => block.id as string);
}

function isThinkingBlock(block: unknown): boolean {
  return isObject(block) && (block.type === "thinking" || block.type === "redacted_thinking");
}

function removeTrailingThinking(message: AgentMessage): AgentMessage {
  if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }

  const content = [...message.content];
  while (content.length > 0 && isThinkingBlock(content[content.length - 1])) {
    content.pop();
  }

  if (content.length === message.content.length) return message;
  return { ...message, content } as AgentMessage;
}

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const TOOL_RESULT_BRIDGE_TEXT = "I have processed the tool results.";
const MAX_RESTORED_DIALOGUE_MESSAGES = 12;
const MAX_RESTORED_TOOL_SUMMARY_ITEMS = 8;
const EXPIRED_SKILL_RESULT_TEXT = "Skill instructions expired after their original turn.";
const RESTORED_HISTORY_BOUNDARY_ZH =
  "[已完成的历史上下文]\n" +
  "以上是已经完成并提交的历史上下文，只能用于回忆，不代表当前轮已经执行了动作。\n" +
  "当前轮必须优先遵循用户接下来输入的最新指令；如果最新输入是提问、讨论或确认，直接回答，不要因为历史工具结果跳过判断或继续执行旧动作。";
const RESTORED_HISTORY_BOUNDARY_EN =
  "[Completed history context]\n" +
  "The messages above are completed and committed history. Use them only as memory; they do not mean any action has already run in the current turn.\n" +
  "For the current turn, prioritize the next user instruction. If it is a question, discussion, or confirmation, answer directly instead of continuing an old tool action.";

function toolResultBridgeMessage(timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: TOOL_RESULT_BRIDGE_TEXT }],
    api: "openai-completions",
    provider: "inkos",
    model: "synthetic-tool-result-bridge",
    usage: emptyUsage,
    stopReason: "stop",
    timestamp,
  } as AgentMessage;
}

function addToolResultBridges(messages: AgentMessage[]): AgentMessage[] {
  const bridged: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    bridged.push(message);

    if (!isObject(message) || message.role !== "toolResult") continue;

    const next = messages[i + 1];
    if (isObject(next) && (next.role === "toolResult" || next.role === "assistant")) continue;

    const timestamp = typeof message.timestamp === "number" ? message.timestamp + 1 : Date.now();
    bridged.push(toolResultBridgeMessage(timestamp));
  }

  return bridged;
}

function systemMessage(content: string, timestamp: number): AgentMessage {
  return {
    role: "system",
    content,
    timestamp,
  } as unknown as AgentMessage;
}

export function appendRestoredHistoryBoundary(
  messages: AgentMessage[],
  language: string,
): AgentMessage[] {
  if (messages.length === 0) return messages;
  const timestamp = messages.reduce((max, message) => {
    if (isObject(message) && typeof message.timestamp === "number") {
      return Math.max(max, message.timestamp);
    }
    return max;
  }, 0) || Date.now();
  return [
    ...messages,
    systemMessage(
      language === "zh" ? RESTORED_HISTORY_BOUNDARY_ZH : RESTORED_HISTORY_BOUNDARY_EN,
      timestamp + 1,
    ),
  ];
}

export function cleanRestoredAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  const availableToolCalls = new Set<string>();
  for (const message of messages) {
    if (isObject(message) && message.role === "assistant") {
      for (const id of toolCallIds(message)) availableToolCalls.add(id);
    }
  }

  const cleaned = messages.filter((message) => {
    if (!isObject(message)) return false;
    if (message.role === "toolResult") {
      return typeof message.toolCallId === "string" && availableToolCalls.has(message.toolCallId);
    }
    if (message.role === "assistant") {
      return hasTextContent(message) || hasToolCallContent(message);
    }
    return message.role === "user" || message.role === "system";
  });

  if (cleaned.length === 0) return cleaned;
  const last = cleaned[cleaned.length - 1];
  if (isObject(last) && last.role === "assistant") {
    cleaned[cleaned.length - 1] = removeTrailingThinking(last);
  }

  return cleaned;
}

interface TargetModelIdentity {
  readonly api?: unknown;
  readonly provider?: unknown;
  readonly id?: unknown;
  readonly compat?: unknown;
}

function requiresAssistantAfterToolResult(target: TargetModelIdentity): boolean {
  return !!(
    target.compat &&
    typeof target.compat === "object" &&
    (target.compat as { requiresAssistantAfterToolResult?: unknown }).requiresAssistantAfterToolResult === true
  );
}

function isSameAssistantModel(message: Record<string, unknown>, target: TargetModelIdentity): boolean {
  return (
    typeof message.api === "string" &&
    typeof message.provider === "string" &&
    typeof message.model === "string" &&
    message.api === target.api &&
    message.provider === target.provider &&
    message.model === target.id
  );
}

export function adaptRestoredAgentMessagesForModel(
  messages: AgentMessage[],
  target: TargetModelIdentity,
): AgentMessage[] {
  const adapted: AgentMessage[] = [];

  const pushToolResultsAsSystem = (toolResults: AgentMessage[]) => {
    const lines = toolResults.flatMap((message) => {
      const raw: Record<string, unknown> = isObject(message) ? message : {};
      const toolName = typeof raw.toolName === "string" ? raw.toolName : "tool";
      const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : "unknown";
      const text = contentBlocks(raw)
        .map((block) => {
          if (isObject(block) && block.type === "text" && typeof block.text === "string") {
            return block.text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim() || "(empty tool result)";
      return [`- ${toolName} (${toolCallId}):`, text];
    });
    const timestamp = toolResults.reduce((max, message) => {
      if (isObject(message) && typeof message.timestamp === "number") {
        return Math.max(max, message.timestamp);
      }
      return max;
    }, 0) || Date.now();
    adapted.push(systemMessage([
      "[Historical tool results]",
      "These are completed historical tool results. They are state context, not a new user request.",
      ...lines,
    ].join("\n"), timestamp));
  };

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!isObject(message)) continue;

    if (message.role === "assistant") {
      const content = contentBlocks(message);
      const isBridge = content.length === 1 &&
        isObject(content[0]) &&
        content[0].type === "text" &&
        typeof content[0].text === "string" &&
        content[0].text.trim() === TOOL_RESULT_BRIDGE_TEXT;
      const previous = adapted[adapted.length - 1];
      const previousRole = isObject(previous)
        ? (previous as Record<string, unknown>).role
        : undefined;
      if (
        isBridge &&
        isObject(previous) &&
        (previousRole === "user" || previousRole === "system") &&
        typeof previous.content === "string" &&
        (previous.content.startsWith("[Tool results]") || previous.content.startsWith("[Historical tool results]"))
      ) {
        continue;
      }

      const contentWithoutThinking = content.filter((block) => !isThinkingBlock(block));
      const foreignToolCallIds = new Set(
        contentWithoutThinking
          .filter(
            (block): block is Record<string, unknown> =>
              isObject(block) && block.type === "toolCall" && typeof block.id === "string",
          )
          .map((block) => block.id as string),
      );

      if (foreignToolCallIds.size === 0) {
        if (Array.isArray(message.content) && isSameAssistantModel(message, target)) {
          adapted.push(message);
          continue;
        }
        const rewritten = contentWithoutThinking.length === content.length
          ? message
          : ({ ...message, content: contentWithoutThinking } as AgentMessage);
        if (
          contentWithoutThinking.some(
            (block) =>
              isObject(block) &&
              block.type === "text" &&
              typeof block.text === "string" &&
              block.text.length > 0,
          )
        ) {
          adapted.push(rewritten);
        }
        continue;
      }

      const textContent = contentWithoutThinking.filter(
        (block): block is { type: "text"; text: string } =>
          isObject(block) &&
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim().length > 0,
      );
      if (textContent.length > 0) {
        adapted.push({ ...message, content: textContent } as AgentMessage);
      }

      const toolResults: AgentMessage[] = [];
      let nextIndex = index + 1;
      while (nextIndex < messages.length) {
        const next = messages[nextIndex];
        if (
          !isObject(next) ||
          next.role !== "toolResult" ||
          typeof next.toolCallId !== "string" ||
          !foreignToolCallIds.has(next.toolCallId)
        ) {
          break;
        }
        toolResults.push(next);
        nextIndex += 1;
      }
      if (toolResults.length > 0) {
        pushToolResultsAsSystem(toolResults);
        index = nextIndex - 1;
      }
      continue;
    }

    if (message.role === "toolResult") {
      pushToolResultsAsSystem([message]);
      continue;
    }

    adapted.push(message);
  }

  const filtered = adapted.filter((message) => {
    if (!isObject(message) || message.role !== "assistant") return true;
    return hasTextContent(message) || hasToolCallContent(message);
  });

  return requiresAssistantAfterToolResult(target)
    ? addToolResultBridges(filtered)
    : filtered;
}

export function committedMessageEvents(events: TranscriptEvent[], sessionKind?: SessionKind): MessageEvent[] {
  const requestKinds = new Map(
    events
      .filter((event) => event.type === "request_started")
      .map((event) => [event.requestId, event.sessionKind]),
  );
  const committed = new Set(
    events
      .filter((event) => event.type === "request_committed")
      .filter((event) => {
        if (!sessionKind) return true;
        const kind = requestKinds.get(event.requestId);
        return kind === undefined || kind === sessionKind;
      })
      .map((event) => event.requestId),
  );

  return events
    .filter((event): event is MessageEvent => event.type === "message" && committed.has(event.requestId))
    .sort((a, b) => a.seq - b.seq);
}

function requestKindMap(events: TranscriptEvent[]): Map<string, SessionKind | undefined> {
  return new Map(
    events
      .filter((event) => event.type === "request_started")
      .map((event) => [event.requestId, event.sessionKind]),
  );
}

function bookCreationMigrationSequence(events: TranscriptEvent[]): number | undefined {
  let beganBookCreation = false;
  for (const event of events) {
    if ((event.type === "session_created" || event.type === "request_started") && event.sessionKind === "book-create") {
      beganBookCreation = true;
    }
    if (beganBookCreation && event.type === "session_metadata_updated"
      && event.sessionKind === "book" && typeof event.bookId === "string" && event.bookId.length > 0) {
      return event.seq;
    }
  }
  return undefined;
}

/** Failed model output is discarded; a submitted author brief is still source material. */
function authoringMessageEvents(events: TranscriptEvent[], sessionKind?: SessionKind): MessageEvent[] {
  const committed = committedMessageEvents(events, sessionKind);
  const present = new Set(committed.map((event) => event.uuid));
  const kinds = requestKindMap(events);
  const migrationSeq = sessionKind === "book" ? bookCreationMigrationSequence(events) : undefined;
  const committedRequests = new Set(committedMessageEvents(events).map((event) => event.requestId));
  const failedRequests = new Set<string>();
  const abortedRequests = new Set<string>();
  let metadataKind: SessionKind | undefined;
  for (const event of events) {
    if ((event.type === "session_created" || event.type === "session_metadata_updated") && event.sessionKind) {
      metadataKind = event.sessionKind;
    }
    if (event.type === "request_started" && !event.sessionKind && metadataKind) kinds.set(event.requestId, metadataKind);
    if (event.type === "request_failed") {
      failedRequests.add(event.requestId);
      if (/\babort(?:ed|error)?\b|\bcancel(?:led|ed|lation)?\b|已取消|用户取消|用户停止/i.test(event.error)) {
        abortedRequests.add(event.requestId);
      }
    }
    if (event.type === "message" && event.role === "assistant" && isObject(event.message)
      && event.message.stopReason === "aborted") abortedRequests.add(event.requestId);
  }
  const recovered = events.filter((event): event is MessageEvent => {
    if (event.type !== "message" || event.role !== "user" || present.has(event.uuid)) return false;
    const kind = kinds.get(event.requestId);
    if (kind !== "book-create" && kind !== "book") return false;
    const migratedAuthorInput = kind === "book-create" && migrationSeq !== undefined && event.seq < migrationSeq;
    if (sessionKind && kind !== sessionKind && !migratedAuthorInput) return false;
    if (committedRequests.has(event.requestId)) return migratedAuthorInput;
    return failedRequests.has(event.requestId) && !abortedRequests.has(event.requestId);
  });
  return [...committed, ...recovered].sort((a, b) => a.seq - b.seq);
}

function textOnlyAgentMessage(event: MessageEvent): AgentMessage | null {
  const raw = event.message as Record<string, unknown>;
  if (!isObject(raw) || event.role === "toolResult") return null;

  if (event.role === "user" || event.role === "system") {
    const content = textFromContent(raw.content);
    return content ? { role: event.role, content, timestamp: event.timestamp } as AgentMessage : null;
  }

  if (event.role === "assistant") {
    const textBlocks = contentBlocks(raw).filter(
      (block): block is { type: "text"; text: string } =>
        isObject(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim().length > 0,
    );
    if (textBlocks.length === 0) return null;
    return {
      ...raw,
      role: "assistant",
      content: textBlocks,
      timestamp: event.timestamp,
    } as AgentMessage;
  }

  return null;
}

function buildHistoricalToolSummary(
  events: TranscriptEvent[],
  sessionKind?: SessionKind,
): AgentMessage | null {
  const kinds = requestKindMap(events);
  const committed = committedMessageEvents(events, sessionKind);
  const calls = new Map<string, { tool: string; agent?: string; timestamp: number }>();
  const summaries: Array<{ timestamp: number; line: string }> = [];

  for (const event of committed) {
    const requestKind = kinds.get(event.requestId);
    if (sessionKind && requestKind !== sessionKind) {
      continue;
    }

    const raw = event.message as Record<string, unknown>;
    if (!isObject(raw)) continue;

    if (event.role === "assistant") {
      for (const block of contentBlocks(raw)) {
        if (!isObject(block) || block.type !== "toolCall") continue;
        const id = typeof block.id === "string" ? block.id : "";
        if (!id) continue;
        const tool = typeof block.name === "string" && block.name ? block.name : "tool";
        const args = isObject(block.arguments) ? block.arguments : undefined;
        const agent = typeof args?.agent === "string" ? args.agent : undefined;
        calls.set(`${event.requestId}\0${id}`, {
          tool,
          ...(agent ? { agent } : {}),
          timestamp: event.timestamp,
        });
      }
      continue;
    }

    if (event.role !== "toolResult") continue;
    const toolCallId = typeof raw.toolCallId === "string"
      ? raw.toolCallId
      : event.toolCallId ?? "";
    const call = calls.get(`${event.requestId}\0${toolCallId}`);
    const tool = typeof raw.toolName === "string" && raw.toolName
      ? raw.toolName
      : call?.tool ?? "tool";
    const agent = call?.agent;
    const status = raw.isError === true ? "failed" : "completed";
    const text = tool === "use_skill"
      ? "expired; instructions are not active for later turns"
      : textFromContent(raw.content).replace(/\s+/g, " ").trim();
    const trimmed = text.length > 180 ? `${text.slice(0, 180)}...` : text;
    summaries.push({
      timestamp: event.timestamp,
      line: `- ${tool}${agent ? `:${agent}` : ""} ${status}${trimmed ? ` — ${trimmed}` : ""}`,
    });
  }

  if (summaries.length === 0) return null;
  const latest = summaries.slice(-MAX_RESTORED_TOOL_SUMMARY_ITEMS);
  const timestamp = latest.reduce((max, item) => Math.max(max, item.timestamp), 0) || Date.now();
  return systemMessage([
    "[历史状态摘要]",
    "以下是已经完成的历史工具动作摘要，只说明当前状态；不是当前用户的新指令，也不表示本轮已经执行。",
    ...latest.map((item) => item.line),
  ].join("\n"), timestamp);
}

function requestIdsWithToolActivity(events: ReadonlyArray<MessageEvent>): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.role === "toolResult") {
      ids.add(event.requestId);
      continue;
    }
    const raw = event.message as Record<string, unknown>;
    if (!isObject(raw)) continue;
    if (contentBlocks(raw).some((block) => isObject(block) && block.type === "toolCall")) {
      ids.add(event.requestId);
    }
  }
  return ids;
}

function requestIdsUsingSkill(events: ReadonlyArray<MessageEvent>): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.role !== "assistant") continue;
    const raw = event.message as Record<string, unknown>;
    if (!isObject(raw)) continue;
    if (contentBlocks(raw).some((block) => (
      isObject(block)
      && block.type === "toolCall"
      && block.name === "use_skill"
    ))) {
      ids.add(event.requestId);
    }
  }
  return ids;
}

export async function restoreAgentMessagesFromTranscript(
  projectRoot: string,
  sessionId: string,
  sessionKind?: SessionKind,
): Promise<AgentMessage[]> {
  const events = await readTranscriptEvents(projectRoot, sessionId);
  const summary = buildHistoricalToolSummary(events, sessionKind);
  const messages = authoringMessageEvents(events, sessionKind);
  const toolRequestIds = requestIdsWithToolActivity(messages);
  const allDialogue = messages
    .filter((event) => {
      if (!toolRequestIds.has(event.requestId)) return true;
      // A tool call (including a failed proposal) must not erase the author's
      // input from that turn. Fold tool output, not the story it was based on.
      return event.role === "user";
    })
    .map((event) => textOnlyAgentMessage(event))
    .filter((message): message is AgentMessage => message !== null);
  const dialogue = allDialogue.slice(-MAX_RESTORED_DIALOGUE_MESSAGES);
  // Keep the original book-create source after clarification and book migration.
  // Ordinary book chats retain their bounded dialogue window.
  const kinds = requestKindMap(events);
  const creationSource = sessionKind === "book" && bookCreationMigrationSequence(events) !== undefined
    ? new Set(messages.filter((event) => event.role === "user" && kinds.get(event.requestId) === "book-create")
      .map((event) => isObject(event.message) ? textFromContent(event.message.content) : ""))
    : new Set<string>();
  const earlierAuthorInput = allDialogue.slice(0, -MAX_RESTORED_DIALOGUE_MESSAGES).filter((message) => (
    message.role === "user" && (sessionKind === "book-create" || creationSource.has(textFromContent(message.content)))
  ));

  return [
    ...(summary ? [summary] : []),
    ...earlierAuthorInput,
    ...dialogue,
  ];
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        isObject(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
}

function thinkingFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const value = content
    .filter((block): block is Record<string, unknown> => isObject(block) && block.type === "thinking")
    .map((block) => typeof block.thinking === "string" ? block.thinking : "")
    .join("");
  return value || undefined;
}

function joinThinking(parts: ReadonlyArray<string | undefined>): string | undefined {
  const values = parts
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0);
  return values.length > 0 ? values.join("\n\n---\n\n") : undefined;
}

function firstUserMessageTitle(messages: InteractionMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const oneLine = message.content.trim().replace(/\s+/g, " ");
    if (!oneLine) return null;
    return oneLine.length > 20 ? `${oneLine.slice(0, 20)}…` : oneLine;
  }
  return null;
}

function messageEventToInteractionMessage(
  event: MessageEvent,
  restoredToolExecutions?: ToolExecution[],
  restoredThinking?: ReadonlyArray<string>,
  options: { suppressAssistantText?: boolean; suppressThinking?: boolean } = {},
): InteractionMessage | null {
  const raw = event.message as Record<string, unknown>;
  if (!isObject(raw)) return null;
  if (event.role === "toolResult") return null;

  if (event.role === "user") {
    const content = textFromContent(raw.content);
    return content ? { role: "user", content, timestamp: event.timestamp } : null;
  }

  if (event.role === "assistant") {
    const rawText = textFromContent(raw.content);
    const content = options.suppressAssistantText ? "" : rawText;
    const thinking = options.suppressThinking
      ? undefined
      : joinThinking([
          ...(restoredThinking ?? []),
          thinkingFromContent(raw.content),
          event.legacyDisplay?.thinking,
          options.suppressAssistantText ? rawText : undefined,
        ]);
    const toolExecutions = restoredToolExecutions?.length
      ? restoredToolExecutions
      : event.legacyDisplay?.toolExecutions as ToolExecution[] | undefined;
    if (!content && !thinking && !toolExecutions?.length) return null;
    if (!content && !toolExecutions?.length) return null;
    return {
      role: "assistant",
      content,
      ...(thinking ? { thinking } : {}),
      ...(toolExecutions?.length ? { toolExecutions } : {}),
      timestamp: event.timestamp,
    };
  }

  if (event.role === "system") {
    const content = textFromContent(raw.content);
    return content ? { role: "system", content, timestamp: event.timestamp } : null;
  }

  return null;
}

function messageEventsToInteractionMessages(events: MessageEvent[]): InteractionMessage[] {
  type RestoredToolCall = {
    id: string;
    tool: string;
    args?: Record<string, unknown>;
    timestamp: number;
  };

  const agentLabels: Record<string, string> = {
    architect: "建书",
    writer: "写作",
    auditor: "审计",
    reviser: "修订",
    exporter: "导出",
  };
  const toolLabels: Record<string, string> = {
    read: "读取文件",
    edit: "编辑文件",
    grep: "搜索",
    ls: "列目录",
    propose_action: "确认动作",
    short_fiction_run: "短篇生产",
    generate_cover: "生成封面",
    play_edit: "编辑互动世界",
    play_start: "启动互动世界",
    play_revise: "重做互动回合",
    play_step: "推进互动世界",
    create_narrative_forecast: "剧情多线推演",
    get_narrative_forecast: "核验剧情推演",
    select_narrative_branch: "采用候选分支",
  };

  const messages: InteractionMessage[] = [];
  const toolCalls = new Map<string, RestoredToolCall>();
  const skillRequestIds = requestIdsUsingSkill(events);
  let pendingToolExecutions: ToolExecution[] = [];
  let pendingThinking: string[] = [];
  let activeRequestId: string | null = null;

  const clearPending = () => {
    pendingToolExecutions = [];
    pendingThinking = [];
  };
  const flushPendingToolExecutions = () => {
    if (pendingToolExecutions.length === 0) return;
    const last = messages[messages.length - 1];
    const thinking = joinThinking(pendingThinking);
    if (last?.role === "assistant") {
      messages[messages.length - 1] = {
        ...last,
        ...(thinking ? { thinking: joinThinking([last.thinking, thinking]) } : {}),
        toolExecutions: [
          ...(last.toolExecutions ?? []),
          ...pendingToolExecutions,
        ],
      };
    } else {
      messages.push({
        role: "assistant",
        content: "",
        ...(thinking ? { thinking } : {}),
        toolExecutions: pendingToolExecutions,
        timestamp: pendingToolExecutions.reduce(
          (latest, execution) => Math.max(latest, execution.completedAt ?? execution.startedAt),
          0,
        ),
      });
    }
    clearPending();
  };
  const toolCallKey = (requestId: string, toolCallId: string): string =>
    `${requestId}\0${toolCallId}`;

  const objectArgs = (value: unknown): Record<string, unknown> | undefined => {
    if (isObject(value)) return value;
    if (typeof value !== "string" || !value.trim()) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      return isObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const resolveToolLabel = (tool: string, agent?: string): string => {
    if (tool === "sub_agent" && agent) return agentLabels[agent] ?? agent;
    return toolLabels[tool] ?? tool;
  };

  const hasCompletedPlayTool = (executions: ReadonlyArray<ToolExecution>): boolean =>
    executions.some((execution) =>
      execution.status === "completed"
      && (execution.tool === "play_start" || execution.tool === "play_step" || execution.tool === "play_revise")
    );

  const rememberToolCalls = (event: MessageEvent, raw: Record<string, unknown>) => {
    for (const block of contentBlocks(raw)) {
      if (!isObject(block) || block.type !== "toolCall") continue;
      if (typeof block.id !== "string" || !block.id) continue;
      const tool = typeof block.name === "string" && block.name ? block.name : "tool";
      const args = objectArgs(block.arguments);
      toolCalls.set(toolCallKey(event.requestId, block.id), {
        id: block.id,
        tool,
        ...(args ? { args } : {}),
        timestamp: event.timestamp,
      });
    }
  };

  const toolExecutionFromResult = (event: MessageEvent): ToolExecution | null => {
    const raw = event.message as Record<string, unknown>;
    if (!isObject(raw)) return null;
    const toolCallId = typeof raw.toolCallId === "string"
      ? raw.toolCallId
      : typeof event.toolCallId === "string"
        ? event.toolCallId
        : "";
    if (!toolCallId) return null;

    const call = toolCalls.get(toolCallKey(event.requestId, toolCallId));
    const tool = typeof raw.toolName === "string" && raw.toolName
      ? raw.toolName
      : call?.tool ?? "tool";
    const args = call?.args;
    const agent = tool === "sub_agent" && typeof args?.agent === "string"
      ? args.agent
      : undefined;
    const text = textFromContent(raw.content).trim();
    const isError = raw.isError === true;
    const details = raw.details;
    const expiredSkill = tool === "use_skill";

    return {
      id: toolCallId,
      tool,
      ...(agent ? { agent } : {}),
      label: resolveToolLabel(tool, agent),
      status: isError ? "error" : "completed",
      ...(args ? { args } : {}),
      ...(isError
        ? { error: text.slice(0, 500) || "Tool execution failed" }
        : expiredSkill
          ? { result: EXPIRED_SKILL_RESULT_TEXT }
          : text
          ? { result: text.slice(0, 200) }
          : {}),
      ...(expiredSkill
        ? { details: { kind: "skill_expired" } }
        : details !== undefined
          ? { details }
          : {}),
      startedAt: call?.timestamp ?? event.timestamp,
      completedAt: event.timestamp,
    };
  };

  for (const event of events) {
    const raw = event.message as Record<string, unknown>;
    if (activeRequestId !== event.requestId) {
      flushPendingToolExecutions();
      activeRequestId = event.requestId;
      clearPending();
    }

    if (event.role === "assistant" && isObject(raw)) {
      rememberToolCalls(event, raw);
      const isSkillRequest = skillRequestIds.has(event.requestId);
      const currentThinking = isSkillRequest ? undefined : thinkingFromContent(raw.content);
      const currentText = textFromContent(raw.content).trim();
      const legacyToolExecutions = event.legacyDisplay?.toolExecutions as ToolExecution[] | undefined;
      const hasLegacyDisplay = !!currentThinking
        || (!isSkillRequest && !!event.legacyDisplay?.thinking)
        || !!legacyToolExecutions?.length;
      if (
        pendingToolExecutions.length > 0
        && !hasCompletedPlayTool(pendingToolExecutions)
        && !currentText
        && !currentThinking
        && !hasToolCallContent(raw)
        && !hasLegacyDisplay
      ) {
        // Empty terminal assistant messages only close the model turn. Keep
        // non-play tool results pending so they attach to the previous prose
        // message; play results are intentionally restored as standalone cards.
        continue;
      }
      const message = messageEventToInteractionMessage(
        event,
        pendingToolExecutions.length > 0 ? pendingToolExecutions : undefined,
        pendingThinking.length > 0 ? pendingThinking : undefined,
        {
          suppressAssistantText: hasCompletedPlayTool(pendingToolExecutions),
          suppressThinking: isSkillRequest,
        },
      );
      if (message) {
        messages.push(message);
        clearPending();
      } else if (hasToolCallContent(raw) && currentThinking) {
        pendingThinking.push(currentThinking);
      }
      continue;
    }

    if (event.role === "toolResult") {
      const execution = toolExecutionFromResult(event);
      if (execution) pendingToolExecutions.push(execution);
      continue;
    }

    clearPending();
    const message = messageEventToInteractionMessage(event);
    if (message) messages.push(message);
  }

  flushPendingToolExecutions();
  return messages;
}

export async function deriveBookSessionFromTranscript(
  projectRoot: string,
  sessionId: string,
): Promise<BookSession | null> {
  const events = await readTranscriptEvents(projectRoot, sessionId);
  if (events.length === 0) return null;

  const created = events.find((event) => event.type === "session_created");
  let bookId = created?.type === "session_created" ? created.bookId : null;
  let sessionKind = created?.type === "session_created" ? created.sessionKind : undefined;
  let playMode: PlayMode | undefined = created?.type === "session_created" ? created.playMode : undefined;
  let title = created?.type === "session_created" ? created.title : null;
  const createdAt = created?.type === "session_created"
    ? created.createdAt
    : events[0]?.timestamp ?? Date.now();
  const latestActivityTimestamp = events.reduce((max, event) => {
    if (event.type === "session_created" || event.type === "session_metadata_updated") {
      return Math.max(max, event.updatedAt);
    }
    return Math.max(max, event.timestamp);
  }, 0);
  let updatedAt = created?.type === "session_created"
    ? created.updatedAt
    : events[events.length - 1]?.timestamp ?? createdAt;
  updatedAt = Math.max(updatedAt, latestActivityTimestamp);

  for (const event of events) {
    if (event.type !== "session_metadata_updated") continue;
    if ("bookId" in event && event.bookId !== undefined) bookId = event.bookId;
    if ("sessionKind" in event && event.sessionKind !== undefined) sessionKind = event.sessionKind;
    if ("playMode" in event && event.playMode !== undefined) playMode = event.playMode;
    if ("title" in event && event.title !== undefined) title = event.title;
    updatedAt = Math.max(updatedAt, event.updatedAt);
  }

  const messages = messageEventsToInteractionMessages(authoringMessageEvents(events));

  if (title === null) {
    title = firstUserMessageTitle(messages);
  }

  return BookSessionSchema.parse({
    sessionId,
    bookId,
    sessionKind,
    playMode,
    title,
    messages,
    draftRounds: [],
    events: [],
    createdAt,
    updatedAt,
  });
}
