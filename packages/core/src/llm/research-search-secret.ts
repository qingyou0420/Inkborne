/**
 * Research-search API key lives next to model secrets, not in inkos.json.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ResearchSearchConfigSchema, type ResearchSearchConfig } from "../models/project.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { maskApiKey, resolveUserDataDir } from "./secrets.js";

const FILE_NAME = "research-search.json";

export interface ResearchSearchPublic {
  readonly enabled: boolean;
  readonly provider: "tavily" | "custom";
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly configured: boolean;
  readonly last4: string;
}

function secretPath(projectRoot: string): string {
  const userDir = resolveUserDataDir();
  if (userDir) return join(userDir, FILE_NAME);
  return join(projectRoot, ".inkos", FILE_NAME);
}

async function readSecretKey(path: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as { apiKey?: unknown };
    return typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
  } catch {
    return "";
  }
}

async function writeSecretKey(path: string, apiKey: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const body = `${JSON.stringify({ apiKey }, null, 2)}\n`;
  try {
    await writeFile(tmp, body, { encoding: "utf-8", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readProjectRaw(projectRoot: string): Promise<{ text: string; raw: Record<string, unknown> } | undefined> {
  try {
    const text = await readFile(join(projectRoot, "inkos.json"), "utf-8");
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    return { text, raw };
  } catch {
    return undefined;
  }
}

function sectionKey(raw: Record<string, unknown>): string {
  const section = raw.researchSearch;
  if (!section || typeof section !== "object" || Array.isArray(section)) return "";
  const apiKey = (section as { apiKey?: unknown }).apiKey;
  return typeof apiKey === "string" ? apiKey.trim() : "";
}

/** Copy a key out of inkos.json. A failed write leaves that file byte-for-byte. */
export async function migrateResearchSearchKey(projectRoot: string): Promise<void> {
  const loaded = await readProjectRaw(projectRoot);
  if (!loaded) return;
  const legacyKey = sectionKey(loaded.raw);
  if (!legacyKey) return;
  const dest = secretPath(projectRoot);
  const existing = await readSecretKey(dest);
  const nextKey = existing || legacyKey;
  await writeSecretKey(dest, nextKey);
  const verified = await readSecretKey(dest);
  if (verified !== nextKey) return;
  const section = loaded.raw.researchSearch as Record<string, unknown>;
  delete section.apiKey;
  await writeFileAtomic(join(projectRoot, "inkos.json"), `${JSON.stringify(loaded.raw, null, 2)}\n`);
}

function publicFrom(config: ResearchSearchConfig, apiKey: string): ResearchSearchPublic {
  const masked = maskApiKey(apiKey);
  return {
    enabled: config.enabled,
    provider: config.provider,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiKeyEnv ? { apiKeyEnv: config.apiKeyEnv } : {}),
    configured: masked.configured,
    last4: masked.last4,
  };
}

function withoutKey(config: ResearchSearchConfig): ResearchSearchConfig {
  const next = { ...config };
  delete next.apiKey;
  return next;
}

export async function loadResearchSearchRuntime(projectRoot: string): Promise<ResearchSearchConfig> {
  try {
    await migrateResearchSearchKey(projectRoot);
  } catch {
    // Keep the project file. The key below still falls back to it.
  }
  const loaded = await readProjectRaw(projectRoot);
  const parsed = ResearchSearchConfigSchema.parse(loaded?.raw.researchSearch ?? {});
  const stored = await readSecretKey(secretPath(projectRoot));
  const apiKey = stored || parsed.apiKey?.trim() || "";
  return apiKey ? { ...withoutKey(parsed), apiKey } : withoutKey(parsed);
}

export async function readResearchSearchPublic(projectRoot: string): Promise<ResearchSearchPublic> {
  const runtime = await loadResearchSearchRuntime(projectRoot);
  return publicFrom(runtime, runtime.apiKey ?? "");
}

export async function saveResearchSearchSettings(
  projectRoot: string,
  input: {
    readonly enabled?: boolean;
    readonly provider?: "tavily" | "custom";
    readonly baseUrl?: string;
    readonly apiKeyEnv?: string;
    /** Absent keeps the stored key. Empty string clears it. */
    readonly apiKey?: string;
  },
): Promise<ResearchSearchPublic> {
  try {
    await migrateResearchSearchKey(projectRoot);
  } catch {
    // Migration can fail closed; a new key is still written below when provided.
  }
  const loaded = await readProjectRaw(projectRoot);
  const current = ResearchSearchConfigSchema.parse(loaded?.raw.researchSearch ?? {});
  const dest = secretPath(projectRoot);
  let apiKey = await readSecretKey(dest);
  if (!apiKey) apiKey = current.apiKey?.trim() ?? "";
  if (input.apiKey !== undefined) {
    apiKey = input.apiKey.trim();
    await writeSecretKey(dest, apiKey);
    const verified = await readSecretKey(dest);
    if (verified !== apiKey) throw new Error("检索密钥没有写进用户数据目录");
  }
  const next: ResearchSearchConfig = {
    enabled: input.enabled ?? current.enabled,
    provider: input.provider ?? current.provider,
    ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : current.baseUrl ? { baseUrl: current.baseUrl } : {}),
    ...(input.apiKeyEnv?.trim() ? { apiKeyEnv: input.apiKeyEnv.trim() } : current.apiKeyEnv ? { apiKeyEnv: current.apiKeyEnv } : {}),
  };
  if (loaded) {
    loaded.raw.researchSearch = next;
    await writeFileAtomic(join(projectRoot, "inkos.json"), `${JSON.stringify(loaded.raw, null, 2)}\n`);
  }
  return publicFrom(next, apiKey);
}
