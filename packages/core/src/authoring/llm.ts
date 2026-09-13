/**
 * Role-bound LLM calls for authoring stages.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { chatCompletion, createLLMClient } from "../llm/provider.js";
import type { AuthoringLlmFn, ResolvedAuthoringRole } from "./types.js";

export function createAuthoringLlm(resolved: ResolvedAuthoringRole): AuthoringLlmFn {
  const client = createLLMClient(resolved.llm);
  return async (call) => {
    const response = await chatCompletion(client, resolved.modelId, call.messages, {
      temperature: resolved.temperature,
      extra: resolved.extra,
    });
    return response.content;
  };
}

export async function completeRole(
  resolved: ResolvedAuthoringRole,
  user: string,
  llm?: AuthoringLlmFn,
): Promise<string> {
  const fn = llm ?? createAuthoringLlm(resolved);
  return fn({
    roleId: resolved.roleId,
    snapshot: resolved.snapshot,
    messages: [
      { role: "system", content: resolved.instructions },
      { role: "user", content: user },
    ],
  });
}

export async function testAuthoringRole(input: {
  readonly resolved: ResolvedAuthoringRole;
  readonly llm?: AuthoringLlmFn;
}): Promise<{ ok: boolean; error?: string; modelId: string; serviceRef: string; preview?: string }> {
  try {
    const text = await completeRole(input.resolved, "连接测试。只回复一个词：ok。不要写故事。", input.llm);
    return {
      ok: Boolean(text.trim()),
      modelId: input.resolved.modelId,
      serviceRef: input.resolved.serviceRef,
      preview: text.trim().slice(0, 80),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      modelId: input.resolved.modelId,
      serviceRef: input.resolved.serviceRef,
    };
  }
}
