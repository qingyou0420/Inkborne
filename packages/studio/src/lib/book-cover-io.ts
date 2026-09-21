/**
 * Persist a local book cover under the book's library folder.
 * Path: books/<id>/cover.<ext> + book.json coverImagePath.
 * Never use process.cwd().
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { BookConfig } from "@actalk/inkos-core";
import {
  BOOK_COVER_MAX_BYTES,
  bookCoverContentType,
  bookCoverExtensionFor,
  isSafeBookCoverRelative,
} from "./book-cover.js";

export {
  BOOK_COVER_ACCEPT,
  BOOK_COVER_MAX_BYTES,
  BOOK_COVER_TYPES,
  bookCoverApiPath,
  bookCoverContentType,
  bookCoverExtensionFor,
  isSafeBookCoverRelative,
  studioBookCoverSrc,
  validateBookCoverFile,
  withStudioCoverSrc,
} from "./book-cover.js";

export class BookCoverError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "BookCoverError";
  }
}

function coverRelativeFor(ext: string): string {
  return `cover.${ext}`;
}

export function resolveBookCoverFile(
  bookDir: string,
  coverImagePath: string,
): { readonly resolved: string; readonly contentType: string } {
  if (!isSafeBookCoverRelative(coverImagePath)) {
    throw new BookCoverError("封面路径无效", 400);
  }
  const resolved = resolve(bookDir, coverImagePath);
  const rel = relative(bookDir, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new BookCoverError("封面路径无效", 400);
  }
  const ext = extname(coverImagePath).replace(".", "").toLowerCase();
  return { resolved, contentType: bookCoverContentType(ext) };
}

async function removeManagedCoverFiles(bookDir: string, keepRelative?: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(bookDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isSafeBookCoverRelative(name)) continue;
    if (keepRelative && name === keepRelative) continue;
    await rm(join(bookDir, name), { force: true });
  }
  try {
    const assets = await readdir(join(bookDir, "assets"));
    for (const name of assets) {
      const relativeName = `assets/${name}`;
      if (!isSafeBookCoverRelative(relativeName)) continue;
      if (keepRelative && relativeName === keepRelative) continue;
      await rm(join(bookDir, "assets", name), { force: true });
    }
  } catch {
    // no assets/ folder
  }
}

export async function saveBookCoverFile(
  bookDir: string,
  book: BookConfig,
  bytes: Uint8Array,
  mime: string,
  filename = "",
): Promise<BookConfig> {
  const ext = bookCoverExtensionFor(mime, filename);
  if (!ext) {
    throw new BookCoverError("封面只支持 png / jpg / jpeg / webp / gif");
  }
  if (bytes.byteLength > BOOK_COVER_MAX_BYTES) {
    throw new BookCoverError("封面不能超过 6 MB");
  }
  const relativeName = coverRelativeFor(ext);
  await writeFile(join(bookDir, relativeName), bytes);
  await removeManagedCoverFiles(bookDir, relativeName);
  return {
    ...book,
    coverImagePath: relativeName,
    updatedAt: new Date().toISOString(),
  };
}

export async function clearBookCoverFile(
  bookDir: string,
  book: BookConfig,
): Promise<BookConfig> {
  if (book.coverImagePath && isSafeBookCoverRelative(book.coverImagePath)) {
    try {
      const file = resolveBookCoverFile(bookDir, book.coverImagePath);
      await rm(file.resolved, { force: true });
    } catch {
      // missing or unsafe path: still clear metadata
    }
  }
  await removeManagedCoverFiles(bookDir);
  const { coverImagePath: _removed, ...rest } = book;
  return {
    ...rest,
    updatedAt: new Date().toISOString(),
  };
}

export async function readBookCoverFile(
  bookDir: string,
  book: Pick<BookConfig, "coverImagePath">,
): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | null> {
  if (!book.coverImagePath) return null;
  try {
    const file = resolveBookCoverFile(bookDir, book.coverImagePath);
    const bytes = await readFile(file.resolved);
    return { bytes, contentType: file.contentType };
  } catch {
    return null;
  }
}
