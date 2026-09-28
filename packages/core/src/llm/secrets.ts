import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SecretsFile {
  services: Record<string, { apiKey: string }>;
}

export interface SecretsLoadOptions {
  /** `undefined` reads `INKOS_USER_DATA`. `null` or `""` keeps the project file. */
  readonly userDataDir?: string | null;
}

const SECRETS_DIR = ".inkos";
const SECRETS_FILE = "secrets.json";

const LEGACY_SERVICE_ID_REMAP: Record<string, string> = {
  siliconflow: "siliconcloud",
};

interface ReadSnapshot {
  readonly exists: boolean;
  readonly corrupt: boolean;
  readonly data: SecretsFile;
}

interface SecretsAction {
  readonly result: SecretsFile;
  readonly writeUser: SecretsFile | null;
  readonly writeLegacy: SecretsFile | null;
  readonly scrubLegacy: boolean;
}

function emptySecrets(): SecretsFile {
  return { services: {} };
}

function cloneSecrets(data: SecretsFile): SecretsFile {
  const services: Record<string, { apiKey: string }> = {};
  for (const [id, entry] of Object.entries(data.services)) {
    services[id] = { apiKey: entry?.apiKey ?? "" };
  }
  return { services };
}

export function resolveUserDataDir(options?: SecretsLoadOptions): string | null {
  if (options && Object.prototype.hasOwnProperty.call(options, "userDataDir")) {
    const value = options.userDataDir?.trim();
    return value || null;
  }
  const fromEnv = process.env.INKOS_USER_DATA?.trim();
  return fromEnv || null;
}

export function legacySecretsPath(projectRoot: string): string {
  return join(projectRoot, SECRETS_DIR, SECRETS_FILE);
}

export function userSecretsPath(userDataDir: string): string {
  return join(userDataDir, SECRETS_FILE);
}

export function maskApiKey(apiKey: string | undefined | null): { configured: boolean; last4: string } {
  const trimmed = apiKey?.trim() ?? "";
  if (!trimmed) return { configured: false, last4: "" };
  return { configured: true, last4: trimmed.slice(-4) };
}

export function describeSecretsLocation(userDataDir?: string | null): { scope: "user-data" | "project"; hint: string } {
  const dir = userDataDir === undefined ? resolveUserDataDir() : (userDataDir?.trim() || null);
  if (dir) {
    return {
      scope: "user-data",
      hint: "密钥只存在本机用户数据目录（与应用配置、日志放在一起），不会放进书稿文件夹。",
    };
  }
  return {
    scope: "project",
    hint: "当前密钥还在项目里的 .inkos/secrets.json。用桌面版打开后会自动迁到本机用户数据目录。",
  };
}

function nonEmptyKeys(data: SecretsFile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, entry] of Object.entries(data.services)) {
    const apiKey = entry?.apiKey?.trim() ?? "";
    if (apiKey) out[id] = apiKey;
  }
  return out;
}

function sameNonEmptyKeys(left: SecretsFile, right: SecretsFile): boolean {
  const a = nonEmptyKeys(left);
  const b = nonEmptyKeys(right);
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const id of ids) {
    if (a[id] !== b[id]) return false;
  }
  return true;
}

function legacyKeysStillPresent(saved: SecretsFile, legacy: SecretsFile): boolean {
  const remapped = migrateLegacyServiceIds(cloneSecrets(legacy)).data;
  for (const id of Object.keys(nonEmptyKeys(remapped))) {
    if (!saved.services[id]?.apiKey?.trim()) return false;
  }
  return true;
}

function mergeSecrets(primary: SecretsFile, fallback: SecretsFile): SecretsFile {
  const services: Record<string, { apiKey: string }> = {};
  for (const [id, apiKey] of Object.entries(nonEmptyKeys(fallback))) {
    services[id] = { apiKey };
  }
  for (const [id, apiKey] of Object.entries(nonEmptyKeys(primary))) {
    services[id] = { apiKey };
  }
  return { services };
}

function migrateLegacyServiceIds(secrets: SecretsFile): { data: SecretsFile; changed: boolean } {
  let changed = false;
  for (const [oldId, newId] of Object.entries(LEGACY_SERVICE_ID_REMAP)) {
    if (secrets.services[oldId] && !secrets.services[newId]) {
      secrets.services[newId] = secrets.services[oldId];
      delete secrets.services[oldId];
      changed = true;
    }
  }
  return { data: secrets, changed };
}

