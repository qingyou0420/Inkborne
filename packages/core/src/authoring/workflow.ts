/**
 * Public authoring workflow facade.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { adoptAskCanon, generateAskCanon, reviewAskCanon, reviseAskCanon } from "./stages/ask.js";
import { adoptGroundEntries, generateGroundEntries, proposeSettingsCatalog, reviewGroundEntries, reviseGroundEntry } from "./stages/ground.js";
import { adoptWeave, generateWeaveRange, reviewWeave, reviseWeave } from "./stages/weave.js";
import { adoptChapterDraft, generateChapterDraft, reviewChapterDraft, reviseChapterDraft } from "./stages/write.js";
import { loadArtifact, loadManifest, loadReport, listArtifacts, listReports, loadRun, type AuthoringStoreRoot } from "./store.js";
import type { AuthoringLlmFn } from "./types.js";
import type { ProjectConfig } from "../models/project.js";

export interface AuthoringWorkflow {
  readonly root: AuthoringStoreRoot;
  readonly project: ProjectConfig;
  readonly llm?: AuthoringLlmFn;
}

export function createAuthoringWorkflow(input: AuthoringWorkflow): AuthoringWorkflow {
  return input;
}

export const authoring = {
  ask: { generateAskCanon, reviewAskCanon, reviseAskCanon, adoptAskCanon },
  ground: { proposeSettingsCatalog, generateGroundEntries, reviewGroundEntries, reviseGroundEntry, adoptGroundEntries },
  weave: { generateWeaveRange, reviewWeave, reviseWeave, adoptWeave },
  write: { generateChapterDraft, reviewChapterDraft, reviseChapterDraft, adoptChapterDraft },
  store: { loadArtifact, loadManifest, loadReport, listArtifacts, listReports, loadRun },
};
