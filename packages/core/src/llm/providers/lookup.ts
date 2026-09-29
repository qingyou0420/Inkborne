import type { InkosModel } from "./types.js";
import { getAllEndpoints, getEndpoint } from "./index.js";

/**
 * provider id 优先级。Layer 2 全局扫时同 id 多条匹配按这个顺序取第一条，
 * 保证结果确定性。白名单外的 provider 视同 999（排最后）。
 */
const PROVIDER_PRIORITY: readonly string[] = [
  "anthropic", "openai", "google", "deepseek", "bailian", "moonshot", "kimicode",
  "zhipu", "minimax", "xai",
  "siliconcloud",
  "openrouter", "aihubmix", "novita",
];

// Explicit gateway IDs only: never strip arbitrary vendor prefixes. These
// limits were checked against ZenMux's route metadata on 2026-09-17. Gemini's
// gateway limit is one token below Google's native API limit (65,536).
// https://zenmux.ai/google/gemini-3.1-pro-preview
// https://zenmux.ai/anthropic/claude-opus-5
// Opus 5.5 verified on 2026-09-23:
// https://zenmux.ai/anthropic/claude-opus-5.5
const VERIFIED_GATEWAY_MODELS: readonly InkosModel[] = [
  {
    id: "google/gemini-3.1-pro-preview",
    maxOutput: 65_535,
    contextWindowTokens: 1_048_576,
  },
  {
    id: "anthropic/claude-opus-5",
    maxOutput: 128_000,
    contextWindowTokens: 1_000_000,
  },
  {
    id: "anthropic/claude-opus-5.5",
    maxOutput: 128_000,
    contextWindowTokens: 1_000_000,
  },
];

/**
 * 三层 lookup：
 * - Layer 1: 已知 provider 精确查（整串比较，不拆斜线）
 * - Layer 2: 全局扫所有 provider 的 models，按 provider id 优先级取第一条
 * - Layer 3: 已核实的精确聚合商 ID（保留完整请求 ID，不拆斜线）
 * - 都 miss: 返回 undefined，调用方走保守默认
 *
 * 不做斜线前缀拆分。lobe 的 processModelList 证实了"靠调用入口带 provider 消歧"
 * 是对的做法，斜线拆分对 PPIO / SiliconCloud 原生命名会误匹配。
 */
export function lookupModel(
  serviceId: string,
  modelId: string,
): InkosModel | undefined {
  const lowerId = modelId.toLowerCase();

  const provider = getEndpoint(serviceId);
  if (provider) {
    const hit = provider.models.find((m) => m.id.toLowerCase() === lowerId);
    if (hit) return hit;
  }

  const matches: Array<{ model: InkosModel; providerId: string }> = [];
  for (const p of getAllEndpoints()) {
    const hit = p.models.find((m) => m.id.toLowerCase() === lowerId);
    if (hit) matches.push({ model: hit, providerId: p.id });
  }
  if (matches.length === 0) {
    return VERIFIED_GATEWAY_MODELS.find((model) => model.id.toLowerCase() === lowerId);
  }

  matches.sort((a, b) => {
    const ai = PROVIDER_PRIORITY.indexOf(a.providerId);
    const bi = PROVIDER_PRIORITY.indexOf(b.providerId);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  return matches[0].model;
}

/** 某 service 下可用（enabled !== false）的模型列表 */
export function listEnabledModels(serviceId: string): InkosModel[] {
  const provider = getEndpoint(serviceId);
  if (!provider) return [];
  return provider.models.filter((m) => m.enabled !== false);
}

export function isActiveTextModel(model: InkosModel): boolean {
  if (model.enabled === false) return false;
  if (model.status === "disabled" || model.status === "deprecated" || model.status === "nonText") return false;
  if (model.capabilities?.text === false) return false;
  if (model.capabilities?.imageOutput === true && model.capabilities?.text !== true) return false;
  return true;
}

export function listActiveTextModels(serviceId: string): InkosModel[] {
  const provider = getEndpoint(serviceId);
  if (!provider) return [];
  return provider.models.filter(isActiveTextModel);
}
