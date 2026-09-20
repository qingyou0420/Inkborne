// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardedPiStream } from "../agent/pi-stream.js";
import { createLLMClient } from "../llm/provider.js";
import { LLMConfigSchema } from "../models/project.js";

afterEach(() => vi.unstubAllGlobals());

describe("guarded conversational stream output budget on the wire", () => {
  it.each([
    ["google/gemini-3.1-pro-preview", undefined, 65_535],
    ["anthropic/claude-opus-5", undefined, 128_000],
    ["google/gemini-3.1-pro-preview", 4096, 4096],
  ] as const)("sends the reserved budget for %s (override=%s) without the SDK's 32K cap", async (modelId, maxTokens, expected) => {
    const payloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : "{}");
      const body = JSON.parse(String(raw)) as Record<string, unknown>;
      payloads.push(body);
      return new Response([
        { id: "budget-test", object: "chat.completion.chunk", model: modelId, choices: [{ index: 0, delta: { content: "已记下" }, finish_reason: null }] },
        { id: "budget-test", object: "chat.completion.chunk", model: modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    }));
    const client = createLLMClient(LLMConfigSchema.parse({
      provider: "openai", service: "custom:zenmux", model: modelId,
      baseUrl: "https://chat-budget.invalid/api/v1", apiKey: "offline-test",
    }));
    const stream = guardedPiStream(client._piModel!, {
      messages: [{ role: "user", content: "记录这个故事要求", timestamp: Date.now() }],
    }, { apiKey: "offline-test", ...(maxTokens === undefined ? {} : { maxTokens }) });
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(payloads).toHaveLength(1);
    const body = payloads[0]!;
    expect(body.model).toBe(modelId);
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(expected);
    if (modelId.startsWith("anthropic/")) expect(body).not.toHaveProperty("temperature");
  });
});
