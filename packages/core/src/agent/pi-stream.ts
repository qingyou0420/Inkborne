import { streamSimple } from "@mariozechner/pi-ai";
import { constrainClaudeSamplingOptions } from "../llm/claude-sampling.js";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import {
  assertWithinContextWindow,
  DEFAULT_PIPELINE_STREAM_IDLE_TIMEOUT_MS,
  estimatePiContextTokens,
  guardAssistantMessageStream,
  type StreamDeadlineOptions,
} from "../llm/provider.js";
import {
  agentTrajectoryHeaders,
  beginAgentModelCall,
} from "../llm/agent-trajectory.js";

/**
 * The single Pi transport boundary used by both conversational and worker
 * agents. Pi keeps native tool calls; InkOS adds context guards, trajectory
 * headers, cancellation, and stream deadlines around the request.
 *
 * Book chat and structured workers expose tools (including write_truth_file).
 * The 60s interactive idle is too tight: Kimi-class models can think silently
 * after the HTTP stream opens, or stall between huge story_frame toolcall
 * deltas. Abort then leaves the tool unexecuted — no proposal card.
 * Reuse the pipeline 180s idle only when tools are present; text-only streams
 * keep the default 60s so a stuck reply still fails fast.
 */
export function resolveGuardedPiStreamDeadline(
  context: { readonly tools?: readonly unknown[] },
  overrides?: StreamDeadlineOptions,
): StreamDeadlineOptions | undefined {
  const toolCapable = Boolean(context.tools && context.tools.length > 0);
  const next: StreamDeadlineOptions = {
    ...(toolCapable ? { idleTimeoutMs: DEFAULT_PIPELINE_STREAM_IDLE_TIMEOUT_MS } : {}),
    ...compactDeadlineOverrides(overrides),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

function compactDeadlineOverrides(
  overrides?: StreamDeadlineOptions,
): StreamDeadlineOptions {
  if (!overrides) return {};
  return {
    ...(overrides.firstEventTimeoutMs !== undefined
      ? { firstEventTimeoutMs: overrides.firstEventTimeoutMs }
      : {}),
    ...(overrides.idleTimeoutMs !== undefined ? { idleTimeoutMs: overrides.idleTimeoutMs } : {}),
    ...(overrides.overallTimeoutMs !== undefined
      ? { overallTimeoutMs: overrides.overallTimeoutMs }
      : {}),
  };
}

export function guardedPiStream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
  deadlineOptions?: StreamDeadlineOptions,
): AssistantMessageEventStream {
  const reservedOutputTokens = Number.isFinite(options?.maxTokens)
    ? options!.maxTokens!
    : Number.isFinite(model.maxTokens)
      ? model.maxTokens
      : 4096;
  assertWithinContextWindow({
    piModel: model,
    model: model.id,
    estimatedInputTokens: estimatePiContextTokens(context),
    reservedOutputTokens,
  });
  const modelCall = beginAgentModelCall();
  const traceHeaders = agentTrajectoryHeaders(model.baseUrl, modelCall, 1, {
    effort: String(options?.reasoning ?? (model.reasoning ? "enabled" : "disabled")),
  });
  return guardAssistantMessageStream(
    model,
    (signal) => streamSimple(model, context, constrainClaudeSamplingOptions(model.id, {
      ...options,
      // pi-ai otherwise silently caps its default at 32,000. Use the same
      // output budget we reserved above and preserve explicit caller limits.
      maxTokens: reservedOutputTokens,
      headers: { ...(options?.headers ?? {}), ...traceHeaders },
      signal,
    })),
    options?.signal,
    deadlineOptions,
  );
}
