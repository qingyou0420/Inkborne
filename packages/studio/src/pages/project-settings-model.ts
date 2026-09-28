export type NotifyType = "telegram" | "wechat-work" | "feishu" | "webhook";

export interface NotifyChannelDraft {
  type: NotifyType;
  botToken?: string;
  chatId?: string;
  webhookUrl?: string;
  url?: string;
  secret?: string;
  rest?: Record<string, unknown>;
}

export interface OverrideRow {
  agent: string;
  model: string;
  rest?: Record<string, unknown>;
}

export interface DetectionDraft {
  enabled: boolean;
  provider: string;
  apiUrl: string;
  apiKeyEnv: string;
  threshold: number;
  autoRewrite: boolean;
  maxRetries: number;
  rest?: Record<string, unknown>;
}

export const DEFAULT_DETECTION: DetectionDraft = {
  enabled: false,
  provider: "custom",
  apiUrl: "",
  apiKeyEnv: "",
  threshold: 0.5,
  autoRewrite: false,
  maxRetries: 3,
};

export const NOTIFY_TYPES: ReadonlyArray<{ value: NotifyType; label: string }> = [
  { value: "telegram", label: "Telegram" },
  { value: "feishu", label: "飞书 Feishu" },
  { value: "wechat-work", label: "企业微信" },
  { value: "webhook", label: "Webhook" },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function omitKeys(source: Record<string, unknown>, keys: ReadonlyArray<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanField(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function notifyDraftFromChannel(value: unknown): NotifyChannelDraft {
  const raw = asRecord(value);
  const type = raw.type === "telegram" || raw.type === "wechat-work" || raw.type === "feishu" || raw.type === "webhook"
    ? raw.type
    : "webhook";
  return {
    type,
    botToken: stringField(raw.botToken),
    chatId: stringField(raw.chatId),
    webhookUrl: stringField(raw.webhookUrl),
    url: stringField(raw.url),
    secret: stringField(raw.secret),
    rest: omitKeys(raw, ["type", "botToken", "chatId", "webhookUrl", "url", "secret"]),
  };
}

export function buildNotifyChannel(d: NotifyChannelDraft): Record<string, unknown> {
  if (d.type === "telegram") {
    return { ...(d.rest ?? {}), type: "telegram", botToken: d.botToken ?? "", chatId: d.chatId ?? "" };
  }
  if (d.type === "wechat-work") {
    return { ...(d.rest ?? {}), type: "wechat-work", webhookUrl: d.webhookUrl ?? "" };
  }
  if (d.type === "feishu") {
    return { ...(d.rest ?? {}), type: "feishu", webhookUrl: d.webhookUrl ?? "" };
  }
  const base: Record<string, unknown> = { ...(d.rest ?? {}), type: "webhook", url: d.url ?? "" };
  if (d.secret) base.secret = d.secret;
  else delete base.secret;
  if (!("events" in base)) base.events = [];
  return base;
}

export function detectionDraftFromConfig(value: unknown): DetectionDraft {
  const raw = asRecord(value);
  if (Object.keys(raw).length === 0) return { ...DEFAULT_DETECTION };
  return {
    enabled: booleanField(raw.enabled, true),
    provider: stringField(raw.provider) ?? DEFAULT_DETECTION.provider,
    apiUrl: stringField(raw.apiUrl) ?? DEFAULT_DETECTION.apiUrl,
    apiKeyEnv: stringField(raw.apiKeyEnv) ?? DEFAULT_DETECTION.apiKeyEnv,
    threshold: numberField(raw.threshold, DEFAULT_DETECTION.threshold),
    autoRewrite: booleanField(raw.autoRewrite, DEFAULT_DETECTION.autoRewrite),
    maxRetries: numberField(raw.maxRetries, DEFAULT_DETECTION.maxRetries),
    rest: omitKeys(raw, ["enabled", "provider", "apiUrl", "apiKeyEnv", "threshold", "autoRewrite", "maxRetries"]),
  };
}

const LEGACY_AGENT_LABELS: Readonly<Record<string, string>> = {
  writer: "落笔",
  reviser: "落笔",
  settler: "落笔",
  architect: "研墨",
  planner: "织卷",
  composer: "织卷",
  auditor: "审查",
  continuity: "审查",
};

export function legacyAgentLabel(agent: string): string {
  const trimmed = agent.trim();
  return LEGACY_AGENT_LABELS[trimmed] ?? trimmed;
}

export function buildDetectionConfig(det: DetectionDraft): Record<string, unknown> | null {
  if (!det.enabled) return null;
  return {
    ...(det.rest ?? {}),
    provider: det.provider,
    apiUrl: det.apiUrl,
    apiKeyEnv: det.apiKeyEnv,
    threshold: det.threshold,
    enabled: true,
    autoRewrite: det.autoRewrite,
    maxRetries: det.maxRetries,
  };
}
