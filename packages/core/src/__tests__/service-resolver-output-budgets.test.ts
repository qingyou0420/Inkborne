import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn((_provider: string, modelId: string) => modelId === "gpt-4o" ? {
    id: modelId,
    contextWindow: 128_000,
    maxTokens: 16_384,
  } : undefined),
  getEnvApiKey: vi.fn(() => undefined),
}));
vi.mock("../llm/secrets.js", () => ({
  getServiceApiKey: vi.fn(async () => "test-only"),
}));

import { resolveServiceModel } from "../llm/service-resolver.js";

describe("chat model budgets when the pi registry lacks a model", () => {
  it.each([
    ["google/gemini-3.1-pro-preview", 65_535, 1_048_576],
    ["anthropic/claude-opus-5", 128_000, 1_000_000],
    ["anthropic/claude-opus-5.5", 128_000, 1_000_000],
  ] as const)("recognizes %s without changing the request route or ID", async (modelId, maxTokens, contextWindow) => {
    const { model } = await resolveServiceModel(
      "custom:zenmux", modelId, "D:/test-project", "https://zenmux.ai/api/v1",
    );
    expect(model).toMatchObject({
      id: modelId, maxTokens, contextWindow,
      api: "openai-completions", provider: "openai", baseUrl: "https://zenmux.ai/api/v1",
    });
  });

  it("leaves an existing pi registry model's budget unchanged", async () => {
    const { model } = await resolveServiceModel(
      "custom:test", "gpt-4o", "D:/test-project", "https://gateway.example/v1",
    );
    expect(model.maxTokens).toBe(16_384);
  });

  it("keeps the current fallback for an unknown private model", async () => {
    const { model } = await resolveServiceModel(
      "custom:test", "my-private-model", "D:/test-project", "https://gateway.example/v1", "responses",
    );
    expect(model).toMatchObject({ id: "my-private-model", maxTokens: 16_384, contextWindow: 0, api: "openai-responses" });
  });
});
