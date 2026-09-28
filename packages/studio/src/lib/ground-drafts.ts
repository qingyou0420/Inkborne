/** SPDX-License-Identifier: AGPL-3.0-only */
import { replaceStoryFrameZone, type GroundFrameZone } from "./story-frame-sections";

interface CandidateDraft {
  readonly body: string;
  readonly savedBody: string;
  readonly baseId?: string;
  readonly pendingSavedId?: string;
}
interface MaterialDraft { readonly value: unknown }

// These are renderer-session drafts, never adopted material or browser persistence.
const candidates = new Map<string, Map<string, CandidateDraft>>();
const materials = new Map<string, Map<string, MaterialDraft>>();
let unloadGuardInstalled = false;

export function hasPendingGroundDrafts(): boolean {
  return [...candidates.values(), ...materials.values()].some((drafts) => drafts.size > 0);
}

function installUnloadGuard() {
  if (unloadGuardInstalled || typeof window === "undefined") return;
  unloadGuardInstalled = true;
  // Keep this guard after route unmount: drafts on another page still need protection.
  window.addEventListener("beforeunload", (event) => {
    if (!hasPendingGroundDrafts()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

export function pendingGroundEntry(bookId: string): string | undefined {
  return candidates.get(bookId)?.keys().next().value;
}

export function createGroundCandidateEditor(bookId: string, entryId: string) {
  installUnloadGuard();
  const cache = candidates.get(bookId) ?? new Map<string, CandidateDraft>();
  candidates.set(bookId, cache);
  let state: CandidateDraft = cache.get(entryId) ?? { body: "", savedBody: "" };
  const dirty = () => state.body !== state.savedBody;
  const remember = () => { if (dirty()) cache.set(entryId, state); else cache.delete(entryId); };
  return {
    get snapshot() { return { ...state, dirty: dirty() }; },
    load(baseId: string | undefined, body: string): boolean {
      if (dirty() || (state.pendingSavedId && state.pendingSavedId !== baseId)) return false;
      state = { baseId, body, savedBody: body };
      return true;
    },
    change(body: string) {
      state = { ...state, body };
      remember();
    },
    generated() {
      // A subsequent successful generation may legitimately supersede the saved ID.
      state = { ...state, pendingSavedId: undefined };
    },
    async save(write: (baseId: string, body: string) => Promise<{ artifactId: string }>) {
      if (!dirty()) return state.pendingSavedId ?? state.baseId;
      const submitted = state;
      if (!submitted.baseId) throw new Error("找不到这份手改的原版本，请重新加载。 / Original version unavailable.");
      const cached = cache.get(entryId);
      const saved = await write(submitted.baseId, submitted.body);
      const current = state;
      if (state === submitted) {
        state = { body: submitted.body, savedBody: submitted.body, baseId: saved.artifactId, pendingSavedId: saved.artifactId };
      } else {
        state = { ...state, savedBody: submitted.body, baseId: saved.artifactId, pendingSavedId: saved.artifactId };
      }
      // A later mount or keystroke may have created a newer draft during this request.
      if (cache.get(entryId) === cached || cache.get(entryId) === current) {
        if (dirty()) cache.set(entryId, state); else cache.delete(entryId);
      }
      return saved.artifactId;
    },
  };
}

export interface GroundBasicsDraft {
  readonly platform: string;
  readonly genre: string;
  readonly target: string;
  readonly words: string;
  readonly tone: string;
}

export function createGroundMaterialDrafts(bookId: string) {
  installUnloadGuard();
  const cache = materials.get(bookId) ?? new Map<string, MaterialDraft>();
  materials.set(bookId, cache);
  return {
    get<T = string>(key: string): T | undefined { return cache.get(key)?.value as T | undefined; },
    keys: () => [...cache.keys()],
    has: (key: string) => cache.has(key),
    change(key: string, value: unknown) { cache.set(key, { value }); },
    capture: (key: string) => cache.get(key),
    saved(key: string, submitted: MaterialDraft | undefined): boolean {
      if (cache.get(key) !== submitted) return false;
      cache.delete(key);
      return true;
    },
    discard(key: string) { cache.delete(key); },
  };
}

/** Merge just the edited zone into the latest file, not a stale page-load snapshot. */
export async function saveGroundFrameZone(
  zone: GroundFrameZone,
  body: string,
  isZh: boolean,
  read: () => Promise<string>,
  write: (next: string) => Promise<void>,
): Promise<string> {
  const next = replaceStoryFrameZone(await read(), zone, body, isZh);
  await write(next);
  return next;
}
