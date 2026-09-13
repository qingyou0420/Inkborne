import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import {
  AUTHORING_ROLE_IDS,
  applyServiceToLlm,
  fillMissingAuthoringRoles,
  mapAgentNameToRole,
  resolveAuthoringRole,
  resolveRoleForAgent,
} from "../authoring/model-config.js";
import { createLLMClient } from "../llm/provider.js";
import { PipelineRunner } from "../pipeline/runner.js";

function project(overrides?: Record<string, unknown>) {
  return ProjectConfigSchema.parse({
    name: "test",
    version: "0.1.0",
    language: "zh",
    llm: {
      provider: "custom",
      service: "zenmux",
      configSource: "studio",
      baseUrl: "https://zenmux.ai/api/v1",
      model: "default-model",
      defaultModel: "default-model",
      apiKey: "sk-test",
      temperature: 0.7,
      thinkingBudget: 0,
      apiFormat: "chat",
      stream: true,
    },
    ...overrides,
  });
}

describe("authoring model config", () => {
  it("maps legacy agent names onto the eight roles", () => {
    expect(mapAgentNameToRole("writer")).toBe("write.main");
    expect(mapAgentNameToRole("auditor")).toBe("write.review");
    expect(mapAgentNameToRole("architect")).toBe("ground.main");
    expect(mapAgentNameToRole("ask.main")).toBe("ask.main");
  });

  it("fills eight missing roles from the project default without clobbering a saved role", () => {
    const cfg = project({
      authoringRoles: {
        "ask.main": { modelId: "ask-only", serviceRef: "zenmux" },
      },
    });
    const filled = fillMissingAuthoringRoles(cfg);
    expect(Object.keys(filled)).toHaveLength(8);
    expect(filled["ask.main"]?.modelId).toBe("ask-only");
    expect(filled["write.review"]?.modelId).toBe("default-model");
    expect(filled["weave.main"]?.serviceRef).toBe("zenmux");
  });

  it("imports a legacy writer override into write.main only", () => {
    const cfg = project({
      modelOverrides: { writer: "writer-model", auditor: "audit-model" },
    });
    const filled = fillMissingAuthoringRoles(cfg);
    expect(filled["write.main"]?.modelId).toBe("writer-model");
    expect(filled["write.review"]?.modelId).toBe("audit-model");
    expect(filled["ask.main"]?.modelId).toBe("default-model");
  });

  it("resolves eight distinct models without sharing mutable config", () => {
    const roles = Object.fromEntries(
      AUTHORING_ROLE_IDS.map((id, index) => [id, { modelId: `model-${index}`, serviceRef: "zenmux", temperature: index / 10 }]),
    );
    const cfg = project({ authoringRoles: roles });
    const snapshots = AUTHORING_ROLE_IDS.map((roleId) => resolveAuthoringRole({
      roleId,
      baseLlm: cfg.llm,
      roles: fillMissingAuthoringRoles(cfg),
    }));
    const models = snapshots.map((item) => item.modelId);
    expect(new Set(models).size).toBe(8);
    const ask = resolveAuthoringRole({
      roleId: "ask.main",
      baseLlm: cfg.llm,
      roles: {
        ...fillMissingAuthoringRoles(cfg),
        "ask.main": { modelId: "changed-ask", serviceRef: "zenmux" },
      },
    });
    expect(ask.modelId).toBe("changed-ask");
    expect(resolveRoleForAgent({
      agentName: "writer",
      baseLlm: cfg.llm,
      roles: fillMissingAuthoringRoles(cfg),
    })?.modelId).toBe("model-6");
    expect(resolveRoleForAgent({
      agentName: "auditor",
      baseLlm: cfg.llm,
      roles: fillMissingAuthoringRoles(cfg),
    })?.modelId).toBe("model-7");
  });

  it("keeps a run snapshot independent from later setting edits", () => {
    const cfg = project({
      authoringRoles: { "write.main": { modelId: "run-model", serviceRef: "zenmux" } },
    });
    const started = resolveAuthoringRole({
      roleId: "write.main",
      baseLlm: cfg.llm,
      roles: fillMissingAuthoringRoles(cfg),
    });
    const later = resolveAuthoringRole({
      roleId: "write.main",
      baseLlm: cfg.llm,
      roles: {
        ...fillMissingAuthoringRoles(cfg),
        "write.main": { modelId: "new-model", serviceRef: "zenmux" },
      },
    });
    expect(started.snapshot.modelId).toBe("run-model");
    expect(later.modelId).toBe("new-model");
  });

  it("swaps credentials with the selected service instead of keeping the previous key", () => {
    const cfg = project();
    const switched = applyServiceToLlm(cfg.llm, "custom:other", {
      apiKeys: { zenmux: "sk-test", "custom:other": "sk-other" },
    });
    expect(switched.service).toBe("custom:other");
    expect(switched.apiKey).toBe("sk-other");
    expect(switched.apiKey).not.toBe(cfg.llm.apiKey);
    const review = resolveAuthoringRole({
      roleId: "write.review",
      baseLlm: cfg.llm,
      roles: {
        "write.review": { modelId: "review-b", serviceRef: "custom:other" },
      },
      apiKeys: { zenmux: "sk-test", "custom:other": "sk-other" },
    });
    expect(review.llm.apiKey).toBe("sk-other");
    expect(review.llm.service).toBe("custom:other");
  });

  it("passes saved service keys into the old pipeline role override (R7-10)", async () => {
    const cfg = project({
      authoringRoles: {
        "write.main": { modelId: "b-model", serviceRef: "custom:B" },
        "write.review": { modelId: "c-model", serviceRef: "custom:C" },
      },
    });
    const runner = new PipelineRunner({
      client: createLLMClient(cfg.llm),
      model: cfg.llm.model,
      projectRoot: join(tmpdir(), "authoring-r7-10"),
      defaultLLMConfig: cfg.llm,
      authoringRoles: fillMissingAuthoringRoles(cfg),
      roleApiKeys: { zenmux: "sk-test", "custom:B": "sk-b", "custom:C": "sk-c" },
    });
    const write = runner.createAgentContext("writer");
    const review = runner.createAgentContext("auditor");
    expect(write.model).toBe("b-model");
    expect(write.client._apiKey).toBe("sk-b");
    expect(review.model).toBe("c-model");
    expect(review.client._apiKey).toBe("sk-c");
  });

  it("loads keys from the project secrets file when the pipeline config omits them (R7-10)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "authoring-r7-10-secrets-"));
    await mkdir(join(dir, ".inkos"), { recursive: true });
    await writeFile(join(dir, ".inkos", "secrets.json"), JSON.stringify({
      services: { zenmux: { apiKey: "sk-test" }, "custom:B": { apiKey: "sk-file-b" } },
    }), "utf-8");
    const cfg = project({
      authoringRoles: {
        "write.main": { modelId: "b-model", serviceRef: "custom:B" },
      },
    });
    const runner = new PipelineRunner({
      client: createLLMClient(cfg.llm),
      model: cfg.llm.model,
      projectRoot: dir,
      defaultLLMConfig: cfg.llm,
      authoringRoles: fillMissingAuthoringRoles(cfg),
    });
    const write = runner.createAgentContext("writer");
    expect(write.client._apiKey).toBe("sk-file-b");
    await rm(dir, { recursive: true, force: true });
  });

  it("uses Responses for a named custom connection (R7-11)", () => {
    const responses = createLLMClient({
      ...project().llm,
      provider: "custom",
      service: "custom:B",
      apiFormat: "responses",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-b",
      model: "resp-model",
    });
    expect(responses.apiFormat).toBe("responses");
    expect(responses._piModel?.api).toBe("openai-responses");
    const chat = createLLMClient({
      ...project().llm,
      provider: "custom",
      service: "custom:B",
      apiFormat: "chat",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-b",
      model: "chat-model",
    });
    expect(chat.apiFormat).toBe("chat");
    expect(chat._piModel?.api).toBe("openai-completions");
  });

  it("inherits the new connection protocol when switching service without an explicit override (R8-04)", () => {
    const cfg = project({
      llm: {
        ...project().llm,
        apiFormat: "chat",
        services: [
          { service: "custom", name: "B", baseUrl: "https://example.test/b/v1", apiFormat: "responses", stream: false },
        ],
      },
      authoringRoles: {
        "write.main": { modelId: "a-model", serviceRef: "zenmux", apiFormat: "chat" },
      },
    });
    const filled = fillMissingAuthoringRoles(cfg);
    expect(filled["ask.review"]?.apiFormat).toBeUndefined();
    const switched = resolveAuthoringRole({
      roleId: "write.main",
      baseLlm: cfg.llm,
      roles: filled,
      temporary: { serviceRef: "custom:B", modelId: "b-model" },
      apiKeys: { zenmux: "sk-test", "custom:B": "sk-b" },
    });
    expect(switched.serviceRef).toBe("custom:B");
    expect(switched.modelId).toBe("b-model");
    expect(switched.apiFormat).toBe("responses");
    expect(switched.llm.apiFormat).toBe("responses");
    expect(switched.llm.apiKey).toBe("sk-b");
    const inherit = resolveAuthoringRole({
      roleId: "write.main",
      baseLlm: cfg.llm,
      roles: filled,
      temporary: { serviceRef: "custom:B", modelId: "b-model", apiFormat: undefined },
      apiKeys: { zenmux: "sk-test", "custom:B": "sk-b" },
    });
    expect(inherit.apiFormat).toBe("responses");
    const back = resolveAuthoringRole({
      roleId: "write.main",
      baseLlm: cfg.llm,
      roles: {
        "write.main": { modelId: "b-model", serviceRef: "custom:B", apiFormat: "responses" },
      },
      temporary: { serviceRef: "zenmux", modelId: "a-model" },
      apiKeys: { zenmux: "sk-test", "custom:B": "sk-b" },
    });
    expect(back.serviceRef).toBe("zenmux");
    expect(back.apiFormat).toBe("chat");
  });
});
