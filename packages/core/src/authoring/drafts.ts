/**
 * Persistent 问心 draft identity, bound to a chat session and later a book.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AuthoringDraftRecordSchema, type AuthoringDraftRecord } from "./types.js";

interface DraftIndex {
  readonly drafts: AuthoringDraftRecord[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function indexPath(projectRoot: string): string {
  return join(projectRoot, ".inkos", "authoring-drafts", "index.json");
}

async function loadIndex(projectRoot: string): Promise<DraftIndex> {
  try {
    const raw = JSON.parse(await readFile(indexPath(projectRoot), "utf-8")) as unknown;
    const draftsRaw = raw && typeof raw === "object" && Array.isArray((raw as { drafts?: unknown }).drafts)
      ? (raw as { drafts: unknown[] }).drafts
      : [];
    return {
      drafts: draftsRaw.flatMap((item) => {
        const parsed = AuthoringDraftRecordSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    };
  } catch {
    return { drafts: [] };
  }
}

async function saveIndex(projectRoot: string, index: DraftIndex): Promise<void> {
  const path = indexPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
}

export function newDraftId(): string {
  return `draft-${randomUUID()}`;
}

export async function loadDraft(
  projectRoot: string,
  draftId: string,
): Promise<AuthoringDraftRecord | undefined> {
  const index = await loadIndex(projectRoot);
  return index.drafts.find((item) => item.draftId === draftId);
}

export async function findDraftBySession(
  projectRoot: string,
  sessionId: string,
): Promise<AuthoringDraftRecord | undefined> {
  const index = await loadIndex(projectRoot);
  return index.drafts.find((item) => item.sessionId === sessionId);
}

export async function ensureAuthoringDraft(input: {
  readonly projectRoot: string;
  readonly draftId?: string;
  readonly sessionId?: string;
}): Promise<AuthoringDraftRecord> {
  const index = await loadIndex(input.projectRoot);
  if (input.draftId) {
    const found = index.drafts.find((item) => item.draftId === input.draftId);
    if (found) {
      if (input.sessionId && found.sessionId !== input.sessionId) {
        const next = { ...found, sessionId: input.sessionId, updatedAt: nowIso() };
        await saveIndex(input.projectRoot, {
          drafts: index.drafts.map((item) => item.draftId === next.draftId ? next : item),
        });
        return next;
      }
      return found;
    }
  }
  if (input.sessionId) {
    const found = index.drafts.find((item) => item.sessionId === input.sessionId);
    if (found) return found;
  }
  const record: AuthoringDraftRecord = {
    draftId: input.draftId?.trim() || newDraftId(),
    sessionId: input.sessionId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await mkdir(join(input.projectRoot, ".inkos", "authoring-drafts", record.draftId), { recursive: true });
  await saveIndex(input.projectRoot, { drafts: [...index.drafts, record] });
  return record;
}

export async function bindDraftToBook(input: {
  readonly projectRoot: string;
  readonly draftId: string;
  readonly bookId: string;
  readonly title?: string;
}): Promise<AuthoringDraftRecord> {
  const index = await loadIndex(input.projectRoot);
  const existing = index.drafts.find((item) => item.draftId === input.draftId);
  const next: AuthoringDraftRecord = {
    draftId: input.draftId,
    sessionId: existing?.sessionId,
    bookId: input.bookId,
    title: input.title ?? existing?.title,
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };
  const drafts = existing
    ? index.drafts.map((item) => item.draftId === input.draftId ? next : item)
    : [...index.drafts, next];
  await saveIndex(input.projectRoot, { drafts });
  return next;
}
