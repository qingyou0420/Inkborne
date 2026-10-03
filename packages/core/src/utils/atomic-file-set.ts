import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

export interface AtomicFileWrite {
  readonly relativePath: string;
  readonly content: string | Uint8Array;
}

export interface AtomicFileSet {
  readonly rootDir: string;
  readonly writes: ReadonlyArray<AtomicFileWrite>;
  readonly deletes?: ReadonlyArray<string>;
  readonly renameFile?: (from: string, to: string) => Promise<void>;
}

export interface AtomicRecoveryResult {
  readonly transactionDir: string;
  readonly outcome: "completed-new" | "restored-old" | "kept-for-manual-recovery" | "cleaned";
  readonly message?: string;
}

const TXN_PREFIX = ".inkos-file-txn-";
const JOURNAL_NAME = "journal.json";

type AtomicTxnPhase = "staging" | "backed-up" | "committing" | "committed" | "rollback-failed";

interface AtomicBackupRecord {
  readonly relativePath: string;
  readonly backupRelative: string;
}

interface AtomicTxnJournal {
  version: 1;
  phase: AtomicTxnPhase;
  writes: string[];
  deletes: string[];
  backups: AtomicBackupRecord[];
  installed: string[];
  created: string[];
  error?: string;
}

function safeRelativePath(relativePath: string): string {
  const normalized = normalize(relativePath);
  if (
    !relativePath.trim()
    || isAbsolute(relativePath)
    || normalized === ".."
    || normalized.startsWith(`..${sep}`)
  ) {
    throw new Error(`Atomic file path must stay inside rootDir: ${relativePath}`);
  }
  return toPosix(normalized);
}

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

let atomicWritesInFlightCount = 0;

/** How many atomic file commits are between start and finish in this process. */
export function atomicWritesInFlight(): number {
  return atomicWritesInFlightCount;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isReplaceConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}

export function isAtomicTransactionDirName(name: string): boolean {
  return name.startsWith(TXN_PREFIX);
}

async function writeJournal(transactionDir: string, journal: AtomicTxnJournal): Promise<void> {
  await writeFile(join(transactionDir, JOURNAL_NAME), `${JSON.stringify(journal, null, 2)}\n`);
}

async function readJournal(transactionDir: string): Promise<AtomicTxnJournal | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(transactionDir, JOURNAL_NAME), "utf-8")) as Partial<AtomicTxnJournal>;
    if (raw?.version !== 1 || !Array.isArray(raw.writes)) return undefined;
    return {
      version: 1,
      phase: raw.phase ?? "staging",
      writes: raw.writes.map(toPosix),
      deletes: Array.isArray(raw.deletes) ? raw.deletes.map(toPosix) : [],
      backups: Array.isArray(raw.backups) ? raw.backups.map((entry) => ({
        relativePath: toPosix(entry.relativePath),
        backupRelative: toPosix(entry.backupRelative),
      })) : [],
      installed: Array.isArray(raw.installed) ? raw.installed.map(toPosix) : [],
      created: Array.isArray(raw.created) ? raw.created.map(toPosix) : [],
      ...(raw.error ? { error: raw.error } : {}),
    };
  } catch {
    return undefined;
  }
}

function createdTargets(journal: AtomicTxnJournal): string[] {
  if (journal.created.length > 0) return journal.created;
  if (journal.phase === "staging") return [];
  const backed = new Set(journal.backups.map((entry) => entry.relativePath));
  return journal.writes.filter((relativePath) => !backed.has(relativePath));
}

async function installFile(
  stagedPath: string,
  target: string,
  renameFile: (from: string, to: string) => Promise<void>,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  try {
    await renameFile(stagedPath, target);
    return;
  } catch (error) {
    if (!isReplaceConflict(error)) throw error;
  }
  const displaced = `${target}.inkos-replacing`;
  await rm(displaced, { force: true }).catch(() => undefined);
  if (await exists(target)) {
    await renameFile(target, displaced);
  }
  try {
    await renameFile(stagedPath, target);
  } catch (error) {
    if (await exists(displaced)) {
      await renameFile(displaced, target).catch(() => undefined);
    }
    throw error;
  }
  await rm(displaced, { force: true }).catch(() => undefined);
}

async function restoreBackups(
  rootDir: string,
  backups: readonly AtomicBackupRecord[],
  renameFile: (from: string, to: string) => Promise<void>,
): Promise<void> {
  for (const entry of [...backups].reverse()) {
    const target = join(rootDir, entry.relativePath);
    const backup = join(rootDir, entry.backupRelative);
    if (!(await exists(backup))) continue;
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    await renameFile(backup, target);
  }
}

