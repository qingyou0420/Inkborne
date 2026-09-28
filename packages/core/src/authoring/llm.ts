/**
 * Role-bound LLM calls for authoring stages.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { chatCompletion, createLLMClient } from "../llm/provider.js";
import type { AuthoringLlmFn, ResolvedAuthoringRole } from "./types.js";

export function shouldAttemptJsonResponseFormat(resolved: ResolvedAuthoringRole): boolean {
  if (resolved.llm.provider === "anthropic") return false;
  if (resolved.apiFormat === "responses") return false;
  const blob = [
    resolved.modelId,
    resolved.llm.model,
    resolved.llm.baseUrl,
    resolved.serviceRef,
    resolved.llm.service,
  ].join("\n").toLowerCase();
  if (blob.includes("anthropic") || blob.includes("claude")) return false;
  return true;
}

export function isJsonResponseFormatUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /response_format|json_object|json mode|response format/i.test(message);
}

export function createAuthoringLlm(resolved: ResolvedAuthoringRole): AuthoringLlmFn {
  const client = createLLMClient(resolved.llm);
  const run = async (call: Parameters<AuthoringLlmFn>[0], format: boolean) => {
    const extra: Record<string, unknown> = { ...(resolved.extra ?? {}) };
    if (format) extra.response_format = { type: "json_object" };
    else delete extra.response_format;
    const response = await chatCompletion(client, resolved.modelId, call.messages, {
      temperature: resolved.temperature,
      extra,
      ...(call.signal ? { signal: call.signal } : {}),
    });
    return response.content;
  };
  return async (call) => {
    if (call.responseFormat !== "json_object") return run(call, false);
    try {
      return await run(call, true);
    } catch (error) {
      if (!isJsonResponseFormatUnsupported(error)) throw error;
      return run(call, false);
    }
  };
}

export async function completeRole(
  resolved: ResolvedAuthoringRole,
  user: string,
  llm?: AuthoringLlmFn,
  signal?: AbortSignal,
  options?: { readonly responseFormat?: "json_object" },
): Promise<string> {
  const fn = llm ?? createAuthoringLlm(resolved);
  return fn({
    roleId: resolved.roleId,
    snapshot: resolved.snapshot,
    ...(signal ? { signal } : {}),
    ...(options?.responseFormat ? { responseFormat: options.responseFormat } : {}),
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