function normalizeSecrets(parsed: unknown): SecretsFile {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptySecrets();
  const services = (parsed as SecretsFile).services;
  if (!services || typeof services !== "object" || Array.isArray(services)) return emptySecrets();
  const clean: Record<string, { apiKey: string }> = {};
  for (const [id, entry] of Object.entries(services)) {
    if (!entry || typeof entry !== "object") continue;
    const apiKey = typeof (entry as { apiKey?: unknown }).apiKey === "string"
      ? (entry as { apiKey: string }).apiKey
      : "";
    clean[id] = { apiKey };
  }
  return { services: clean };
}

function snapshotFromRaw(raw: string | null, missing: boolean): ReadSnapshot {
  if (missing) return { exists: false, corrupt: false, data: emptySecrets() };
  try {
    return { exists: true, corrupt: false, data: normalizeSecrets(JSON.parse(raw ?? "")) };
  } catch {
    return { exists: true, corrupt: true, data: emptySecrets() };
  }
}

function decideSecretsAction(user: ReadSnapshot, legacy: ReadSnapshot, userDataEnabled: boolean): SecretsAction {
  if (!userDataEnabled) {
    if (!legacy.exists || legacy.corrupt) {
      return { result: emptySecrets(), writeUser: null, writeLegacy: null, scrubLegacy: false };
    }
    const { data, changed } = migrateLegacyServiceIds(cloneSecrets(legacy.data));
    return {
      result: data,
      writeUser: null,
      writeLegacy: changed ? data : null,
      scrubLegacy: false,
    };
  }

  if (user.corrupt) {
    const source = legacy.corrupt ? emptySecrets() : cloneSecrets(legacy.data);
    const { data } = migrateLegacyServiceIds(source);
    return { result: data, writeUser: null, writeLegacy: null, scrubLegacy: false };
  }

  const baseUser = user.exists ? user.data : emptySecrets();
  const baseLegacy = !legacy.exists || legacy.corrupt ? emptySecrets() : legacy.data;
  const { data: merged } = migrateLegacyServiceIds(mergeSecrets(baseUser, baseLegacy));
  const hasKeys = Object.keys(nonEmptyKeys(merged)).length > 0;
  const userChanged = !sameNonEmptyKeys(baseUser, merged);
  const writeUser = userChanged && (user.exists || hasKeys) ? merged : null;
  const scrubLegacy = !legacy.corrupt
    && legacy.exists
    && Object.keys(nonEmptyKeys(legacy.data)).length > 0
    && legacyKeysStillPresent(merged, legacy.data);
  return { result: merged, writeUser, writeLegacy: null, scrubLegacy };
}

function serializeSecrets(secrets: SecretsFile): string {
  return `${JSON.stringify({ services: secrets.services }, null, 2)}\n`;
}

function snapshotFromReadError(error: unknown): ReadSnapshot {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return snapshotFromRaw(null, true);
  if (code === "EISDIR" || code === "EACCES" || code === "EPERM") {
    return { exists: true, corrupt: true, data: emptySecrets() };
  }
  throw error;
}

async function readSnapshot(path: string): Promise<ReadSnapshot> {
  try {
    const raw = await readFile(path, "utf-8");
    return snapshotFromRaw(raw, false);
  } catch (error) {
    return snapshotFromReadError(error);
  }
}

function readSnapshotSync(path: string): ReadSnapshot {
  try {
    const raw = readFileSync(path, "utf-8");
    return snapshotFromRaw(raw, false);
  } catch (error) {
    return snapshotFromReadError(error);
  }
}

