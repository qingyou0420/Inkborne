/**
 * Collect book-stage facts from disk and migrate story/workflow.json.
 * Never throws for missing optional files — old books stay on weave/write.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  filledChapterNumbers,
  parseVolumeMapTree,
  resolveOutlineWeaveStep,
} from "@actalk/inkos-core";
import {
  deriveBookStage,
  migrateWorkflowFromFacts,
  parseBookWorkflow,
  storyFrameHasFourSections,
  type BookStageFacts,
  type BookStageSnapshot,
  type BookWorkflowJson,
} from "./book-stage.js";

export interface BookStagePayload extends BookStageSnapshot {
  readonly workflow: BookWorkflowJson;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function countMajorRoles(bookDir: string): Promise<number> {
  const roots = [
    join(bookDir, "story", "roles", "主要角色"),
    join(bookDir, "story", "roles", "major"),
  ];
  let count = 0;
  for (const dir of roots) {
    try {
      const entries = await readdir(dir);
      count += entries.filter((name) => name.endsWith(".md")).length;
    } catch {
      // Missing role dir is normal for old or unfinished books.
    }
  }
  if (count > 0) return count;
  const matrix = await readText(join(bookDir, "story", "character_matrix.md"));
  if (!matrix.trim()) return 0;
  const headings = matrix.match(/^#{2,}\s+.+$/gm) ?? [];
  return headings.filter((line) => !/主要角色|次要角色|major roles?|minor roles?|characters?|角色矩阵/i.test(line)).length;
}

async function fileUpdatedAt(path: string, fallbackIso: string): Promise<string> {
  try {
    const info = await stat(path);
    return info.mtime.toISOString();
  } catch {
    return fallbackIso;
  }
}

export async function collectBookStageFacts(input: {
  readonly bookDir: string;
  readonly bookExists: boolean;
  readonly bookStatus?: string;
  readonly targetChapters?: number;
  readonly nextChapter: number;
  readonly chaptersWritten: number;
  readonly workflow: BookWorkflowJson | null;
}): Promise<BookStageFacts> {
  const storyDir = join(input.bookDir, "story");
  const authorIntent = await readText(join(storyDir, "author_intent.md"));
  const storyCardExists = await pathExists(join(storyDir, "story_card.md"));
  const canonExists = await pathExists(join(storyDir, "canon.md"));
  let askCandidatePending = false;
  try {
    const manifest = JSON.parse(await readText(join(storyDir, "workflow", "manifest.json"))) as {
      candidates?: { ask?: string };
      adopted?: { ask?: string };
    };
    askCandidatePending = Boolean(manifest.candidates?.ask && !manifest.adopted?.ask && !canonExists);
  } catch {
    // Old books without a manifest retain their file-based stage inference.
  }
  const storyFrame = (await readText(join(storyDir, "outline", "story_frame.md"))).trim()
    || (await readText(join(storyDir, "story_bible.md"))).trim();
  const volumeMap = (await readText(join(storyDir, "outline", "volume_map.md"))).trim()
    || (await readText(join(storyDir, "volume_outline.md"))).trim();
  let settingsAdoptedCount = 0;
  try {
    const catalogRaw = JSON.parse(await readText(join(storyDir, "settings", "index.json"))) as { entries?: Array<{ adoptedArtifactId?: string; archived?: boolean }> };
    settingsAdoptedCount = (catalogRaw.entries ?? []).filter((entry) => entry.adoptedArtifactId && !entry.archived).length;
  } catch {
    settingsAdoptedCount = 0;
  }

  const tree = parseVolumeMapTree(volumeMap);
  const targetChapters = input.targetChapters && input.targetChapters > 0 ? input.targetChapters : 200;
  const weaveLocked = resolveOutlineWeaveStep(tree, targetChapters, volumeMap) !== "volumes";
  const filled = new Set(filledChapterNumbers(tree));

  return {
    bookExists: input.bookExists,
    authorIntentNonEmpty: authorIntent.trim().length > 0,
    storyCardExists,
    canonExists,
    askCandidatePending,
    settingsAdoptedCount,
    storyFrameNonEmpty: storyFrame.length > 0,
    storyFrameFourSectionsNonEmpty: storyFrameHasFourSections(storyFrame),
    majorRoleCount: await countMajorRoles(input.bookDir),
    weaveLocked,
    nextChapterHasOutline: filled.has(input.nextChapter),
    chaptersWritten: input.chaptersWritten,
    bookStatus: input.bookStatus,
    askConfirmedAt: input.workflow?.askConfirmedAt,
    groundConfirmedAt: input.workflow?.groundConfirmedAt,
    weaveLockedAt: input.workflow?.weaveLockedAt,
  };
}

export async function loadBookWorkflow(bookDir: string): Promise<BookWorkflowJson | null> {
  const raw = await readText(join(bookDir, "story", "workflow.json"));
  if (!raw.trim()) return null;
  try {
    return parseBookWorkflow(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export async function resolveBookStage(input: {
  readonly bookDir: string;
  readonly bookExists: boolean;
  readonly bookStatus?: string;
  readonly targetChapters?: number;
  readonly nextChapter: number;
  readonly chaptersWritten: number;
}): Promise<BookStagePayload> {
  const existing = await loadBookWorkflow(input.bookDir);
  const facts = await collectBookStageFacts({ ...input, workflow: existing });
  const nowIso = existing
    ? new Date().toISOString()
    : await fileUpdatedAt(join(input.bookDir, "story", "outline", "story_frame.md"), new Date().toISOString());
  const migrated = migrateWorkflowFromFacts(existing, facts, nowIso);
  if (migrated.wrote) {
    try {
      await writeFile(
        join(input.bookDir, "story", "workflow.json"),
        `${JSON.stringify(migrated.workflow, null, 2)}\n`,
        "utf-8",
      );
    } catch {
      // Runtime file is optional. Opening a book must not fail if we cannot write it.
    }
  }
  const snapshot = deriveBookStage({
    ...facts,
    askConfirmedAt: migrated.workflow.askConfirmedAt,
    groundConfirmedAt: migrated.workflow.groundConfirmedAt,
    weaveLockedAt: migrated.workflow.weaveLockedAt,
  });
  return { ...snapshot, workflow: migrated.workflow };
}
