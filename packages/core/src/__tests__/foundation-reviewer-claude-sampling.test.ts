/** SPDX-License-Identifier: AGPL-3.0-only */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FoundationReviewerAgent } from "../agents/foundation-reviewer.js";
import { createLLMClient, type LLMResponse } from "../llm/provider.js";
import { LLMConfigSchema } from "../models/project.js";

const MODEL = "anthropic/claude-opus-5";
const REVIEW = [
  ...Array.from({ length: 5 }, (_, index) => [
    `=== DIMENSION: ${index + 1} ===`,
    "分数：85",
    `意见：第${index + 1}项符合已确认的故事框架。`,
  ].join("\n")),
  "=== OVERALL ===",
  "总分：85",
  "通过：是",
  "总评：基础设定相互一致，可以交由作者确认。",
].join("\n");

function reviewResponse(stream: boolean): Response {
  if (!stream) {
    return Response.json({
      id: "foundation-review-test",
      object: "chat.completion",
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: REVIEW }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
    });
  }
  const chunks = [
    { id: "foundation-review-test", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: REVIEW }, finish_reason: null }] },
    { id: "foundation-review-test", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } },
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("foundation review with Claude Opus 5", () => {
  it.each([true, false])("omits deprecated sampling despite the reviewer's 0.3 override (stream=%s)", async (stream) => {
    // Preserve the real reviewer, worker lifecycle, provider, and pi-ai SDK.
    // Replace only HTTP, using an invalid domain and a fake key as a second
    // safeguard against contacting the user's actual service or novels.
    vi.stubEnv("INKOS_AGENT_LLM_STUB", "");
    const outbound: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : "{}");
      const body = JSON.parse(String(raw)) as Record<string, unknown>;
      outbound.push({ url, body });
      return reviewResponse(Boolean(body.stream));
    }));

    const client = createLLMClient(LLMConfigSchema.parse({
      provider: "openai",
      service: "custom:zenmux",
      configSource: "studio",
      baseUrl: "https://foundation-review.invalid/api/v1",
      apiKey: "sk-offline-test-only",
      apiFormat: "chat",
      model: MODEL,
      stream,
      temperature: 1,
    }));
    const reviewer = new FoundationReviewerAgent({
      client,
      model: MODEL,
      projectRoot: join(tmpdir(), "inkborne-foundation-review-offline"),
    });
    // A pass-through spy records the production trigger without replacing it.
    const chatSpy = vi.spyOn(reviewer as unknown as {
      chat: (...args: unknown[]) => Promise<LLMResponse>;
    }, "chat");

    const result = await reviewer.review({
      language: "zh",
      mode: "original",
      targetChapters: 8,
      foundation: {
        storyBible: "巡河使追查失踪税船，须在汛期前找到旧账。",
        volumeOutline: "八章内完成寻船、查账与归案。",
        bookRules: "人物只能使用已取得的线索。",
        currentState: "主角刚抵河口。",
        pendingHooks: "旧账上的半枚印记。",
      },
    });

    expect(client.defaults.temperature).toBe(1);
    expect(chatSpy.mock.calls[0]?.[1]).toMatchObject({ temperature: 0.3 });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.url).toBe("https://foundation-review.invalid/api/v1/chat/completions");
    const body = outbound[0]!.body;
    expect(body.model).toBe(MODEL);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
    expect(JSON.stringify(body.messages)).toContain("巡河使追查失踪税船");
    expect(JSON.stringify(body.messages)).toContain("用户要求的8章");
    expect(result).toMatchObject({
      passed: true,
      totalScore: 85,
      overallFeedback: "基础设定相互一致，可以交由作者确认。",
    });
    expect(result.dimensions).toHaveLength(5);
    expect(result.dimensions.every((dimension) => dimension.score === 85)).toBe(true);
  });
});
