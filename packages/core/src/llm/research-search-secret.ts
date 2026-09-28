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

export const RESEARCH_SEARCH_KEY_NOT_STORED = "检索密钥没有写进用户数据目录";

export interface ResearchSearchPublic {
  readonly enabled: boolean;
  readonly provider: "tavily" | "custom";
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly configured: boolean;
  readonly last4: string;
  /**
   * Where the key reported here was read back from.
   * `project` means it is still in inkos.json and has not been migrated.
   * Absent when no key is configured.
   */
  readonly keyStorage?: "user-data" | "project";
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

/** Copy a key out of inkos.json. A failed write leaves that file byte-for-byte.
 *  A different key already in the user directory is kept, and the project key stays.
 */
export async function migrateResearchSearchKey(projectRoot: string): Promise<void> {
  const loaded = await readProjectRaw(projectRoot);
  if (!loaded) return;
  const legacyKey = sectionKey(loaded.raw);
  if (!legacyKey) return;
  const dest = secretPath(projectRoot);
  const existing = await readSecretKey(dest);
  if (existing && existing !== legacyKey) return;
  await writeSecretKey(dest, legacyKey);
  const verified = await readSecretKey(dest);
  if (verified !== legacyKey) return;
  const section = loaded.raw.researchSearch as Record<string, unknown>;
  delete section.apiKey;
  await writeFileAtomic(join(projectRoot, "inkos.json"), `${JSON.stringify(loaded.raw, null, 2)}\n`);
}

function publicFrom(
  config: ResearchSearchConfig,
  apiKey: string,
  keyStorage?: ResearchSearchPublic["keyStorage"],
): ResearchSearchPublic {
  const masked = maskApiKey(apiKey);
  return {
    enabled: config.enabled,
    provider: config.provider,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiKeyEnv ? { apiKeyEnv: config.apiKeyEnv } : {}),
    configured: masked.configured,
    last4: masked.last4,
    ...(keyStorage && masked.configured ? { keyStorage } : {}),
  };
}

function nextSettings(
  input: {
    readonly enabled?: boolean;
    readonly provider?: "tavily" | "custom";
    readonly baseUrl?: string;
    readonly apiKeyEnv?: string;
  },
  current: ResearchSearchConfig,
): ResearchSearchConfig {
  return {
    enabled: input.enabled ?? current.enabled,
    provider: input.provider ?? current.provider,
    ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : current.baseUrl ? { baseUrl: current.baseUrl } : {}),
    ...(input.apiKeyEnv?.trim() ? { apiKeyEnv: input.apiKeyEnv.trim() } : current.apiKeyEnv ? { apiKeyEnv: current.apiKeyEnv } : {}),
  };
}

function sameSettings(left: ResearchSearchConfig, right: ResearchSearchConfig): boolean {
  return left.enabled === right.enabled
    && left.provider === right.provider
    && (left.baseUrl ?? "") === (right.baseUrl ?? "")
    && (left.apiKeyEnv ?? "") === (right.apiKeyEnv ?? "");
}

function rawSection(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const section = raw.researchSearch;
  if (!section || typeof section !== "object" || Array.isArray(section)) return undefined;
  return section as Record<string, unknown>;
}

async function restoreProjectText(projectRoot: string, originalText: string | undefined): Promise<void> {
  if (originalText === undefined) return;
  const path = join(projectRoot, "inkos.json");
  const now = await readFile(path, "utf-8").catch(() => undefined);
  if (now === originalText) return;
  await writeFile(path, originalText, "utf-8");
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
  const stored = await readSecretKey(secretPath(projectRoot));
  const apiKey = runtime.apiKey ?? "";
  const keyStorage = !apiKey ? undefined : stored === apiKey ? "user-data" as const : "project" as const;
  return publicFrom(runtime, apiKey, keyStorage);
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
  const original = await readProjectRaw(projectRoot);
  const originalText = original?.text;
  const originalKey = original ? sectionKey(original.raw) : "";
  try {
    await migrateResearchSearchKey(projectRoot);
  } catch {
    // The project file is still the original bytes. A new key is attempted below.
  }
  const loaded = await readProjectRaw(projectRoot);
  const current = ResearchSearchConfigSchema.parse(loaded?.raw.researchSearch ?? {});
  const projectKey = loaded ? sectionKey(loaded.raw) : "";
  const dest = secretPath(projectRoot);
  if (input.apiKey !== undefined) {
    const nextKey = input.apiKey.trim();
    try {
      await writeSecretKey(dest, nextKey);
      const verified = await readSecretKey(dest);
      if (verified !== nextKey) throw new Error(RESEARCH_SEARCH_KEY_NOT_STORED);
    } catch {
      try {
        const verified = await readSecretKey(dest);
        if (originalKey && verified !== originalKey) await restoreProjectText(projectRoot, originalText);
      } catch {
        // The write already failed. Restoring the project file is best-effort.
      }
      throw new Error(RESEARCH_SEARCH_KEY_NOT_STORED);
    }
  }
  const verifiedUser = await readSecretKey(dest);
  const next = nextSettings(input, current);
  const activeKey = input.apiKey !== undefined ? input.apiKey.trim() : (verifiedUser || projectKey);
  const keyStorage = !activeKey ? undefined : verifiedUser === activeKey ? "user-data" as const : "project" as const;
  const projectKeyArchived = projectKey.length > 0 && verifiedUser === projectKey;
  if (!loaded) return publicFrom(next, activeKey, keyStorage);

  const section = rawSection(loaded.raw);
  const rawKey = section && typeof section.apiKey === "string" ? section.apiKey : undefined;
  const keptProjectKey = rawKey === undefined ? {} : { apiKey: rawKey };

  if (projectKey && !projectKeyArchived) {
    const cleared = input.apiKey !== undefined && input.apiKey.trim() === "" && verifiedUser === "";
    const storedNewKey = input.apiKey !== undefined && input.apiKey.trim() !== "" && verifiedUser === input.apiKey.trim();
    if (cleared) {
      loaded.raw.researchSearch = next;
      await writeFileAtomic(join(projectRoot, "inkos.json"), `${JSON.stringify(loaded.raw, null, 2)}\n`);
      return publicFrom(next, "", undefined);
    }
    if (storedNewKey && projectKey !== verifiedUser) {
      if (!sameSettings(current, next) || rawKey === undefined) {
        loaded.raw.researchSearch = { ...next, ...keptProjectKey };
        await writeFileAtomic(join(projectRoot, "inkos.json"), `${JSON.stringify(loaded.raw, null, 2)}\n`);
      }
      return publicFrom(next, activeKey, keyStorage);
    }
    if (!sameSettings(current, next)) {
      loaded.raw.researchSearch = { ...next, ...keptProjectKey };
      await writeFileAtomic(join(projectRoot, "inkos.json"), `${JSON.stringify(loaded.raw, null, 2)}\n`);
      return publicFrom(next, activeKey, "project");
    }
    return publicFrom(current, activeKey, keyStorage);
  }

  loaded.raw.researchSearch = next;
  await writeFileAtomic(join(projectRoot, "inkos.json"), `${JSON.stringify(loaded.raw, null, 2)}\n`);
  return publicFrom(next, activeKey, keyStorage);
}