async function withdrawCreated(
  rootDir: string,
  created: readonly string[],
): Promise<void> {
  for (const relativePath of [...created].reverse()) {
    await rm(join(rootDir, relativePath), { recursive: true, force: true });
  }
}

async function restoreOldTree(
  rootDir: string,
  backups: readonly AtomicBackupRecord[],
  created: readonly string[],
  renameFile: (from: string, to: string) => Promise<void>,
): Promise<void> {
  await restoreBackups(rootDir, backups, renameFile);
  await withdrawCreated(rootDir, created);
}

async function finishNewTree(
  rootDir: string,
  journal: AtomicTxnJournal,
  stagedDir: string,
  remaining: readonly string[],
  renameFile: (from: string, to: string) => Promise<void>,
): Promise<void> {
  for (const relativePath of remaining) {
    await installFile(join(stagedDir, relativePath), join(rootDir, relativePath), renameFile);
    journal.installed.push(relativePath);
  }
  for (const relativePath of journal.deletes) {
    await rm(join(rootDir, relativePath), { recursive: true, force: true });
  }
}

/**
 * Finish or roll back one leftover transaction directory.
 * Restart gets a complete old tree or a complete new tree. Incomplete rollback keeps the backup.
 * Recovery can run again on the same directory if the first attempt did not finish.
 */
