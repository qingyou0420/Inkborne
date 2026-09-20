import { describe, expect, it } from "vitest";
import { createLLMClient } from "../llm/provider.js";
import { lookupModel } from "../llm/providers/lookup.js";
import { LLMConfigSchema } from "../models/project.js";

describe("verified gateway model output budgets", () => {
  it.each([
    ["google/gemini-3.1-pro-preview", 65_535, 1_048_576],
    ["anthropic/claude-opus-5", 128_000, 1_000_000],
  ] as const)("preserves %s on the gateway while using its verified budget", (model, maxOutput, contextWindow) => {
    const client = createLLMClient(LLMConfigSchema.parse({
      provider: "openai",
      service: "custom:zenmux",
      model,
      apiKey: "test-only",
      baseUrl: "https://zenmux.ai/api/v1",
    }));
    expect(client.defaults.maxTokens).toBe(maxOutput);
    expect(client._piModel?.maxTokens).toBe(maxOutput);
    expect(client._piModel?.contextWindow).toBe(contextWindow);
    expect(client._piModel?.id).toBe(model);
    expect(client._piModel?.api).toBe("openai-completions");
    expect(client._piModel?.baseUrl).toBe("https://zenmux.ai/api/v1");
  });

  it("keeps native Gemini's separate limit and resolves native Opus 5", () => {
    expect(lookupModel("google", "gemini-3.1-pro-preview")?.maxOutput).toBe(65_536);
    expect(lookupModel("anthropic", "claude-opus-5")?.maxOutput).toBe(128_000);
  });

  it("keeps an exact endpoint restriction ahead of global fallback", () => {
    expect(lookupModel("githubCopilot", "gemini-3.1-pro-preview")?.maxOutput).toBe(4096);
    expect(lookupModel("custom", "google/gemini-2.5-flash")?.maxOutput).toBe(65_535);
  });

  it.each([
    "other/gemini-3.1-pro-preview",
    "google/gemini-3.1-pro-preview:free",
    "custom/anthropic/claude-opus-5",
    "anthropic/claude-opus-5-private",
  ])("does not invent capabilities for %s", (model) => {
    expect(lookupModel("custom", model)).toBeUndefined();
    const client = createLLMClient(LLMConfigSchema.parse({
      provider: "openai", service: "custom", model,
      apiKey: "test-only", baseUrl: "https://gateway.example/v1",
    }));
    expect(client.defaults.maxTokens).toBe(24_576);
  });
});
