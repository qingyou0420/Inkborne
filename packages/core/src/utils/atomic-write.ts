/**
 * Single-file write that lands via a temp file and rename.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { basename, dirname } from "node:path";
import { commitAtomicFileSet } from "./atomic-file-set.js";

export async function writeFileAtomic(path: string, content: string | Uint8Array): Promise<void> {
  await commitAtomicFileSet({
    rootDir: dirname(path),
    writes: [{ relativePath: basename(path), content }],
  });
}
