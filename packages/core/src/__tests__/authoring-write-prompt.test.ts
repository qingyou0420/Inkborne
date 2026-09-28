/**
 * 落笔系统提示词：旧的一句话人设会升级，本书文风和禁语会拼进去。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import {
  DEFAULT_ROLE_INSTRUCTIONS,
  LEGACY_ROLE_INSTRUCTIONS_V1,
  fillMissingAuthoringRoles,
  resolveAuthoringRole,
} from "../authoring/model-config.js";
import { composeWriteSystemPrompt } from "../authoring/write-system-prompt.js";

function project() {
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
      apiKey: "sk-test",
      temperature: 0.7,
      thinkingBudget: 0,
      apiFormat: "chat",
      stream: true,
    },
  });
}

describe("write system prompt", () => {
  it("replaces the old one-line 落笔 instruction and keeps an author addition", () => {
    const cfg = project();
    const filled = fillMissingAuthoringRoles({
      ...cfg,
      authoringRoles: {
        "write.main": {
          modelId: "writer-model",
          serviceRef: "zenmux",
          instructions: LEGACY_ROLE_INSTRUCTIONS_V1["write.main"],
          instructionsVersion: 1,
        },
        "write.review": {
          modelId: "review-model",
          serviceRef: "zenmux",
          instructions: "审查时多看伏笔，这是作者附加要求。",
          instructionsVersion: 1,
        },
      },
    });
    expect(filled["write.main"]?.instructions).toBe(DEFAULT_ROLE_INSTRUCTIONS["write.main"]);
    expect(filled["write.main"]?.instructionsVersion).toBe(2);
    expect(filled["write.review"]?.instructions).toContain("作者附加要求");
    const resolved = resolveAuthoringRole({
      roleId: "write.main",
      baseLlm: cfg.llm,
      roles: filled,
    });
    const system = composeWriteSystemPrompt(resolved.instructions, "冷一点，短句");
    expect(system).toContain("本书文风：冷一点，短句");
    expect(system).toContain("网文通用写法");
    expect(system).toContain("禁语");
    expect(system).toContain("显然");
  });
});
