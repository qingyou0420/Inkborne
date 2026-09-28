/**
 * Read book.json, and if it is truncated, set it aside and say where the last snapshot is.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { quarantineCorruptFile } from "../utils/quarantine-corrupt.js";

export class CorruptBookJsonError extends Error {
  readonly quarantinedPath: string;
  readonly snapshotPath?: string;

  constructor(message: string, quarantinedPath: string, snapshotPath?: string) {
    super(message);
    this.name = "CorruptBookJsonError";
    this.quarantinedPath = quarantinedPath;
    this.snapshotPath = snapshotPath;
  }
}

async function latestSnapshotDir(bookDir: string): Promise<string | undefined> {
  let names: string[] = [];
  try {
    names = await readdir(join(bookDir, "story", "snapshots"));
  } catch {
    return undefined;
  }
  const numbers = names
    .map((name) => Number(name))
    .filter((number) => Number.isInteger(number) && number > 0)
    .sort((a, b) => b - a);
  const latest = numbers[0];
  return latest ? join(bookDir, "story", "snapshots", String(latest)) : undefined;
}

async function newestCorruptBookJson(bookDir: string): Promise<string | undefined> {
  let names: string[] = [];
  try {
    names = await readdir(bookDir);
  } catch {
    return undefined;
  }
  const corrupt = names.filter((name) => name.startsWith("book.json.corrupt-")).sort();
  const latest = corrupt.at(-1);
  return latest ? join(bookDir, latest) : undefined;
}

async function corruptBookMessage(bookDir: string, quarantinedPath: string): Promise<CorruptBookJsonError> {
  const snapshot = await latestSnapshotDir(bookDir);
  const where = snapshot
    ? `最近一次快照在 ${snapshot}`
    : "没有找到 story/snapshots 里的章节快照";
  return new CorruptBookJsonError(
    `这本书的 book.json 坏了，坏文件是 ${basename(quarantinedPath)}。${where}。请按快照把书配置补回去再打开。`,
    quarantinedPath,
    snapshot,
  );
}

export async function readBookJsonFile(bookDir: string): Promise<Record<string, unknown>> {
  const configPath = join(bookDir, "book.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      const leftover = await newestCorruptBookJson(bookDir);
      if (leftover) throw await corruptBookMessage(bookDir, leftover);
    }
    throw error;
  }
  if (!raw.trim()) {
    const quarantined = await quarantineCorruptFile(configPath);
    throw await corruptBookMessage(bookDir, quarantined);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("book.json is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CorruptBookJsonError) throw error;
    const quarantined = await quarantineCorruptFile(configPath);
    throw await corruptBookMessage(bookDir, quarantined);
  }
}

export async function bookDirHasCorruptBookJson(bookDir: string): Promise<boolean> {
  return Boolean(await newestCorruptBookJson(bookDir));
}