async function writeSecretsAtomic(path: string, secrets: SecretsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, serializeSecrets(secrets), { encoding: "utf-8", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function writeSecretsAtomicSync(path: string, secrets: SecretsFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, serializeSecrets(secrets), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

async function applySecretsAction(
  action: SecretsAction,
  paths: { readonly userPath: string | null; readonly legacyPath: string },
): Promise<SecretsFile> {
  let scrub = action.scrubLegacy;
  if (action.writeLegacy) {
    try {
      await writeSecretsAtomic(paths.legacyPath, action.writeLegacy);
    } catch {
      return action.result;
    }
  }
  if (action.writeUser && paths.userPath) {
    try {
      await writeSecretsAtomic(paths.userPath, action.writeUser);
      const verify = await readSnapshot(paths.userPath);
      if (verify.corrupt || !sameNonEmptyKeys(verify.data, action.writeUser)) {
        return action.result;
      }
    } catch {
      return action.result;
    }
  }
  if (scrub) {
    try {
      await writeSecretsAtomic(paths.legacyPath, emptySecrets());
    } catch {
      /* 迁过去了但旧文件还在，下次再清。密钥没有丢。 */
    }
  }
  return action.result;
}

function applySecretsActionSync(
  action: SecretsAction,
  paths: { readonly userPath: string | null; readonly legacyPath: string },
): SecretsFile {
  if (action.writeLegacy) {
    try {
      writeSecretsAtomicSync(paths.legacyPath, action.writeLegacy);
    } catch {
      return action.result;
    }
  }
  if (action.writeUser && paths.userPath) {
    try {
      writeSecretsAtomicSync(paths.userPath, action.writeUser);
      const verify = readSnapshotSync(paths.userPath);
      if (verify.corrupt || !sameNonEmptyKeys(verify.data, action.writeUser)) {
        return action.result;
      }
    } catch {
      return action.result;
    }
  }
  if (action.scrubLegacy) {
    try {
      writeSecretsAtomicSync(paths.legacyPath, emptySecrets());
    } catch {
      /* keep legacy */
    }
  }
  return action.result;
}

export async function loadSecrets(projectRoot: string, options?: SecretsLoadOptions): Promise<SecretsFile> {
  const userDir = resolveUserDataDir(options);
  const legacyPath = legacySecretsPath(projectRoot);
  const legacy = await readSnapshot(legacyPath);
  if (!userDir) {
    return applySecretsAction(decideSecretsAction(snapshotFromRaw(null, true), legacy, false), {
      userPath: null,
      legacyPath,
    });
  }
  const userPath = userSecretsPath(userDir);
  const user = await readSnapshot(userPath);
  return applySecretsAction(decideSecretsAction(user, legacy, true), { userPath, legacyPath });
}

export function loadSecretsSync(projectRoot: string, options?: SecretsLoadOptions): SecretsFile {
  const userDir = resolveUserDataDir(options);
  const legacyPath = legacySecretsPath(projectRoot);
  const legacy = readSnapshotSync(legacyPath);
  if (!userDir) {
    return applySecretsActionSync(decideSecretsAction(snapshotFromRaw(null, true), legacy, false), {
      userPath: null,
      legacyPath,
    });
  }
  const userPath = userSecretsPath(userDir);
  const user = readSnapshotSync(userPath);
  return applySecretsActionSync(decideSecretsAction(user, legacy, true), { userPath, legacyPath });
}

export async function saveSecrets(
  projectRoot: string,
  secrets: SecretsFile,
  options?: SecretsLoadOptions,
): Promise<void> {
  const normalized = normalizeSecrets(secrets);
  const userDir = resolveUserDataDir(options);
  const legacyPath = legacySecretsPath(projectRoot);
  if (!userDir) {
    await writeSecretsAtomic(legacyPath, normalized);
    return;
  }
  const userPath = userSecretsPath(userDir);
  await writeSecretsAtomic(userPath, normalized);
  const verify = await readSnapshot(userPath);
  if (verify.corrupt || !sameNonEmptyKeys(verify.data, normalized)) {
    throw new Error("密钥没有写进本机用户数据目录，项目里的旧文件未改动");
  }
  const legacy = await readSnapshot(legacyPath);
  if (!legacy.corrupt && legacy.exists && legacyKeysStillPresent(normalized, legacy.data) && Object.keys(nonEmptyKeys(legacy.data)).length > 0) {
    try {
      await writeSecretsAtomic(legacyPath, emptySecrets());
    } catch {
      /* 新位置已经写好。旧文件清不掉时留下，下次读取再清。 */
    }
  }
}

export async function getServiceApiKey(
  projectRoot: string,
  service: string,
  options?: SecretsLoadOptions,
): Promise<string | null> {
  const secrets = await loadSecrets(projectRoot, options);
  const entry = secrets.services[service];
  if (entry?.apiKey) return entry.apiKey;

  const envKey = `${service.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_API_KEY`;
  if (process.env[envKey]) return process.env[envKey]!;

  return null;
}
