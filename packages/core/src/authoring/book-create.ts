/**
 * Lightweight book create after 问心 adopts canon. No ground/weave generation.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BookConfigSchema, type BookConfig } from "../models/book.js";
import { deriveBookIdFromTitle } from "../utils/book-id.js";
import { serializeCanon } from "./canon.js";
import { isBookPresent } from "./context.js";
import { bindDraftToBook, loadDraft } from "./drafts.js";
import { loadManifest, saveArtifact, saveManifest, type AuthoringStoreRoot } from "./store.js";
import type { AuthoringArtifactMeta, CanonDocument } from "./types.js";

export interface LightweightBookCreateInput {
  readonly projectRoot: string;
  readonly canon: CanonDocument;
  readonly draftId?: string;
  readonly language?: "zh" | "en";
  readonly platform?: BookConfig["platform"];
  readonly existingBookId?: string;
  readonly fromArtifact?: { readonly meta: AuthoringArtifactMeta; readonly body: string };
}

export async function syncBookJsonTitle(bookDir: string, canon: CanonDocument): Promise<void> {
  try {
    const path = join(bookDir, "book.json");
    const raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    const next = {
      ...raw,
      title: canon.title || raw.title,
      genre: canon.genre?.trim() || raw.genre,
      targetChapters: canon.targetChapters ?? raw.targetChapters,
      chapterWordCount: canon.chapterWordCount ?? raw.chapterWordCount,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  } catch {
    /* book.json is optional during a bound retry */
  }
}

async function uniqueBookId(projectRoot: string, preferred: string, draftId?: string): Promise<string> {
  const base = preferred || `book-${Date.now().toString(36)}`;
  if (!(await isBookPresent(join(projectRoot, "books", base)))) return base;
  const suffix = (draftId ?? Date.now().toString(36)).replace(/[^\w]+/g, "").slice(-8) || Date.now().toString(36);
  const next = `${base}-${suffix}`;
  if (!(await isBookPresent(join(projectRoot, "books", next)))) return next;
  return `${base}-${Date.now().toString(36)}`;
}

export async function createLightweightBook(input: LightweightBookCreateInput): Promise<{
  readonly bookId: string;
  readonly bookDir: string;
  readonly created: boolean;
}> {
  const draft = input.draftId ? await loadDraft(input.projectRoot, input.draftId) : undefined;
  const boundId = input.existingBookId || draft?.bookId;
  let bookId = boundId
    || deriveBookIdFromTitle(input.canon.title)
    || `book-${Date.now().toString(36)}`;
  if (!boundId) {
    const preferredDir = join(input.projectRoot, "books", bookId);
    if (await isBookPresent(preferredDir)) {
      if (!input.draftId) {
        return { bookId, bookDir: preferredDir, created: false };
      }
      bookId = await uniqueBookId(input.projectRoot, bookId, input.draftId);
    }
  }
  const bookDir = join(input.projectRoot, "books", bookId);
  const exists = await isBookPresent(bookDir);
  if (exists && boundId === bookId) {
    const canonBody = input.fromArtifact?.body ?? serializeCanon(input.canon);
    await mkdir(join(bookDir, "story"), { recursive: true });
    await writeFile(join(bookDir, "story", "canon.md"), canonBody.endsWith("\n") ? canonBody : `${canonBody}\n`, "utf-8");
    await syncBookJsonTitle(bookDir, input.canon);
    const root: AuthoringStoreRoot = { projectRoot: input.projectRoot, bookId, draftId: input.draftId };
    if (input.fromArtifact) {
      await saveArtifact(root, { ...input.fromArtifact.meta, status: "adopted", bodyPath: "story/canon.md" }, canonBody);
      const manifest = await loadManifest(root);
      const previous = manifest.adopted.ask;
      const artifactId = input.fromArtifact.meta.artifactId;
      await saveManifest(root, {
        ...manifest,
        bookId,
        draftId: input.draftId ?? manifest.draftId,
        adopted: { ...manifest.adopted, ask: artifactId },
        candidates: { ...manifest.candidates, ask: artifactId },
        watches: previous && previous !== artifactId
          ? [
              ...manifest.watches,
              {
                id: `ask-${Date.now()}`,
                stage: "ground",
                sourceKind: "canon",
                sourceId: artifactId,
                label: "正典已采用新版本，设定可能需要核对",
                acknowledged: false,
              },
              {
                id: `ask-weave-${Date.now()}`,
                stage: "weave",
                sourceKind: "canon",
                sourceId: artifactId,
                label: "正典已采用新版本，大纲可能需要核对",
                acknowledged: false,
              },
            ]
          : manifest.watches,
      });
    }
    if (input.draftId) await bindDraftToBook({ projectRoot: input.projectRoot, draftId: input.draftId, bookId, title: input.canon.title });
    return { bookId, bookDir, created: false };
  }
  if (exists) {
    return { bookId, bookDir, created: false };
  }
  const now = new Date().toISOString();
  const book = BookConfigSchema.parse({
    id: bookId,
    title: input.canon.title,
    platform: input.platform ?? "other",
    genre: input.canon.genre?.trim() || "未分类",
    status: "incubating",
    targetChapters: input.canon.targetChapters ?? 36,
    chapterWordCount: input.canon.chapterWordCount ?? 3000,
    language: input.language ?? "zh",
    createdAt: now,
    updatedAt: now,
    writing: { reviewMode: "manual" },
  });
  await mkdir(join(bookDir, "story", "outline"), { recursive: true });
  await mkdir(join(bookDir, "story", "roles", "主要角色"), { recursive: true });
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(join(bookDir, "story", "settings"), { recursive: true });
  await writeFile(join(bookDir, "book.json"), `${JSON.stringify(book, null, 2)}\n`, "utf-8");
  const canonBody = input.fromArtifact?.body ?? serializeCanon(input.canon);
  await writeFile(join(bookDir, "story", "canon.md"), canonBody.endsWith("\n") ? canonBody : `${canonBody}\n`, "utf-8");
  await writeFile(
    join(bookDir, "story", "author_intent.md"),
    [input.canon.oneLine, input.canon.boundaries, input.canon.openQuestions.map((q) => `- ${q}`).join("\n")]
      .filter(Boolean)
      .join("\n\n") + "\n",
    "utf-8",
  );
  await writeFile(join(bookDir, "chapters", "index.json"), "[]\n", "utf-8");
  const root: AuthoringStoreRoot = { projectRoot: input.projectRoot, bookId, draftId: input.draftId };
  const artifact = input.fromArtifact
    ? await saveArtifact(root, { ...input.fromArtifact.meta, status: "adopted", bodyPath: "story/canon.md" }, canonBody)
    : await saveArtifact(root, {
      artifactId: `ask-canon-v1`,
      stage: "ask",
      scope: "canon",
      version: 1,
      source: "generate",
      status: "adopted",
      bodyPath: "story/canon.md",
      inputRefs: [],
      createdAt: now,
      label: "正典 v1",
    }, canonBody);
  await saveManifest(root, {
    version: 1,
    bookId,
    draftId: input.draftId,
    adopted: { ask: artifact.artifactId, ground: [], write: {} },
    candidates: { ask: artifact.artifactId, ground: [], write: {} },
    coverage: {},
    watches: [],
    updatedAt: now,
  });
  if (input.draftId) {
    await bindDraftToBook({
      projectRoot: input.projectRoot,
      draftId: input.draftId,
      bookId,
      title: input.canon.title,
    });
  }
  return { bookId, bookDir, created: true };
}
