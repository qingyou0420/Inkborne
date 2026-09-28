/**
 * Role-bound LLM calls for authoring stages.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { chatCompletion, createLLMClient } from "../llm/provider.js";
import type { AuthoringLlmFn, AuthoringLlmResult, AuthoringTokenUsage, ResolvedAuthoringRole } from "./types.js";

function roundUsage(usage: AuthoringTokenUsage | undefined): AuthoringTokenUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = Math.max(0, Math.round(usage.promptTokens));
  const completionTokens = Math.max(0, Math.round(usage.completionTokens));
  const total = usage.totalTokens > 0 ? usage.totalTokens : promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: Math.max(0, Math.round(total)),
  };
}

export function readAuthoringLlmResult(result: string | AuthoringLlmResult): AuthoringLlmResult {
  if (typeof result === "string") return { content: result };
  return {
    content: result.content,
    ...(result.usage ? { usage: roundUsage(result.usage) } : {}),
  };
}

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
      ...(call.onTextDelta ? { onTextDelta: (delta) => { void call.onTextDelta?.(delta); } } : {}),
    });
    return {
      content: response.content,
      usage: roundUsage(response.usage),
    };
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
  const result = await completeRoleObserved(resolved, user, {
    llm,
    signal,
    ...(options?.responseFormat ? { responseFormat: options.responseFormat } : {}),
  });
  return result.content;
}

export async function completeRoleObserved(
  resolved: ResolvedAuthoringRole,
  user: string,
  options?: {
    readonly llm?: AuthoringLlmFn;
    readonly signal?: AbortSignal;
    readonly onTextDelta?: (delta: string) => void | Promise<void>;
    readonly responseFormat?: "json_object";
  },
): Promise<AuthoringLlmResult> {
  const fn = options?.llm ?? createAuthoringLlm(resolved);
  return readAuthoringLlmResult(await fn({
    roleId: resolved.roleId,
    snapshot: resolved.snapshot,
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
    ...(options?.responseFormat ? { responseFormat: options.responseFormat } : {}),
    messages: [
      { role: "system", content: resolved.instructions },
      { role: "user", content: user },
    ],
  }));
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
