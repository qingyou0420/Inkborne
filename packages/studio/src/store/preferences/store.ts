import { create } from "zustand";
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearanceToDocument,
  DEFAULT_APPEARANCE,
  readStoredAppearance,
  type AppearancePrefs,
} from "../../lib/appearance";
import type { PreferencesStore } from "./types";

// Same storage convention as the theme preference (`inkos:studio:theme`).
export const TOOL_DETAILS_STORAGE_KEY = "inkos:studio:tool-details-default-open";

interface PreferenceStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getPreferenceStorage(): PreferenceStorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Default is `true` (keep today's behavior: result details start expanded).
 * Only an explicitly stored "false" turns the preference off.
 */
export function readStoredToolDetailsDefaultOpen(
  storage: Pick<PreferenceStorageLike, "getItem"> | null | undefined,
): boolean {
  return storage?.getItem(TOOL_DETAILS_STORAGE_KEY) !== "false";
}

function persistAppearance(prefs: AppearancePrefs): void {
  try {
    getPreferenceStorage()?.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage failures and keep the in-memory preference for this session.
  }
  applyAppearanceToDocument(prefs);
}

const initialAppearance = readStoredAppearance(getPreferenceStorage());
applyAppearanceToDocument(initialAppearance);

export const usePreferencesStore = create<PreferencesStore>()((set, get) => ({
  toolDetailsDefaultOpen: readStoredToolDetailsDefaultOpen(getPreferenceStorage()),
  uiFont: initialAppearance.uiFont,
  paperTone: initialAppearance.paperTone,
  proseFont: initialAppearance.proseFont,
  proseSize: initialAppearance.proseSize,
  proseLeading: initialAppearance.proseLeading,
  showStudioImage: initialAppearance.showStudioImage,
  currentBookId: initialAppearance.currentBookId,
  lastStages: initialAppearance.lastStages,
  lastChapters: initialAppearance.lastChapters,

  setToolDetailsDefaultOpen: (open: boolean) => {
    try {
      getPreferenceStorage()?.setItem(TOOL_DETAILS_STORAGE_KEY, String(open));
    } catch {
      // Ignore storage failures (e.g. private mode) and keep the in-memory
      // preference for this session — same policy as the theme preference.
    }
    set({ toolDetailsDefaultOpen: open });
  },

  setAppearance: (patch) => {
    const next: AppearancePrefs = {
      paperTone: patch.paperTone ?? get().paperTone,
      uiFont: patch.uiFont ?? get().uiFont,
      proseFont: patch.proseFont ?? get().proseFont,
      proseSize: patch.proseSize ?? get().proseSize,
      proseLeading: patch.proseLeading ?? get().proseLeading,
      showStudioImage: patch.showStudioImage ?? get().showStudioImage,
      currentBookId: patch.currentBookId === undefined ? get().currentBookId : patch.currentBookId,
      lastStages: patch.lastStages ?? get().lastStages,
      lastChapters: patch.lastChapters ?? get().lastChapters,
    };
    persistAppearance(next);
    set(next);
  },

  setCurrentBookId: (bookId) => {
    get().setAppearance({ currentBookId: bookId });
  },

  setLastStage: (bookId, stage) => {
    const current = get().lastStages;
    if (current[bookId] === stage) return;
    get().setAppearance({ lastStages: { ...current, [bookId]: stage } });
  },
  setLastChapter: (bookId, chapter) => {
    if (!bookId.trim() || !Number.isSafeInteger(chapter) || chapter < 1 || get().lastChapters[bookId] === chapter) return;
    get().setAppearance({ lastChapters: { ...get().lastChapters, [bookId]: chapter } });
  },
}));
