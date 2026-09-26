/** SPDX-License-Identifier: AGPL-3.0-only */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import type { Context, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { guardedPiStream } from "../agent/pi-stream.js";
import { chatCompletion, createLLMClient } from "../llm/provider.js";
import { LLMConfigSchema } from "../models/project.js";

type Outbound = { url: string; headers: Headers; body: Record<string, unknown> };
const requests: Outbound[] = [];

// Keep pi-ai and both real provider serializers intact. Only replace the HTTP
// boundary, so assertions describe what a gateway receives, not helper internals.
function responseFor(url: string, body: Record<string, unknown>): Response {
  const anthropic = url.endsWith("/messages");
  const responses = url.endsWith("/responses");
  if (body.stream) {
    const events = anthropic ? [
      { type: "message_start", message: { id: "msg-test", type: "message", role: "assistant", content: [], model: body.model, usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ] : responses ? [
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
    ] : [
      { id: "chat-test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { id: "chat-test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ];
    const sse = events.map((event) => `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("")
      + (anthropic || responses ? "" : "data: [DONE]\n\n");
    return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
  }
  const payload = anthropic
    ? { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 2, output_tokens: 1 } }
    : responses
      ? { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }
      : { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
  return Response.json(payload);
}

beforeEach(() => {
  requests.length = 0;
  vi.stubEnv("INKOS_AGENT_LLM_STUB", "");
  vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : "{}");
    const body = JSON.parse(String(raw)) as Record<string, unknown>;
    requests.push({ url, body, headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
    return responseFor(url, body);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function clientFor(model: string, stream: boolean, path: "zenmux" | "chat" | "responses" | "anthropic" = "zenmux") {
  return createLLMClient(LLMConfigSchema.parse({
    provider: path === "anthropic" ? "anthropic" : "openai",
    service: path === "zenmux" ? "custom:zenmux" : "custom",
    configSource: "studio",
    baseUrl: "https://claude-sampling.invalid/v1",
    apiKey: "sk-offline-test-only",
    apiFormat: path === "responses" ? "responses" : "chat",
    model,
    stream,
    temperature: 0.7,
    headers: { "X-Caller-Header": "preserved" },
    extra: { top_p: 0.85, top_k: 25 },
  }));
}

function expectNoSampling(body: Record<string, unknown>) {
  expect(body).not.toHaveProperty("temperature");
  expect(body).not.toHaveProperty("top_p");
  expect(body).not.toHaveProperty("top_k");
}

const conversation = [
  { role: "system" as const, content: "保留故事正典。" },
  { role: "user" as const, content: "连接测试。" },
];

describe("Claude deprecated sampling fields at the HTTP boundary", () => {
  it.each([true, false])("custom:zenmux omits sampling even with per-call temperature 1.2 (stream=%s)", async (stream) => {
    const model = "anthropic/claude-opus-5";
    const result = await chatCompletion(clientFor(model, stream), model, conversation, {
      temperature: 1.2,
      maxTokens: 64,
      extra: { top_p: 0.9, top_k: 30 },
      retry: false,
    });
    expect(result.content).toBe("ok");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://claude-sampling.invalid/v1/chat/completions");
    expectNoSampling(request.body);
    expect(request.body.model).toBe(model);
    expect(JSON.stringify(request.body.messages)).toContain("保留故事正典。");
    expect(JSON.stringify(request.body.messages)).toContain("连接测试。");
    expect(request.headers.get("X-Caller-Header")).toBe("preserved");
  });

  it.each([
    "claude-opus-4-7", "claude-opus-4.7", "anthropic/claude-opus-4-7-20260416",
    "claude-opus-4-8", "claude-opus-4.8", "anthropic.claude-opus-4-8-v1:0",
    "claude-opus-5", "anthropic/claude-opus-5:latest",
    "anthropic/claude-opus-5.5",
    "claude-sonnet-5", "anthropic/claude-sonnet-5-20260915",
  ])("recognizes the gateway model ID %s", async (model) => {
    await chatCompletion(clientFor(model, false, "chat"), model, conversation, { temperature: 1.2, maxTokens: 64, retry: false });
    expect(requests).toHaveLength(1);
    expectNoSampling(requests[0]!.body);
  });

  it.each([
    ["chat", true], ["chat", false],
    ["responses", true], ["responses", false],
    ["anthropic", true], ["anthropic", false],
  ] as const)("native custom %s preserves content and drops all sampling fields (stream=%s)", async (path, stream) => {
    const model = "anthropic/claude-sonnet-5";
    const result = await chatCompletion(clientFor(model, stream, path), model, conversation, {
      temperature: 1.2, maxTokens: 64, extra: { top_p: 0.9, top_k: 30 }, retry: false,
    });
    expect(result.content).toBe("ok");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const suffix = path === "chat" ? "chat/completions" : path === "responses" ? "responses" : "messages";
    expect(request.url).toBe(`https://claude-sampling.invalid/v1/${suffix}`);
    expectNoSampling(request.body);
    expect(request.body).toMatchObject({ model, stream });
    expect(request.body[path === "responses" ? "max_output_tokens" : "max_tokens"]).toBe(64);
    expect(JSON.stringify(request.body)).toContain("保留故事正典。");
    expect(JSON.stringify(request.body)).toContain("连接测试。");
    expect(request.headers.get("X-Caller-Header")).toBe("preserved");
  });

  it.each(["qwen/qwen3.8-max", "claude-sonnet-4-6", "claude-opus-4-6"])("keeps sampling for unaffected model %s", async (model) => {
    await chatCompletion(clientFor(model, false, "chat"), model, conversation, { temperature: 0.8, maxTokens: 64, retry: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toMatchObject({ temperature: 0.8, top_p: 0.85, top_k: 25 });
  });

  it.each([true, false])("keeps Qwen temperature on the pi-ai gateway path (stream=%s)", async (stream) => {
    const model = "qwen/qwen3.8-max";
    await chatCompletion(clientFor(model, stream), model, conversation, { temperature: 0.8, maxTokens: 64, retry: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.temperature).toBe(0.8);
  });
});

describe("guardedPiStream caller hooks and sampling compatibility", () => {
  it.each(["mutate", "replace"] as const)("runs an async caller hook first, then removes its sampling fields (%s)", async (hookKind) => {
    const model = clientFor("anthropic/claude-opus-5", true)._piModel!;
    const context: Context = {
      systemPrompt: "保留工具与对话。",
      messages: [{ role: "user", content: "检查正典。", timestamp: 1 }],
      tools: [{ name: "read_canon", description: "读取正典", parameters: Type.Object({ bookId: Type.String() }) }],
    };
    const hook = vi.fn(async (payload: unknown) => {
      await Promise.resolve();
      const original = payload as Record<string, unknown>;
      expect(JSON.stringify(original.messages)).toContain("检查正典。");
      expect(original.tools).toBeDefined();
      const next = hookKind === "replace" ? { ...original } : original;
      Object.assign(next, { temperature: 1.2, top_p: 0.95, top_k: 40, metadata: { caller: "preserved" } });
      return hookKind === "replace" ? next : undefined;
    });
    const options: SimpleStreamOptions = {
      apiKey: "sk-offline-test-only",
      temperature: 1.2,
      maxTokens: 64,
      headers: { "X-Guard-Caller": "preserved" },
      onPayload: hook,
    };
    const result = await guardedPiStream(model, context, options).result();
    expect(result.stopReason).toBe("stop");
    expect(hook).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expectNoSampling(request.body);
    expect(request.body.metadata).toEqual({ caller: "preserved" });
    expect(JSON.stringify(request.body.messages)).toContain("保留工具与对话。");
    expect(JSON.stringify(request.body.messages)).toContain("检查正典。");
    expect(request.body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: "read_canon" }) })]));
    expect(request.headers.get("X-Guard-Caller")).toBe("preserved");
    expect(options.temperature).toBe(1.2);
    expect(options.onPayload).toBe(hook);
  });
});
