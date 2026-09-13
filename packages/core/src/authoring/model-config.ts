/**
 * Eight-role authoring model resolution. Shared connections, independent saves.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getEndpoint } from "../llm/providers/index.js";
import { resolveServicePreset } from "../llm/service-presets.js";
import { loadSecrets, type SecretsFile } from "../llm/secrets.js";
import type { AgentLLMOverride, LLMConfig, ProjectConfig } from "../models/project.js";
import {
  AUTHORING_ROLE_IDS,
  AUTHORING_ROLE_META,
  AuthoringRoleConfigSchema,
  AuthoringRolesSchema,
  type AuthoringRoleConfig,
  type AuthoringRoleId,
  type AuthoringRoles,
  type AuthoringStage,
  type ResolvedAuthoringRole,
} from "./types.js";

export { AUTHORING_ROLE_IDS, AUTHORING_ROLE_META };

const LEGACY_AGENT_TO_ROLE: Readonly<Record<string, AuthoringRoleId>> = {
  architect: "ground.main",
  "foundation-reviewer": "ground.review",
  "volume-map-materializer": "weave.main",
  planner: "weave.main",
  composer: "weave.main",
  writer: "write.main",
  reviser: "write.main",
  settler: "write.main",
  "state-validator": "write.main",
  stateValidator: "write.main",
  "chapter-analyzer": "write.main",
  auditor: "write.review",
  continuity: "write.review",
};

export const DEFAULT_ROLE_INSTRUCTIONS: Readonly<Record<AuthoringRoleId, string>> = {
  "ask.main": "你是「问心」。通过对话理解作者想写的故事，整理成可编辑的故事正典：一句话故事、核心命题、主角欲望、主要冲突、视角文风、边界与待定项。不要擅自补全作者明确保留的未知，不要生成人物卡或卷纲。",
  "ask.review": "你是「问心审查」。只阅读故事正典，判断是否理解作者意图、核心矛盾是否清晰、前提是否自相矛盾、篇幅与构想是否匹配。开放结局和作者主动保留的未知不是缺陷。不要改稿。",
  "ground.main": "你是「研墨」。根据已采用正典生成适合本书的设定目录与条目。人物、地点、规则等按小说需要增减，不强制修炼体系。只改指定范围，保留未选手改。",
  "ground.review": "你是「研墨审查」。检查设定与正典是否一致、人物动机是否可用、世界规则是否自洽、有无重复或缺失。把风格建议和确定冲突分开。不要改设定正文。",
  "weave.main": "你是「织卷」。根据正典与设定规划全书大纲、卷纲和每章概要。用户选择全书时必须覆盖全部目标章，可分批。不要重写已采用正文。",
  "weave.review": "你是「织卷审查」。检查大纲是否符合正典、设定能否支撑事件、人物因果、节奏、伏笔计划，以及指定范围内有无漏章。报告必须写明实际覆盖范围。不要改大纲。",
  "write.main": "你是「落笔」。按已采用正典、设定、章概要和前文写正文或按意见修改。默认只改指定范围。新摘要与人物状态只属于本候选稿，未经采用不得推进正式连载状态。",
  "write.review": "你是「落笔审查」。检查正文与正典/设定/章概要及已采用前文的一致性，指出人物、时空、伏笔、视角与节奏问题。用原文证据，不把审美判断写成事实错误。不要改正文。",
};

function cloneLlm(llm: LLMConfig): LLMConfig {
  return {
    ...llm,
    extra: llm.extra ? { ...llm.extra } : undefined,
    headers: llm.headers ? { ...llm.headers } : undefined,
    services: llm.services ? llm.services.map((entry) => ({ ...entry })) : undefined,
  };
}

export function mapAgentNameToRole(agentName: string): AuthoringRoleId | undefined {
  const trimmed = agentName.trim();
  if (AUTHORING_ROLE_IDS.includes(trimmed as AuthoringRoleId)) {
    return trimmed as AuthoringRoleId;
  }
  return LEGACY_AGENT_TO_ROLE[trimmed];
}

export function parseAuthoringRoles(raw: unknown): AuthoringRoles {
  const parsed = AuthoringRolesSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

export function roleConfigFromLegacyOverride(override: string | AgentLLMOverride | undefined): AuthoringRoleConfig {
  if (!override) return {};
  if (typeof override === "string") return { modelId: override };
  return {
    modelId: override.model,
    serviceRef: undefined,
    stream: override.stream,
  };
}

export function fillMissingAuthoringRoles(config: ProjectConfig): AuthoringRoles {
  const existing = parseAuthoringRoles(config.authoringRoles);
  const filled: AuthoringRoles = { ...existing };
  const defaultModel = config.llm.defaultModel?.trim() || config.llm.model;
  const defaultService = config.llm.service;
  for (const roleId of AUTHORING_ROLE_IDS) {
    if (filled[roleId]?.modelId) continue;
    const mappedAgents = Object.entries(LEGACY_AGENT_TO_ROLE)
      .filter(([, mapped]) => mapped === roleId)
      .map(([agent]) => agent);
    let imported: AuthoringRoleConfig = {};
    for (const agent of mappedAgents) {
      const override = config.modelOverrides?.[agent];
      if (override) {
        imported = roleConfigFromLegacyOverride(override);
        break;
      }
    }
    filled[roleId] = {
      serviceRef: imported.serviceRef ?? defaultService,
      modelId: imported.modelId ?? defaultModel,
      stream: imported.stream ?? config.llm.stream,
      temperature: imported.temperature ?? config.llm.temperature,
      thinkingBudget: imported.thinkingBudget ?? config.llm.thinkingBudget,
      ...(imported.apiFormat ? { apiFormat: imported.apiFormat } : {}),
      instructions: DEFAULT_ROLE_INSTRUCTIONS[roleId],
      instructionsVersion: 1,
      lastTestStatus: "untested",
      ...existing[roleId],
    };
  }
  return filled;
}

function namedServiceEntry(llm: LLMConfig, serviceRef: string) {
  return llm.services?.find((entry) => {
    const id = entry.name ? `${entry.service}:${entry.name}` : entry.service;
    return id === serviceRef || entry.service === serviceRef;
  });
}

export function apiKeysFromSecrets(secrets: SecretsFile): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [service, entry] of Object.entries(secrets.services)) {
    if (entry?.apiKey) keys[service] = entry.apiKey;
  }
  return keys;
}

export async function loadRoleApiKeys(projectRoot: string): Promise<Record<string, string>> {
  return apiKeysFromSecrets(await loadSecrets(projectRoot));
}

export function loadRoleApiKeysSync(projectRoot: string): Record<string, string> {
  try {
    const raw = readFileSync(join(projectRoot, ".inkos", "secrets.json"), "utf-8");
    const parsed = JSON.parse(raw) as SecretsFile;
    if (!parsed || typeof parsed !== "object" || !parsed.services) return {};
    return apiKeysFromSecrets(parsed);
  } catch {
    return {};
  }
}

export function applyServiceToLlm(
  llm: LLMConfig,
  serviceRef: string,
  options?: { readonly apiKey?: string; readonly apiKeys?: Record<string, string> },
): LLMConfig {
  const next = cloneLlm(llm);
  const previousService = next.service;
  next.service = serviceRef;
  const endpoint = getEndpoint(serviceRef);
  const preset = resolveServicePreset(serviceRef);
  const named = namedServiceEntry(next, serviceRef);
  if (endpoint?.baseUrl) next.baseUrl = endpoint.baseUrl;
  else if (preset?.baseUrl) next.baseUrl = preset.baseUrl;
  else if (named?.baseUrl) next.baseUrl = named.baseUrl;
  if (named?.apiFormat) next.apiFormat = named.apiFormat;
  if (typeof named?.stream === "boolean") next.stream = named.stream;
  if (typeof named?.temperature === "number") next.temperature = named.temperature;
  const switched = serviceRef !== previousService;
  const resolvedKey = options?.apiKey
    ?? options?.apiKeys?.[serviceRef]
    ?? options?.apiKeys?.[serviceRef.split(":")[0] ?? serviceRef];
  if (typeof resolvedKey === "string") next.apiKey = resolvedKey;
  else if (switched) next.apiKey = "";
  return next;
}

export function resolveAuthoringRole(input: {
  readonly roleId: AuthoringRoleId;
  readonly baseLlm: LLMConfig;
  readonly roles?: AuthoringRoles;
  readonly temporary?: AuthoringRoleConfig;
  readonly apiKeys?: Record<string, string>;
}): ResolvedAuthoringRole {
  const stored = input.roles?.[input.roleId] ?? {};
  const temporary = input.temporary ?? {};
  const merged: AuthoringRoleConfig = { ...stored, ...temporary };
  const serviceChanged = Boolean(temporary.serviceRef && temporary.serviceRef !== stored.serviceRef);
  const explicitFormat = temporary.apiFormat === "chat" || temporary.apiFormat === "responses";
  if (!explicitFormat && (serviceChanged || "apiFormat" in temporary)) {
    delete (merged as { apiFormat?: unknown }).apiFormat;
  }
  const parsed = AuthoringRoleConfigSchema.parse(merged);
  let llm = cloneLlm(input.baseLlm);
  const serviceRef = parsed.serviceRef?.trim() || llm.service || "custom";
  if (serviceRef !== llm.service || input.apiKeys?.[serviceRef]) {
    llm = applyServiceToLlm(llm, serviceRef, { apiKeys: input.apiKeys });
  }
  const modelId = parsed.modelId?.trim() || llm.defaultModel?.trim() || llm.model;
  llm.model = modelId;
  llm.service = serviceRef;
  if (typeof parsed.stream === "boolean") llm.stream = parsed.stream;
  if (typeof parsed.temperature === "number") llm.temperature = parsed.temperature;
  if (typeof parsed.thinkingBudget === "number") llm.thinkingBudget = parsed.thinkingBudget;
  if (parsed.apiFormat) llm.apiFormat = parsed.apiFormat;
  if (parsed.extra) llm.extra = { ...(llm.extra ?? {}), ...parsed.extra };
  const instructions = parsed.instructions?.trim() || DEFAULT_ROLE_INSTRUCTIONS[input.roleId];
  const instructionsVersion = parsed.instructionsVersion ?? 1;
  const snapshot = {
    roleId: input.roleId,
    serviceRef,
    modelId,
    stream: llm.stream,
    temperature: llm.temperature,
    thinkingBudget: llm.thinkingBudget,
    apiFormat: llm.apiFormat,
    extra: llm.extra ?? {},
    instructionsVersion,
  };
  return {
    roleId: input.roleId,
    serviceRef,
    modelId,
    stream: llm.stream,
    temperature: llm.temperature,
    thinkingBudget: llm.thinkingBudget,
    apiFormat: llm.apiFormat,
    extra: llm.extra,
    instructions,
    instructionsVersion,
    llm,
    snapshot,
  };
}

export function resolveRoleForAgent(input: {
  readonly agentName: string;
  readonly baseLlm: LLMConfig;
  readonly roles?: AuthoringRoles;
  readonly apiKeys?: Record<string, string>;
}): ResolvedAuthoringRole | undefined {
  const roleId = mapAgentNameToRole(input.agentName);
  if (!roleId) return undefined;
  return resolveAuthoringRole({
    roleId,
    baseLlm: input.baseLlm,
    roles: input.roles,
    apiKeys: input.apiKeys,
  });
}

export async function resolveProjectRole(input: {
  readonly roleId: AuthoringRoleId;
  readonly project: ProjectConfig;
  readonly projectRoot?: string;
  readonly temporary?: AuthoringRoleConfig;
}): Promise<ResolvedAuthoringRole> {
  const apiKeys = input.projectRoot ? await loadRoleApiKeys(input.projectRoot) : undefined;
  return resolveAuthoringRole({
    roleId: input.roleId,
    baseLlm: input.project.llm,
    roles: fillMissingAuthoringRoles(input.project),
    temporary: input.temporary,
    apiKeys,
  });
}

export function stageRoles(stage: AuthoringStage): readonly AuthoringRoleId[] {
  return AUTHORING_ROLE_IDS.filter((id) => AUTHORING_ROLE_META[id].stage === stage);
}

export function copyRoleConfig(
  source: AuthoringRoleConfig,
  options?: { readonly includeInstructions?: boolean },
): AuthoringRoleConfig {
  return {
    serviceRef: source.serviceRef,
    modelId: source.modelId,
    stream: source.stream,
    temperature: source.temperature,
    thinkingBudget: source.thinkingBudget,
    apiFormat: source.apiFormat,
    extra: source.extra ? { ...source.extra } : undefined,
    ...(options?.includeInstructions
      ? { instructions: source.instructions, instructionsVersion: source.instructionsVersion }
      : {}),
  };
}
