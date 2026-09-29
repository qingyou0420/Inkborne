import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type Message, type Model } from "@mariozechner/pi-ai";
import { appendTranscriptEvent, appendTranscriptEvents } from "../interaction/session-transcript.js";
import { createAndPersistBookSession, deleteBookSession, loadBookSession, migrateBookSession } from "../interaction/book-session-store.js";
import {
  adaptRestoredAgentMessagesForModel,
  appendRestoredHistoryBoundary,
  deriveBookSessionFromTranscript,
  restoreAgentMessagesFromTranscript,
  TOOL_RESULT_BRIDGE_TEXT,
} from "../interaction/session-transcript-restore.js";
import type { MessageEvent, SessionKind } from "../interaction/session-transcript-schema.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("session transcript restore", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-restore-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function appendRecoveryTurn(input: {
    requestId: string; kind: SessionKind; text: string;
    terminal: "request_failed" | "request_committed" | "unfinished";
    error?: string; assistantAborted?: boolean;
  }) {
    await appendTranscriptEvents(projectRoot, "s-recover", ({ nextSeq }) => {
      const base = { version: 1 as const, sessionId: "s-recover", requestId: input.requestId };
      const toolId = `tool-${input.requestId}`;
      return [
        { ...base, type: "request_started", seq: nextSeq, timestamp: nextSeq, sessionKind: input.kind, input: input.text },
        {
          ...base, type: "message", seq: nextSeq + 1, timestamp: nextSeq + 1, uuid: `u-${input.requestId}`, parentUuid: null, role: "user",
          message: { role: "user", content: input.text, timestamp: nextSeq + 1 },
        },
        {
          ...base, type: "message", seq: nextSeq + 2, timestamp: nextSeq + 2, uuid: `a-${input.requestId}`, parentUuid: `u-${input.requestId}`, role: "assistant",
          message: {
            role: "assistant", content: [
              { type: "text", text: "FAILED_ASSISTANT_MUST_NOT_REPLAY" },
              { type: "toolCall", id: toolId, name: "propose_action", arguments: { wrong: "FAILED_TOOL_ARGUMENT" } },
            ], api: "openai-completions", provider: "openai", model: "synthetic", usage,
            stopReason: input.assistantAborted ? "aborted" : "toolUse", timestamp: nextSeq + 2,
          },
        },
        {
          ...base, type: "message", seq: nextSeq + 3, timestamp: nextSeq + 3, uuid: `t-${input.requestId}`, parentUuid: `a-${input.requestId}`, role: "toolResult",
          message: { role: "toolResult", toolCallId: toolId, toolName: "propose_action", isError: true, content: [{ type: "text", text: "FAILED_TOOL_RESULT" }], timestamp: nextSeq + 3 },
        },
        ...(input.terminal === "unfinished" ? [] : input.terminal === "request_failed" ? [{
          ...base, type: "request_failed" as const, seq: nextSeq + 4, timestamp: nextSeq + 4,
          error: input.error ?? "Tool validation retries exhausted",
        }] : [{ ...base, type: "request_committed" as const, seq: nextSeq + 4, timestamp: nextSeq + 4 }]),
      ];
    });
  }

  it.each(["book", "book-create"] as const)("retains failed %s author input in SDK retry and loadBookSession without replaying failed output", async (kind) => {
    await createAndPersistBookSession(projectRoot, kind === "book" ? "existing-book" : null, "s-recover", kind);
    const authorText = "合成原文：柳吟寻找家书，保持女主限知。" + "夜".repeat(4200) + "终章保留作者的结局。";
    await appendRecoveryTurn({ requestId: "failed", kind, text: authorText, terminal: "request_failed" });
    const restored = await restoreAgentMessagesFromTranscript(projectRoot, "s-recover", kind);
    expect(restored).toMatchObject([{ role: "user", content: authorText }]);
    const loaded = await loadBookSession(projectRoot, "s-recover");
    expect(loaded?.messages.map((message) => ({ role: message.role, content: message.content }))).toEqual([{ role: "user", content: authorText }]);
    expect(JSON.stringify(loaded)).not.toContain("FAILED_");

    const model: Model<Api> = {
      id: "retry-model", name: "Offline retry", api: "openai-completions", provider: "openai",
      baseUrl: "https://unused.invalid/v1", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 100,
    };
    const calls: Message[][] = [];
    const agent = new Agent({
      initialState: { model, messages: adaptRestoredAgentMessagesForModel(restored, model) },
      streamFn: (_model, context) => {
        calls.push(context.messages);
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message: {
          role: "assistant", content: [{ type: "text", text: "依据原文重试。" }],
          api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 100,
        } });
        return stream;
      },
    });
    await agent.prompt("保留刚才约定，再试一次。");
    expect(calls[0]).toContainEqual(expect.objectContaining({ role: "user", content: authorText }));
    expect(JSON.stringify(calls)).not.toContain("FAILED_");
    await appendRecoveryTurn({ requestId: "retry", kind, text: "保留刚才约定，再试一次。", terminal: "request_committed" });
    expect((await loadBookSession(projectRoot, "s-recover"))?.messages[0]?.content).toBe(authorText);
    expect(JSON.stringify(await restoreAgentMessagesFromTranscript(projectRoot, "s-recover", kind))).toContain(authorText);
  });

  it("does not recover cancelled, unfinished, non-authoring or deleted requests", async () => {
    await createAndPersistBookSession(projectRoot, null, "s-recover", "book-create");
    await appendRecoveryTurn({ requestId: "cancelled", kind: "book-create", text: "CANCELLED_INPUT", terminal: "request_failed", error: "This operation was aborted" });
    await appendRecoveryTurn({ requestId: "aborted-assistant", kind: "book-create", text: "ABORTED_INPUT", terminal: "request_failed", assistantAborted: true });
    await appendRecoveryTurn({ requestId: "pending", kind: "book-create", text: "UNFINISHED_INPUT", terminal: "unfinished" });
    await appendRecoveryTurn({ requestId: "chat", kind: "chat", text: "OTHER_MODE_INPUT", terminal: "request_failed" });
    expect(await restoreAgentMessagesFromTranscript(projectRoot, "s-recover", "book-create")).toEqual([]);
    expect((await loadBookSession(projectRoot, "s-recover"))?.messages).toEqual([]);
    await appendRecoveryTurn({ requestId: "failed-author", kind: "book-create", text: "RECOVERABLE_INPUT", terminal: "request_failed" });
    expect((await loadBookSession(projectRoot, "s-recover"))?.messages).toHaveLength(1);
    await deleteBookSession(projectRoot, "s-recover");
    expect(await restoreAgentMessagesFromTranscript(projectRoot, "s-recover", "book-create")).toEqual([]);
    expect(await loadBookSession(projectRoot, "s-recover")).toBeNull();
  });

  it("keeps pre-book author source after a real migration and later book dialogue without replaying creation tools", async () => {
    await createAndPersistBookSession(projectRoot, null, "s-recover", "book-create");
    await appendRecoveryTurn({ requestId: "original", kind: "book-create", text: "最初作者原文不可丢失。", terminal: "request_failed" });
    await appendRecoveryTurn({ requestId: "proposal", kind: "book-create", text: "补充约定：七卷不可合并。", terminal: "request_committed" });
    // A different request kind alone must not import pre-book material.
    expect(await restoreAgentMessagesFromTranscript(projectRoot, "s-recover", "book")).toEqual([]);
    await migrateBookSession(projectRoot, "s-recover", "adopted-book");
    for (let index = 0; index < 14; index += 1) {
      await appendRecoveryTurn({ requestId: `later-${index}`, kind: "book", text: `书中讨论 ${index}`, terminal: "request_committed" });
    }
    const restored = await restoreAgentMessagesFromTranscript(projectRoot, "s-recover", "book");
    const inputs = restored.filter((message) => message.role === "user").map((message) => message.content);
    expect(inputs).toContain("最初作者原文不可丢失。");
    expect(inputs).toContain("补充约定：七卷不可合并。");
    expect(inputs).toContain("书中讨论 13");
    expect(JSON.stringify(restored)).not.toContain("FAILED_ASSISTANT");
    expect(JSON.stringify(restored)).not.toContain("FAILED_TOOL_ARGUMENT");
    expect(restored.some((message) => message.role === "toolResult")).toBe(false);
    expect((await loadBookSession(projectRoot, "s-recover"))?.messages[0]?.content).toBe("最初作者原文不可丢失。");
  });

  it.each(["openai-completions", "anthropic-messages"] as const)(
    "keeps a 4259-character author brief after a failed book-create proposal and SDK reload using %s",
    async (api) => {
      // Synthetic material only; do not commit any author's manuscript here.
      const opening = "合成故事：北川与南泽隔河相望。柳吟想救出被困的师父。";
      const ending = "末尾约定：坚持女主限知视角；最后一封信到终章才揭开。";
      const authorText = opening + "景".repeat(4259 - opening.length - ending.length) + ending;
      const retry = "继续生成确认卡，保留刚才全部约定。";
      const appendProposalTurn = async (requestId: string, input: string, failed: boolean) => {
        await appendTranscriptEvents(projectRoot, "s1", ({ nextSeq }) => {
          const base = { version: 1 as const, sessionId: "s1", requestId };
          const toolId = `proposal-${requestId}`;
          return [
            { ...base, type: "request_started", seq: nextSeq, timestamp: nextSeq, sessionKind: "book-create", input },
            {
              ...base, type: "message", seq: nextSeq + 1, timestamp: nextSeq + 1,
              uuid: `u-${requestId}`, parentUuid: null, role: "user",
              message: { role: "user", content: [{ type: "text", text: input }], timestamp: nextSeq + 1 },
            },
            {
              ...base, type: "message", seq: nextSeq + 2, timestamp: nextSeq + 2,
              uuid: `a-${requestId}`, parentUuid: `u-${requestId}`, role: "assistant", toolCallId: toolId,
              message: {
                role: "assistant", content: [{ type: "toolCall", id: toolId, name: "propose_action", arguments: {
                  action: "create_book", instruction: "TOOL_ARGUMENT_SHOULD_NOT_BE_REPLAYED",
                  createBook: failed ? "invalid nested object" : { title: "合成故事" },
                } }], api: "openai-completions", provider: "openai", model: "original-main", usage,
                stopReason: "toolUse", timestamp: nextSeq + 2,
              },
            },
            {
              ...base, type: "message", seq: nextSeq + 3, timestamp: nextSeq + 3,
              uuid: `t-${requestId}`, parentUuid: `a-${requestId}`, role: "toolResult", toolCallId: toolId,
              message: {
                role: "toolResult", toolCallId: toolId, toolName: "propose_action", isError: failed,
                content: [{ type: "text", text: failed ? "createBook: must be object" : "确认卡已准备" }],
                timestamp: nextSeq + 3,
              },
            },
            { ...base, type: "request_committed", seq: nextSeq + 4, timestamp: nextSeq + 4 },
          ];
        });
      };
      await appendProposalTurn("failed", authorText, true);
      const restored = await restoreAgentMessagesFromTranscript(projectRoot, "s1", "book-create");
      expect(restored.filter((message) => message.role === "user")).toMatchObject([{ content: authorText }]);
      expect(JSON.stringify(restored)).toContain("createBook: must be object");
      expect(JSON.stringify(restored)).not.toContain("TOOL_ARGUMENT_SHOULD_NOT_BE_REPLAYED");

      const model: Model<Api> = {
        id: api === "openai-completions" ? "original-main" : "changed-model",
        name: "Offline SDK regression", api, provider: api === "openai-completions" ? "openai" : "anthropic",
        baseUrl: "https://unused.invalid/v1", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 100,
      };
      const calls: Message[][] = [];
      const agent = new Agent({
        initialState: {
          model,
          messages: appendRestoredHistoryBoundary(adaptRestoredAgentMessagesForModel(restored, model), "zh"),
        },
        // The app represents historical system notes as ordinary context for
        // the SDK. The author's own messages must survive this conversion.
        convertToLlm: (messages) => messages.flatMap((message): Message[] => {
          const raw = message as { role: string; content?: unknown; timestamp?: number };
          if (raw.role === "system" && typeof raw.content === "string") {
            return [{ role: "user", content: raw.content, timestamp: raw.timestamp ?? 0 }];
          }
          return raw.role === "user" || raw.role === "assistant" || raw.role === "toolResult"
            ? [message as Message] : [];
        }),
        streamFn: (_model, context) => {
          calls.push(context.messages);
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: "stop", message: {
            role: "assistant", content: [{ type: "text", text: "已保留原始构思。" }],
            api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 100,
          } });
          return stream;
        },
      });
      await agent.prompt(retry);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContainEqual(expect.objectContaining({ role: "user", content: authorText }));
      expect(JSON.stringify(calls[0])).toContain(retry);
      expect(calls[0]!.some((message) => message.role === "toolResult")).toBe(false);
      expect(JSON.stringify(calls[0])).not.toContain('"toolCall"');

      await appendProposalTurn("retry", retry, false);
      const again = await restoreAgentMessagesFromTranscript(projectRoot, "s1", "book-create");
      expect(again.filter((message) => message.role === "user")).toMatchObject([{ content: authorText }, { content: retry }]);
      expect(JSON.stringify(again)).toContain("确认卡已准备");
    },
  );

  it("keeps the original book-create author intent beyond twelve later clarification messages", async () => {
    const inputs = ["最早的构思必须保留", ...Array.from({ length: 15 }, (_, index) => `后续补充 ${index + 1}`)];
    for (const [index, input] of inputs.entries()) {
      await appendTranscriptEvents(projectRoot, "s1", ({ nextSeq }) => {
        const base = { version: 1 as const, sessionId: "s1", requestId: `r${index}` };
        return [
          { ...base, type: "request_started", seq: nextSeq, timestamp: nextSeq, sessionKind: "book-create", input },
          {
            ...base, type: "message", seq: nextSeq + 1, timestamp: nextSeq + 1,
            uuid: `u${index}`, parentUuid: null, role: "user", message: { role: "user", content: input, timestamp: nextSeq + 1 },
          },
          { ...base, type: "request_committed", seq: nextSeq + 2, timestamp: nextSeq + 2 },
        ];
      });
    }
    const restored = await restoreAgentMessagesFromTranscript(projectRoot, "s1", "book-create");
    expect(restored.map((message) => (message as { content: string }).content)).toEqual(inputs);
  });

  it("只恢复已 committed request 内的 message", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 1,
      timestamp: 1,
      input: "hi",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "u1",
      parentUuid: null,
      seq: 2,
      role: "user",
      timestamp: 2,
      message: { role: "user", content: "hi", timestamp: 2 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 3,
      timestamp: 3,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      seq: 4,
      timestamp: 4,
      input: "lost",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      uuid: "u2",
      parentUuid: "u1",
      seq: 5,
      role: "user",
      timestamp: 5,
      message: { role: "user", content: "lost", timestamp: 5 },
    } as MessageEvent);

    const restored = await restoreAgentMessagesFromTranscript(projectRoot, "s1");

    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ role: "user", content: "hi" });
  });

  it("恢复 agent 上下文时把 committed toolResult 折叠为历史摘要", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 1,
      timestamp: 1,
      input: "tool",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: null,
      seq: 2,
      role: "assistant",
      timestamp: 2,
      toolCallId: "tool-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "需要查资料", signature: "sig" },
          { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "a.md" } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage,
        stopReason: "tool_use",
        timestamp: 2,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "t1",
      parentUuid: "a1",
      seq: 3,
      role: "toolResult",
      timestamp: 3,
      toolCallId: "tool-1",
      sourceToolAssistantUuid: "a1",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "资料" }],
        details: { path: "a.md" },
        isError: false,
        timestamp: 3,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 4,
      timestamp: 4,
    });

    const restored = await restoreAgentMessagesFromTranscript(projectRoot, "s1");

    const body = JSON.stringify(restored);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("历史状态摘要"),
    });
    expect(body).toContain("read");
    expect(body).toContain("资料");
    expect(body).not.toContain("sig");
    expect(body).not.toContain("\"toolCall\"");
    expect(body).not.toContain("\"toolResult\"");
    expect(body).not.toContain(TOOL_RESULT_BRIDGE_TEXT);
  });

  it("恢复旧 transcript 时不会把 use_skill 正文带入后续回合", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 1,
      timestamp: 1,
      input: "use specialist skill",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: null,
      seq: 2,
      role: "assistant",
      timestamp: 2,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "LEGACY_PRIVATE_SKILL_THINKING" },
          { type: "toolCall", id: "skill-1", name: "use_skill", arguments: { skillId: "specialist" } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage,
        stopReason: "tool_use",
        timestamp: 2,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "t1",
      parentUuid: "a1",
      seq: 3,
      role: "toolResult",
      timestamp: 3,
      toolCallId: "skill-1",
      sourceToolAssistantUuid: "a1",
      message: {
        role: "toolResult",
        toolCallId: "skill-1",
        toolName: "use_skill",
        content: [{ type: "text", text: "LEGACY_PRIVATE_SKILL_GUIDANCE" }],
        details: { kind: "skill_activated", skillId: "specialist" },
        isError: false,
        timestamp: 3,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 4,
      timestamp: 4,
    });

    const body = JSON.stringify(await restoreAgentMessagesFromTranscript(projectRoot, "s1"));
    expect(body).toContain("use_skill");
    expect(body).toContain("expired");
    expect(body).not.toContain("LEGACY_PRIVATE_SKILL_GUIDANCE");

    const sessionBody = JSON.stringify(await deriveBookSessionFromTranscript(projectRoot, "s1"));
    expect(sessionBody).toContain("use_skill");
    expect(sessionBody).not.toContain("LEGACY_PRIVATE_SKILL_GUIDANCE");
    expect(sessionBody).not.toContain("LEGACY_PRIVATE_SKILL_THINKING");
  });

  it("恢复 agent 上下文时把历史工具回合折叠为 system 摘要而不是继续回放工具消息", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 1,
      timestamp: 1,
      sessionKind: "book",
      input: "写下一章",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "u1",
      parentUuid: null,
      seq: 2,
      role: "user",
      timestamp: 2,
      message: { role: "user", content: "写下一章", timestamp: 2 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: "u1",
      seq: 3,
      role: "assistant",
      timestamp: 3,
      toolCallId: "tool-1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "sub_agent", arguments: { agent: "writer" } }],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-pro",
        usage,
        stopReason: "toolUse",
        timestamp: 3,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "t1",
      parentUuid: "a1",
      seq: 4,
      role: "toolResult",
      timestamp: 4,
      toolCallId: "tool-1",
      sourceToolAssistantUuid: "a1",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "sub_agent",
        content: [{ type: "text", text: "Chapter 12 written." }],
        isError: false,
        timestamp: 4,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 5,
      timestamp: 5,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      seq: 6,
      timestamp: 6,
      sessionKind: "book",
      input: "哪里节奏慢？",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      uuid: "u2",
      parentUuid: "t1",
      seq: 7,
      role: "user",
      timestamp: 7,
      message: { role: "user", content: "哪里节奏慢？", timestamp: 7 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      uuid: "a2",
      parentUuid: "u2",
      seq: 8,
      role: "assistant",
      timestamp: 8,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "第 7 章后半段节奏慢。" }],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-pro",
        usage,
        stopReason: "stop",
        timestamp: 8,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      seq: 9,
      timestamp: 9,
    });

    const restored = await restoreAgentMessagesFromTranscript(projectRoot, "s1", "book");
    const body = JSON.stringify(restored);

    expect(restored.map((message) => message.role)).toEqual(["system", "user", "user", "assistant"]);
    expect(body).toContain("写下一章");
    expect(body).toContain("历史状态摘要");
    expect(body).toContain("sub_agent");
    expect(body).toContain("Chapter 12 written.");
    expect(body).toContain("哪里节奏慢");
    expect(body).toContain("第 7 章后半段节奏慢");
    expect(body).not.toContain("\"toolCall\"");
    expect(body).not.toContain("\"toolResult\"");
    expect(body).not.toContain("[Tool results]");
  });

  it("带 sessionKind 恢复旧 transcript 时保留自然对话但不恢复未知模式的工具结果", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "legacy",
      seq: 1,
      timestamp: 1,
      input: "旧会话问题",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "legacy",
      uuid: "u1",
      parentUuid: null,
      seq: 2,
      role: "user",
      timestamp: 2,
      message: { role: "user", content: "旧会话问题", timestamp: 2 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "legacy",
      uuid: "a1",
      parentUuid: "u1",
      seq: 3,
      role: "assistant",
      timestamp: 3,
      toolCallId: "tool-1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "sub_agent", arguments: { agent: "writer" } }],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-pro",
        usage,
        stopReason: "toolUse",
        timestamp: 3,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "legacy",
      uuid: "t1",
      parentUuid: "a1",
      seq: 4,
      role: "toolResult",
      timestamp: 4,
      toolCallId: "tool-1",
      sourceToolAssistantUuid: "a1",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "sub_agent",
        content: [{ type: "text", text: "legacy chapter result should not return" }],
        isError: false,
        timestamp: 4,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "legacy",
      seq: 5,
      timestamp: 5,
    });

    const restored = await restoreAgentMessagesFromTranscript(projectRoot, "s1", "book");
    const body = JSON.stringify(restored);

    expect(body).toContain("旧会话问题");
    expect(body).not.toContain("legacy chapter result should not return");
    expect(body).not.toContain("\"toolCall\"");
    expect(body).not.toContain("\"toolResult\"");
  });

  it("恢复 agent 上下文时只保留最近 12 条自然对话", async () => {
    let seq = 1;
    for (let i = 1; i <= 15; i++) {
      const requestId = `r${i}`;
      await appendTranscriptEvent(projectRoot, {
        type: "request_started",
        version: 1,
        sessionId: "s1",
        requestId,
        seq: seq++,
        timestamp: seq,
        sessionKind: "book",
        input: `自然对话 ${i}`,
      });
      await appendTranscriptEvent(projectRoot, {
        type: "message",
        version: 1,
        sessionId: "s1",
        requestId,
        uuid: `u${i}`,
        parentUuid: null,
        seq: seq++,
        role: "user",
        timestamp: seq,
        message: { role: "user", content: `自然对话 ${i}`, timestamp: seq },
      } as MessageEvent);
      await appendTranscriptEvent(projectRoot, {
        type: "request_committed",
        version: 1,
        sessionId: "s1",
        requestId,
        seq: seq++,
        timestamp: seq,
      });
    }

    const restored = await restoreAgentMessagesFromTranscript(projectRoot, "s1", "book");
    const restoredText = restored.map((message) => {
      const content = (message as any).content;
      return typeof content === "string" ? content : "";
    });

    expect(restored).toHaveLength(12);
    expect(restoredText).not.toContain("自然对话 1");
    expect(restoredText).not.toContain("自然对话 2");
    expect(restoredText).not.toContain("自然对话 3");
    expect(restoredText).toContain("自然对话 4");
    expect(restoredText).toContain("自然对话 15");
  });

  it("恢复 agent 上下文时只保留最近 8 条工具摘要", async () => {
    let seq = 1;
    for (let i = 1; i <= 10; i++) {
      const requestId = `tool-${i}`;
      const toolCallId = `call-${i}`;
      await appendTranscriptEvent(projectRoot, {
        type: "request_started",
        version: 1,
        sessionId: "s1",
        requestId,
        seq: seq++,
        timestamp: seq,
        sessionKind: "book",
        input: `工具轮 ${i}`,
      });
      await appendTranscriptEvent(projectRoot, {
        type: "message",
        version: 1,
        sessionId: "s1",
        requestId,
        uuid: `a${i}`,
        parentUuid: null,
        seq: seq++,
        role: "assistant",
        timestamp: seq,
        toolCallId,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: toolCallId, name: "sub_agent", arguments: { agent: "writer" } }],
          api: "openai-completions",
          provider: "openai",
          model: "deepseek-v4-pro",
          usage,
          stopReason: "toolUse",
          timestamp: seq,
        },
      } as MessageEvent);
      await appendTranscriptEvent(projectRoot, {
        type: "message",
        version: 1,
        sessionId: "s1",
        requestId,
        uuid: `t${i}`,
        parentUuid: `a${i}`,
        seq: seq++,
        role: "toolResult",
        timestamp: seq,
        toolCallId,
        sourceToolAssistantUuid: `a${i}`,
        message: {
          role: "toolResult",
          toolCallId,
          toolName: "sub_agent",
          content: [{ type: "text", text: `工具结果 ${i}` }],
          isError: false,
          timestamp: seq,
        },
      } as MessageEvent);
      await appendTranscriptEvent(projectRoot, {
        type: "request_committed",
        version: 1,
        sessionId: "s1",
        requestId,
        seq: seq++,
        timestamp: seq,
      });
    }

    const restored = await restoreAgentMessagesFromTranscript(projectRoot, "s1", "book");
    const content = String((restored[0] as any).content);
    const lines = content.split("\n");

    expect(restored).toHaveLength(1);
    expect(content).toContain("历史状态摘要");
    expect(lines.some((line) => /工具结果 1$/.test(line))).toBe(false);
    expect(lines.some((line) => /工具结果 2$/.test(line))).toBe(false);
    expect(lines.some((line) => /工具结果 3$/.test(line))).toBe(true);
    expect(lines.some((line) => /工具结果 10$/.test(line))).toBe(true);
  });

  it("恢复中断工具轮次时保留作者输入、历史摘要和后续自然输入", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 1,
      timestamp: 1,
      input: "tool",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "u1",
      parentUuid: null,
      seq: 2,
      role: "user",
      timestamp: 2,
      message: { role: "user", content: "tool", timestamp: 2 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: "u1",
      seq: 3,
      role: "assistant",
      timestamp: 3,
      toolCallId: "tool-1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "a.md" } }],
        api: "openai-completions",
        provider: "google",
        model: "gemini-pro-latest",
        usage,
        stopReason: "toolUse",
        timestamp: 3,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "t1",
      parentUuid: "a1",
      seq: 4,
      role: "toolResult",
      timestamp: 4,
      toolCallId: "tool-1",
      sourceToolAssistantUuid: "a1",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "资料" }],
        isError: false,
        timestamp: 4,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a2",
      parentUuid: "t1",
      seq: 5,
      role: "assistant",
      timestamp: 5,
      message: {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "google",
        model: "gemini-pro-latest",
        usage,
        stopReason: "error",
        errorMessage: "400 status code",
        timestamp: 5,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 6,
      timestamp: 6,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      seq: 7,
      timestamp: 7,
      input: "继续",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      uuid: "u2",
      parentUuid: "a2",
      seq: 8,
      role: "user",
      timestamp: 8,
      message: { role: "user", content: "继续", timestamp: 8 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      seq: 9,
      timestamp: 9,
    });

    const restored = await restoreAgentMessagesFromTranscript(projectRoot, "s1");

    const body = JSON.stringify(restored);
    expect(restored.map((message) => message.role)).toEqual(["system", "user", "user"]);
    expect(body).toContain("历史状态摘要");
    expect(body).toContain("资料");
    expect(body).toContain("继续");
    expect(body).not.toContain("\"toolCall\"");
    expect(body).not.toContain("\"toolResult\"");
    expect(body).not.toContain(TOOL_RESULT_BRIDGE_TEXT);
  });

  it("移除最后 assistant message 的 trailing thinking block", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 1,
      timestamp: 1,
      input: "hi",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: null,
      seq: 2,
      role: "assistant",
      timestamp: 2,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "回答" },
          { type: "thinking", thinking: "尾部", signature: "sig" },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage,
        stopReason: "stop",
        timestamp: 2,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 3,
      timestamp: 3,
    });

    const restored = await restoreAgentMessagesFromTranscript(projectRoot, "s1");

    expect((restored[0] as any).content).toEqual([{ type: "text", text: "回答" }]);
  });

  it("跨模型恢复时移除 provider-specific thinking，但保留正文", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "DeepSeek reasoning", thinkingSignature: "reasoning_content" },
          { type: "text", text: "可见回答" },
        ],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-pro",
        usage,
        stopReason: "stop",
        timestamp: 1,
      },
    ] as any;

    const adapted = adaptRestoredAgentMessagesForModel(messages, {
      api: "openai-completions",
      provider: "openai",
      id: "gemini-pro-latest",
    });

    expect((adapted[0] as any).content).toEqual([{ type: "text", text: "可见回答" }]);
  });

  it("同模型恢复时保留 thinking continuity", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "DeepSeek reasoning", thinkingSignature: "reasoning_content" },
          { type: "text", text: "可见回答" },
        ],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-pro",
        usage,
        stopReason: "stop",
        timestamp: 1,
      },
    ] as any;

    const adapted = adaptRestoredAgentMessagesForModel(messages, {
      api: "openai-completions",
      provider: "openai",
      id: "deepseek-v4-pro",
    });

    expect((adapted[0] as any).content).toEqual(messages[0].content);
  });

  it("同模型恢复时也把历史工具回合折叠成 system 状态摘要", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need a file", thinkingSignature: "reasoning_content" },
          { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "story.md" } },
        ],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-pro",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "资料" }],
        isError: false,
        timestamp: 2,
      },
    ] as any;

    const adapted = adaptRestoredAgentMessagesForModel(messages, {
      api: "openai-completions",
      provider: "openai",
      id: "deepseek-v4-pro",
    });

    const body = JSON.stringify(adapted);
    expect(adapted).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("[Historical tool results]"),
      }),
    ]);
    expect(body).toContain("read");
    expect(body).toContain("tool-1");
    expect(body).toContain("资料");
    expect(body).not.toContain("reasoning_content");
    expect(body).not.toContain("\"toolCall\"");
    expect(body).not.toContain("\"toolResult\"");
  });

  it("does not add synthetic toolResult bridge when target model does not require it", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 2,
      },
    ] as any[];

    const adapted = adaptRestoredAgentMessagesForModel(messages, {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude",
    });

    expect(JSON.stringify(adapted)).not.toContain(TOOL_RESULT_BRIDGE_TEXT);
  });

  it("does not add synthetic toolResult bridge after folding historical tool results", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-pro",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 2,
      },
    ] as any[];

    const adapted = adaptRestoredAgentMessagesForModel(messages, {
      api: "openai-completions",
      provider: "openai",
      id: "deepseek-v4-pro",
      compat: { requiresAssistantAfterToolResult: true },
    });

    const body = JSON.stringify(adapted);
    expect(body).toContain("[Historical tool results]");
    expect(body).toContain("result");
    expect(body).not.toContain(TOOL_RESULT_BRIDGE_TEXT);
    expect(body).not.toContain("\"toolResult\"");
  });

  it("跨模型恢复时把原生工具回合降级为 system 历史摘要", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "story.md" } },
        ],
        api: "openai-completions",
        provider: "openai",
        model: "gemini-pro-latest",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "资料" }],
        isError: false,
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "I have processed the tool results." }],
        api: "openai-completions",
        provider: "inkos",
        model: "synthetic-tool-result-bridge",
        usage,
        stopReason: "stop",
        timestamp: 3,
      },
    ] as any;

    const adapted = adaptRestoredAgentMessagesForModel(messages, {
      api: "openai-completions",
      provider: "openai",
      id: "deepseek-v4-pro",
    });

    const body = JSON.stringify(adapted);
    expect(body).not.toContain("\"toolCall\"");
    expect(body).not.toContain("\"toolResult\"");
    expect(adapted).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("[Historical tool results]"),
      }),
    ]);
    expect(body).toContain("read");
    expect(body).toContain("tool-1");
    expect(body).toContain("资料");
    expect(body).not.toContain("I have processed the tool results.");
  });

  it("native Google 同协议恢复时也不把历史工具回合回灌给模型", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan", thinkingSignature: "google-signature" },
          { type: "toolCall", id: "tool-1", name: "ls", arguments: { subdir: "story/roles" } },
        ],
        api: "google-generative-ai",
        provider: "google",
        model: "gemini-pro-latest",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "ls",
        content: [{ type: "text", text: "主要角色/\n次要角色/" }],
        isError: false,
        timestamp: 2,
      },
    ] as any;

    const adapted = adaptRestoredAgentMessagesForModel(messages, {
      api: "google-generative-ai",
      provider: "google",
      id: "gemini-pro-latest",
    });

    const body = JSON.stringify(adapted);
    expect(adapted).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("[Historical tool results]"),
      }),
    ]);
    expect(body).toContain("ls");
    expect(body).toContain("主要角色");
    expect(body).not.toContain("google-signature");
    expect(body).not.toContain("\"toolCall\"");
    expect(body).not.toContain("\"toolResult\"");
  });

  it("切到 native Google 时把旧 OpenAI-compatible Gemini 工具回合文本化", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "ls", arguments: { subdir: "story/roles" } }],
        api: "openai-completions",
        provider: "openai",
        model: "gemini-pro-latest",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "ls",
        content: [{ type: "text", text: "主要角色/" }],
        isError: false,
        timestamp: 2,
      },
    ] as any;

    const adapted = adaptRestoredAgentMessagesForModel(messages, {
      api: "google-generative-ai",
      provider: "google",
      id: "gemini-pro-latest",
    });

    const body = JSON.stringify(adapted);
    expect(body).not.toContain("\"toolCall\"");
    expect(adapted.some((message: any) => message.role === "toolResult")).toBe(false);
    expect(adapted).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("[Historical tool results]"),
      }),
    ]);
    expect(body).toContain("ls");
    expect(body).toContain("主要角色");
  });

  it("切到 native Google 时丢弃 DeepSeek reasoning_content 并文本化工具结果", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "deepseek reasoning", thinkingSignature: "reasoning_content" },
          { type: "text", text: "先看角色。" },
          { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "story/roles/林默.md" } },
        ],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-pro",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "林默资料" }],
        isError: false,
        timestamp: 2,
      },
    ] as any;

    const adapted = adaptRestoredAgentMessagesForModel(messages, {
      api: "google-generative-ai",
      provider: "google",
      id: "gemini-pro-latest",
    });

    const body = JSON.stringify(adapted);
    expect(body).not.toContain("reasoning_content");
    expect(body).not.toContain("deepseek reasoning");
    expect(body).not.toContain("\"toolCall\"");
    expect(body).toContain("先看角色。");
    expect(body).toContain("[Historical tool results]");
    expect(body).toContain("林默资料");
  });

  it("给恢复的历史消息追加边界，避免旧工具结果被当成当前轮动作", () => {
    const messages = [
      { role: "user", content: "写下一章", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "sub_agent", arguments: { agent: "writer" } }],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-pro",
        usage,
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "sub_agent",
        content: [{ type: "text", text: "Chapter written." }],
        isError: false,
        timestamp: 3,
      },
    ] as any;

    const bounded = appendRestoredHistoryBoundary(messages, "zh");

    expect(bounded).toHaveLength(4);
    expect(bounded[3]).toMatchObject({
      role: "system",
      content: expect.stringContaining("以上是已经完成并提交的历史上下文"),
    });
    expect(JSON.stringify(bounded[3])).toContain("优先遵循用户接下来输入的最新指令");
  });

  it("派生 BookSession 时跳过没有正文的 assistant tool-use message", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "session_created",
      version: 1,
      sessionId: "s1",
      seq: 1,
      timestamp: 1,
      bookId: null,
      title: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 2,
      timestamp: 2,
      input: "你好",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "u1",
      parentUuid: null,
      seq: 3,
      role: "user",
      timestamp: 3,
      message: { role: "user", content: "你好", timestamp: 3 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: "u1",
      seq: 4,
      role: "assistant",
      timestamp: 4,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "内部推理" },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "books/a.md" } },
        ],
        api: "openai-completions",
        provider: "google",
        model: "gemini-pro-latest",
        usage,
        stopReason: "toolUse",
        timestamp: 4,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 5,
      timestamp: 5,
    });

    const session = await deriveBookSessionFromTranscript(projectRoot, "s1");

    expect(session?.messages).toEqual([{ role: "user", content: "你好", timestamp: 3 }]);
  });

  it("从 transcript 派生 BookSession UI 视图", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "session_created",
      version: 1,
      sessionId: "s1",
      seq: 1,
      timestamp: 1,
      bookId: "book-a",
      title: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 2,
      timestamp: 2,
      input: "第一条问题",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "u1",
      parentUuid: null,
      seq: 3,
      role: "user",
      timestamp: 3,
      message: { role: "user", content: "第一条问题", timestamp: 3 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: "u1",
      seq: 4,
      role: "assistant",
      timestamp: 4,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "思考" },
          { type: "text", text: "回答" },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage,
        stopReason: "stop",
        timestamp: 4,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 5,
      timestamp: 5,
    });

    const session = await deriveBookSessionFromTranscript(projectRoot, "s1");

    expect(session).toMatchObject({
      sessionId: "s1",
      bookId: "book-a",
      title: "第一条问题",
      messages: [
        { role: "user", content: "第一条问题" },
        { role: "assistant", content: "回答", thinking: "思考" },
      ],
    });
  });

  it("从 transcript 派生 BookSession UI 工具执行记录", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "session_created",
      version: 1,
      sessionId: "s1",
      seq: 1,
      timestamp: 1,
      bookId: "book-a",
      title: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 2,
      timestamp: 2,
      input: "查看角色目录",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "u1",
      parentUuid: null,
      seq: 3,
      role: "user",
      timestamp: 3,
      message: { role: "user", content: "查看角色目录", timestamp: 3 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: "u1",
      seq: 4,
      role: "assistant",
      timestamp: 4,
      toolCallId: "ls-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先列目录" },
          { type: "toolCall", id: "ls-1", name: "ls", arguments: { bookId: "book-a", subdir: "story/roles" } },
        ],
        api: "google-generative-ai",
        provider: "google",
        model: "gemini-pro-latest",
        usage,
        stopReason: "toolUse",
        timestamp: 4,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "t1",
      parentUuid: "a1",
      seq: 5,
      role: "toolResult",
      timestamp: 5,
      toolCallId: "ls-1",
      sourceToolAssistantUuid: "a1",
      message: {
        role: "toolResult",
        toolCallId: "ls-1",
        toolName: "ls",
        content: [{ type: "text", text: "主要角色/\n次要角色/" }],
        details: { path: "books/book-a/story/roles" },
        isError: false,
        timestamp: 5,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a2",
      parentUuid: "t1",
      seq: 6,
      role: "assistant",
      timestamp: 6,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "角色目录已查看。" }],
        api: "google-generative-ai",
        provider: "google",
        model: "gemini-pro-latest",
        usage,
        stopReason: "stop",
        timestamp: 6,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 7,
      timestamp: 7,
    });

    const session = await deriveBookSessionFromTranscript(projectRoot, "s1");

    expect(session?.messages).toMatchObject([
      { role: "user", content: "查看角色目录" },
      {
        role: "assistant",
        content: "角色目录已查看。",
        thinking: "先列目录",
        toolExecutions: [{
          id: "ls-1",
          tool: "ls",
          label: "列目录",
          status: "completed",
          args: { bookId: "book-a", subdir: "story/roles" },
          result: "主要角色/\n次要角色/",
          details: { path: "books/book-a/story/roles" },
          startedAt: 4,
          completedAt: 5,
        }],
      },
    ]);
  });

  it("keeps UI message order by transcript seq instead of message timestamp", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "session_created",
      version: 1,
      sessionId: "s1",
      seq: 1,
      timestamp: 1,
      bookId: "book-a",
      title: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 2,
      timestamp: 2,
      input: "先问",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "u1",
      parentUuid: null,
      seq: 3,
      role: "user",
      timestamp: 100,
      message: { role: "user", content: "先问", timestamp: 100 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: "u1",
      seq: 4,
      role: "assistant",
      timestamp: 50,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "后答" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage,
        stopReason: "stop",
        timestamp: 50,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 5,
      timestamp: 5,
    });

    const session = await deriveBookSessionFromTranscript(projectRoot, "s1");

    expect(session?.messages.map((message) => message.content)).toEqual(["先问", "后答"]);
  });

  it("does not carry pending tool executions or thinking across request boundaries", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "session_created",
      version: 1,
      sessionId: "s1",
      seq: 1,
      timestamp: 1,
      bookId: "book-a",
      title: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 2,
      timestamp: 2,
      input: "列目录",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "u1",
      parentUuid: null,
      seq: 3,
      role: "user",
      timestamp: 3,
      message: { role: "user", content: "列目录", timestamp: 3 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: "u1",
      seq: 4,
      role: "assistant",
      timestamp: 4,
      toolCallId: "ls-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "第一轮工具前思考" },
          { type: "toolCall", id: "ls-1", name: "ls", arguments: { subdir: "story" } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage,
        stopReason: "toolUse",
        timestamp: 4,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "t1",
      parentUuid: "a1",
      seq: 5,
      role: "toolResult",
      timestamp: 5,
      toolCallId: "ls-1",
      sourceToolAssistantUuid: "a1",
      message: {
        role: "toolResult",
        toolCallId: "ls-1",
        toolName: "ls",
        content: [{ type: "text", text: "roles/" }],
        isError: false,
        timestamp: 5,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 6,
      timestamp: 6,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      seq: 7,
      timestamp: 7,
      input: "继续",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      uuid: "u2",
      parentUuid: null,
      seq: 8,
      role: "user",
      timestamp: 8,
      message: { role: "user", content: "继续", timestamp: 8 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      uuid: "a2",
      parentUuid: "u2",
      seq: 9,
      role: "assistant",
      timestamp: 9,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "第二轮回答" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage,
        stopReason: "stop",
        timestamp: 9,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      seq: 10,
      timestamp: 10,
    });

    const session = await deriveBookSessionFromTranscript(projectRoot, "s1");
    const secondAssistant = session?.messages.find((message) => message.content === "第二轮回答");

    expect(secondAssistant).toMatchObject({ role: "assistant", content: "第二轮回答" });
    expect(secondAssistant).not.toHaveProperty("thinking");
    expect(secondAssistant).not.toHaveProperty("toolExecutions");
  });

  it("does not resolve tool results with tool calls from a previous request", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "session_created",
      version: 1,
      sessionId: "s1",
      seq: 1,
      timestamp: 1,
      bookId: "book-a",
      title: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 2,
      timestamp: 2,
      input: "第一轮",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: null,
      seq: 3,
      role: "assistant",
      timestamp: 3,
      toolCallId: "shared-tool",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "shared-tool", name: "ls", arguments: { subdir: "story/roles" } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage,
        stopReason: "toolUse",
        timestamp: 3,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 4,
      timestamp: 4,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      seq: 5,
      timestamp: 5,
      input: "第二轮",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      uuid: "u2",
      parentUuid: null,
      seq: 6,
      role: "user",
      timestamp: 6,
      message: { role: "user", content: "第二轮", timestamp: 6 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      uuid: "t2",
      parentUuid: "u2",
      seq: 7,
      role: "toolResult",
      timestamp: 7,
      toolCallId: "shared-tool",
      message: {
        role: "toolResult",
        toolCallId: "shared-tool",
        toolName: "ls",
        content: [{ type: "text", text: "chapters/" }],
        isError: false,
        timestamp: 7,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      uuid: "a2",
      parentUuid: "t2",
      seq: 8,
      role: "assistant",
      timestamp: 8,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "第二轮回答" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude",
        usage,
        stopReason: "stop",
        timestamp: 8,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r2",
      seq: 9,
      timestamp: 9,
    });

    const session = await deriveBookSessionFromTranscript(projectRoot, "s1");
    const secondAssistant = session?.messages.find((message) => message.content === "第二轮回答");

    expect(secondAssistant?.toolExecutions).toEqual([
      expect.objectContaining({
        id: "shared-tool",
        tool: "ls",
        result: "chapters/",
        startedAt: 7,
        completedAt: 7,
      }),
    ]);
    expect(secondAssistant?.toolExecutions?.[0]).not.toHaveProperty("args");
  });

  it("restores a terminal proposed-action card onto the previous assistant message", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "session_created",
      version: 1,
      sessionId: "s1",
      seq: 1,
      timestamp: 1,
      bookId: null,
      sessionKind: "play",
      playMode: "open",
      title: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      sessionKind: "play",
      seq: 2,
      timestamp: 2,
      input: "开一个开放世界",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: null,
      seq: 3,
      role: "assistant",
      timestamp: 3,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "现在生成启动确认卡。" },
          {
            type: "toolCall",
            id: "proposal-1",
            name: "propose_action",
            arguments: {
              action: "play_start",
              instruction: "启动旧影院",
              title: "确认启动",
            },
          },
        ],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-flash",
        usage,
        stopReason: "toolUse",
        timestamp: 3,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "t1",
      parentUuid: "a1",
      seq: 4,
      role: "toolResult",
      timestamp: 4,
      toolCallId: "proposal-1",
      message: {
        role: "toolResult",
        toolCallId: "proposal-1",
        toolName: "propose_action",
        content: [{ type: "text", text: "确认启动" }],
        details: {
          kind: "proposed_action",
          action: "play_start",
          targetSessionKind: "play",
          sameSession: true,
          instruction: "启动旧影院",
          title: "确认启动",
        },
        isError: false,
        timestamp: 4,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a2",
      parentUuid: "t1",
      seq: 5,
      role: "assistant",
      timestamp: 5,
      message: {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-flash",
        usage,
        stopReason: "stop",
        timestamp: 5,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 6,
      timestamp: 6,
    });

    const session = await deriveBookSessionFromTranscript(projectRoot, "s1");
    const assistant = session?.messages.find((message) => message.content === "现在生成启动确认卡。");

    expect(assistant?.toolExecutions).toEqual([
      expect.objectContaining({
        id: "proposal-1",
        tool: "propose_action",
        details: expect.objectContaining({
          kind: "proposed_action",
          action: "play_start",
          targetSessionKind: "play",
          instruction: "启动旧影院",
        }),
      }),
    ]);
  });

  it("restores a direct terminal tool call as a standalone assistant card", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "session_created",
      version: 1,
      sessionId: "s1",
      seq: 1,
      timestamp: 1,
      bookId: "book-a",
      sessionKind: "book",
      title: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      sessionKind: "book",
      seq: 2,
      timestamp: 2,
      input: "重新核验推演",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "u1",
      parentUuid: null,
      seq: 3,
      role: "user",
      timestamp: 3,
      message: { role: "user", content: "重新核验推演", timestamp: 3 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: "u1",
      seq: 4,
      role: "assistant",
      timestamp: 4,
      toolCallId: "forecast-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "核验推演是否过期" },
          {
            type: "toolCall",
            id: "forecast-1",
            name: "get_narrative_forecast",
            arguments: { forecastId: "fc-1" },
          },
        ],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-flash",
        usage,
        stopReason: "toolUse",
        timestamp: 4,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "t1",
      parentUuid: "a1",
      seq: 5,
      role: "toolResult",
      timestamp: 5,
      toolCallId: "forecast-1",
      sourceToolAssistantUuid: "a1",
      message: {
        role: "toolResult",
        toolCallId: "forecast-1",
        toolName: "get_narrative_forecast",
        content: [{ type: "text", text: "Forecast fc-1 is active." }],
        details: { kind: "narrative_forecast", stale: false },
        isError: false,
        timestamp: 5,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a2",
      parentUuid: "t1",
      seq: 6,
      role: "assistant",
      timestamp: 6,
      message: {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-flash",
        usage,
        stopReason: "stop",
        timestamp: 6,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 7,
      timestamp: 7,
    });

    const session = await deriveBookSessionFromTranscript(projectRoot, "s1");

    expect(session?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "重新核验推演" }),
      expect.objectContaining({
        role: "assistant",
        content: "",
        thinking: "核验推演是否过期",
        toolExecutions: [expect.objectContaining({
          id: "forecast-1",
          tool: "get_narrative_forecast",
          label: "核验剧情推演",
          args: { forecastId: "fc-1" },
          details: { kind: "narrative_forecast", stale: false },
          status: "completed",
        })],
      }),
    ]);
  });

  it("restores play tool turns as tool-only messages instead of duplicating scene text", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "session_created",
      version: 1,
      sessionId: "s1",
      seq: 1,
      timestamp: 1,
      bookId: null,
      sessionKind: "play",
      playMode: "open",
      title: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      sessionKind: "play",
      seq: 2,
      timestamp: 2,
      input: "检查维修盖",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "u1",
      parentUuid: null,
      seq: 3,
      role: "user",
      timestamp: 3,
      message: { role: "user", content: "检查维修盖", timestamp: 3 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: "u1",
      seq: 4,
      role: "assistant",
      timestamp: 4,
      toolCallId: "tool-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "调用 play_step", signature: "sig" },
          { type: "toolCall", id: "tool-1", name: "play_step", arguments: { input: "检查维修盖" } },
        ],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-flash",
        usage,
        stopReason: "toolUse",
        timestamp: 4,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "t1",
      parentUuid: "a1",
      seq: 5,
      role: "toolResult",
      timestamp: 5,
      toolCallId: "tool-1",
      sourceToolAssistantUuid: "a1",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "play_step",
        content: [{ type: "text", text: "Play advanced.\n工具生成的权威场景。" }],
        details: {
          kind: "play_turn_advanced",
          sceneText: "工具生成的权威场景。",
          suggestedActions: ["继续检查"],
        },
        isError: false,
        timestamp: 5,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a2",
      parentUuid: "t1",
      seq: 6,
      role: "assistant",
      timestamp: 6,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "模型复述的重复场景。" }],
        api: "openai-completions",
        provider: "openai",
        model: "deepseek-v4-flash",
        usage,
        stopReason: "stop",
        timestamp: 6,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 7,
      timestamp: 7,
    });

    const session = await deriveBookSessionFromTranscript(projectRoot, "s1");
    const assistant = session?.messages.find((message) => message.toolExecutions?.some((exec) => exec.tool === "play_step"));

    expect(assistant).toMatchObject({
      role: "assistant",
      content: "",
      thinking: expect.stringContaining("模型复述的重复场景。"),
      toolExecutions: [
        expect.objectContaining({
          tool: "play_step",
          details: expect.objectContaining({ kind: "play_turn_advanced" }),
        }),
      ],
    });
    expect(session?.messages.some((message) => message.content === "模型复述的重复场景。")).toBe(false);
  });
});
