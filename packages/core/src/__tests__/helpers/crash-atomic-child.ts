/**
 * Child process for F02 crash recovery tests. Installs one target then hangs
 * until the parent kills the process.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { persistAdoptedChapter } from "../../authoring/chapter-index.js";
import { commitAtomicFileSet } from "../../utils/atomic-file-set.js";

const config = JSON.parse(await readFile(process.argv[2]!, "utf-8")) as {
  kind: "file-set" | "adopt";
  rootDir: string;
  hangAfter: string;
  marker: string;
  writes?: Array<{ relativePath: string; content: string }>;
  deletes?: string[];
  bookDir?: string;
  chapterNumber?: number;
  title?: string;
  body?: string;
};

const hangAfter = config.hangAfter.replace(/\\/g, "/");

async function renameFile(from: string, to: string): Promise<void> {
  await rename(from, to);
  const posixFrom = from.replace(/\\/g, "/");
  const posixTo = to.replace(/\\/g, "/");
  if (posixFrom.includes("/staged/") && posixTo.includes(hangAfter)) {
    await writeFile(config.marker, "installed\n", "utf-8");
    await new Promise(() => undefined);
  }
}

if (config.kind === "adopt") {
  await persistAdoptedChapter({
    bookDir: config.bookDir ?? config.rootDir,
    chapterNumber: config.chapterNumber ?? 1,
    title: config.title ?? "新章",
    body: config.body ?? "# 第1章 新章\n新正文\n",
    renameFile,
  });
} else {
  await commitAtomicFileSet({
    rootDir: config.rootDir,
    writes: config.writes ?? [],
    deletes: config.deletes,
    renameFile,
  });
}