export async function recoverAtomicTransactionDir(
  transactionDir: string,
  options: { readonly renameFile?: (from: string, to: string) => Promise<void> } = {},
): Promise<AtomicRecoveryResult> {
  const renameFile = options.renameFile ?? rename;
  const rootDir = dirname(transactionDir);
  const journal = await readJournal(transactionDir);
  const backupDir = join(transactionDir, "backup");
  const stagedDir = join(transactionDir, "staged");

  const backups = journal?.backups?.length
    ? journal.backups
    : await listBackupRecords(backupDir, backupDir);
  const created = journal ? createdTargets(journal) : [];

  try {
    if (!journal || journal.phase === "staging" || journal.phase === "backed-up" || journal.phase === "rollback-failed") {
      await restoreOldTree(rootDir, backups, created, renameFile);
      await rm(transactionDir, { recursive: true, force: true });
      return { transactionDir, outcome: backups.length || created.length ? "restored-old" : "cleaned" };
    }

    if (journal.phase === "committed") {
      await rm(transactionDir, { recursive: true, force: true });
      return { transactionDir, outcome: "cleaned" };
    }

    if (journal.phase === "committing") {
      const remaining = journal.writes.filter((relativePath) => !journal.installed.includes(relativePath));
      const stagedReady = remaining.length === 0 || (await Promise.all(
        remaining.map((relativePath) => exists(join(stagedDir, relativePath))),
      )).every(Boolean);
      if (stagedReady) {
        await finishNewTree(rootDir, journal, stagedDir, remaining, renameFile);
        journal.phase = "committed";
        await writeJournal(transactionDir, journal);
        await rm(transactionDir, { recursive: true, force: true });
        return { transactionDir, outcome: "completed-new" };
      }
      await restoreOldTree(rootDir, backups, created, renameFile);
      await rm(transactionDir, { recursive: true, force: true });
      return { transactionDir, outcome: "restored-old" };
    }

    return {
      transactionDir,
      outcome: "kept-for-manual-recovery",
      message: `文件事务未完成，备份仍在 ${transactionDir}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await writeJournal(transactionDir, {
        version: 1,
        phase: "rollback-failed",
        writes: journal?.writes ?? [],
        deletes: journal?.deletes ?? [],
        backups,
        installed: journal?.installed ?? [],
        created,
        error: message,
      });
    } catch {
      /* keep the directory even if the journal cannot be updated */
    }
    return {
      transactionDir,
      outcome: "kept-for-manual-recovery",
      message: `文件事务未能自动恢复，备份仍在 ${transactionDir}。${message}`,
    };
  }
}

async function listBackupRecords(dir: string, backupRoot: string): Promise<AtomicBackupRecord[]> {
  const records: AtomicBackupRecord[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return records;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      records.push(...await listBackupRecords(full, backupRoot));
      continue;
    }
    const relativePath = full.slice(backupRoot.length + 1).replace(/\\/g, "/");
    records.push({
      relativePath,
      backupRelative: posixJoin(basenameTxn(dirname(backupRoot)), "backup", relativePath),
    });
  }
  return records;
}

/** Recover leftover `.inkos-file-txn-*` directories directly under rootDir. */
export async function recoverAtomicFileSetsIn(rootDir: string): Promise<AtomicRecoveryResult[]> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const results: AtomicRecoveryResult[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isAtomicTransactionDirName(entry.name)) continue;
    results.push(await recoverAtomicTransactionDir(join(rootDir, entry.name)));
  }
  return results;
}

/** Walk a project tree and recover leftover file transactions. */
export async function recoverProjectAtomicFileSets(projectRoot: string): Promise<AtomicRecoveryResult[]> {
  const results: AtomicRecoveryResult[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (isAtomicTransactionDirName(entry.name)) {
        results.push(await recoverAtomicTransactionDir(full));
        continue;
      }
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      await walk(full, depth + 1);
    }
  };
  await walk(projectRoot, 0);
  return results;
}

export async function commitAtomicFileSet(input: AtomicFileSet): Promise<void> {
  atomicWritesInFlightCount += 1;
  try {
    if (atomicWritesInFlightCount === 1) {
      await recoverAtomicFileSetsIn(input.rootDir);
    }
    await commitAtomicFileSetInner(input);
  } finally {
    atomicWritesInFlightCount = Math.max(0, atomicWritesInFlightCount - 1);
  }
}

async function commitAtomicFileSetInner(input: AtomicFileSet): Promise<void> {
  const renameFile = input.renameFile ?? rename;
  const writes = input.writes.map((entry) => ({
    ...entry,
    relativePath: safeRelativePath(entry.relativePath),
  }));
  const deletes = (input.deletes ?? []).map(safeRelativePath);
  const writePaths = new Set(writes.map((entry) => entry.relativePath));
  if (writePaths.size !== writes.length) {
    throw new Error("Atomic file set contains duplicate write paths");
  }
  if (deletes.some((relativePath) => writePaths.has(relativePath))) {
    throw new Error("Atomic file set cannot write and delete the same path");
  }

  await mkdir(input.rootDir, { recursive: true });
  const transactionDir = await mkdtemp(join(input.rootDir, TXN_PREFIX));
  const stagedDir = join(transactionDir, "staged");
  const backupDir = join(transactionDir, "backup");
  const touchedPaths = [...writePaths, ...deletes];
  const journal: AtomicTxnJournal = {
    version: 1,
    phase: "staging",
    writes: writes.map((entry) => entry.relativePath),
    deletes,
    backups: [],
    installed: [],
    created: [],
  };
  await writeJournal(transactionDir, journal);

  const rollbackErrors: unknown[] = [];
  const keepTransaction = async (error: unknown): Promise<never> => {
    const message = error instanceof Error ? error.message : String(error);
    journal.phase = "rollback-failed";
    journal.error = message;
    await writeJournal(transactionDir, journal).catch((journalError) => {
      rollbackErrors.push(journalError);
    });
    const location = `文件事务未能完成，备份仍在 ${transactionDir}`;
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], `${location}，回滚也不完整`);
    }
    throw error instanceof Error ? Object.assign(error, { atomicTransactionDir: transactionDir }) : new Error(location);
  };

  try {
    for (const entry of writes) {
      const stagedPath = join(stagedDir, entry.relativePath);
      await mkdir(dirname(stagedPath), { recursive: true });
      await writeFile(stagedPath, entry.content);
    }

    for (const relativePath of touchedPaths) {
      const target = join(input.rootDir, relativePath);
      if (!(await exists(target))) {
        if (writePaths.has(relativePath)) journal.created.push(relativePath);
        continue;
      }
      const backup = join(backupDir, relativePath);
      await mkdir(dirname(backup), { recursive: true });
      await copyFile(target, backup);
      journal.backups.push({
        relativePath,
        backupRelative: posixJoin(basenameTxn(transactionDir), "backup", relativePath),
      });
    }
    journal.phase = "backed-up";
    await writeJournal(transactionDir, journal);

    journal.phase = "committing";
    await writeJournal(transactionDir, journal);

    for (const entry of writes) {
      await installFile(join(stagedDir, entry.relativePath), join(input.rootDir, entry.relativePath), renameFile);
      journal.installed.push(entry.relativePath);
      await writeJournal(transactionDir, journal);
    }

    for (const relativePath of deletes) {
      await rm(join(input.rootDir, relativePath), { recursive: true, force: true });
    }

    journal.phase = "committed";
    await writeJournal(transactionDir, journal);
    await rm(transactionDir, { recursive: true, force: true });
  } catch (error) {
    for (const relativePath of [...journal.installed].reverse()) {
      await rm(join(input.rootDir, relativePath), { recursive: true, force: true }).catch((rollbackError) => {
        rollbackErrors.push(rollbackError);
      });
    }
    try {
      await restoreOldTree(input.rootDir, journal.backups, journal.created, renameFile);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }

    if (rollbackErrors.length > 0) {
      await keepTransaction(error);
    }
    await rm(transactionDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function basenameTxn(transactionDir: string): string {
  const parts = transactionDir.split(/[/\\]/);
  return parts[parts.length - 1] ?? transactionDir;
}

function posixJoin(...parts: string[]): string {
  return parts.join("/").replace(/\\/g, "/");
}
