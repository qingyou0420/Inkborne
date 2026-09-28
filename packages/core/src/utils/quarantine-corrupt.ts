/**
 * Move a broken JSON file aside so the next read can rebuild or explain it.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { rename } from "node:fs/promises";

export function corruptFileStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** Rename `path` to `path.corrupt-<time>`. Colons are stripped so Windows can store the name. */
export async function quarantineCorruptFile(path: string, date = new Date()): Promise<string> {
  const dest = `${path}.corrupt-${corruptFileStamp(date)}`;
  try {
    await rename(path, dest);
    return dest;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EEXIST") throw error;
    const unique = `${dest}-${Math.random().toString(16).slice(2, 8)}`;
    await rename(path, unique);
    return unique;
  }
}
