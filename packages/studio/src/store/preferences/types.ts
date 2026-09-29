import type { AppearancePrefs, PaperTone, ProseLeading, ProseSizePx, StudioFontId, StudioStageId } from "../../lib/appearance";

export interface PreferencesStore {
  /**
   * Whether pipeline tool result blocks ("查看操作结果") in chat render
   * expanded by default. Persisted per browser via localStorage.
   */
  toolDetailsDefaultOpen: boolean;

  setToolDetailsDefaultOpen: (open: boolean) => void;

  uiFont: StudioFontId;
  paperTone: PaperTone;
  proseFont: StudioFontId;
  proseSize: ProseSizePx;
  proseLeading: ProseLeading;
  showStudioImage: boolean;
  currentBookId: string | null;
  lastStages: Readonly<Record<string, StudioStageId>>;
  lastChapters: Readonly<Record<string, number>>;

  setAppearance: (patch: Partial<AppearancePrefs>) => void;
  setCurrentBookId: (bookId: string | null) => void;
  setLastStage: (bookId: string, stage: StudioStageId) => void;
  setLastChapter: (bookId: string, chapter: number) => void;
}
