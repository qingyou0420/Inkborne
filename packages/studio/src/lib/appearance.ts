/**
 * ONE appearance tokens applied through the existing studio preference store.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type StudioFontId = "sans" | "serif" | "wenkai";
export type StudioStageId = "ask" | "ground" | "weave" | "write";
export type PaperTone = "white" | "warm" | "mist";
export type ProseSizePx = 17 | 19 | 21 | 23;
export type ProseLeading = 1.8 | 2 | 2.2;

export const STUDIO_STAGES: ReadonlyArray<StudioStageId> = ["ask", "ground", "weave", "write"];

export const STUDIO_FONT_STACKS: Record<StudioFontId, string> = {
  sans: "InkSans, \"Noto Sans SC\", \"Microsoft YaHei\", sans-serif",
  serif: "InkSerif, \"Noto Serif SC\", \"Songti SC\", serif",
  wenkai: "InkWenkai, \"LXGW WenKai\", KaiTi, serif",
};

export const STUDIO_FONT_LABELS: Record<StudioFontId, { zh: string; en: string; sample: string }> = {
  sans: { zh: "思源黑体", en: "Noto Sans SC", sample: "墨生万象" },
  serif: { zh: "思源宋体", en: "Noto Serif SC", sample: "墨生万象" },
  wenkai: { zh: "霞鹜文楷", en: "LXGW WenKai", sample: "墨生万象" },
};

export const PROSE_SIZE_OPTIONS: ReadonlyArray<ProseSizePx> = [17, 19, 21, 23];
export const PROSE_LEADING_OPTIONS: ReadonlyArray<ProseLeading> = [1.8, 2, 2.2];

export interface AppearancePrefs {
  readonly paperTone: PaperTone;
  readonly uiFont: StudioFontId;
  readonly proseFont: StudioFontId;
  readonly proseSize: ProseSizePx;
  readonly proseLeading: ProseLeading;
  readonly showStudioImage: boolean;
  readonly currentBookId: string | null;
  readonly lastStages: Readonly<Record<string, StudioStageId>>;
  readonly lastChapters: Readonly<Record<string, number>>;
}

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  paperTone: "white",
  uiFont: "sans",
  proseFont: "serif",
  proseSize: 19,
  proseLeading: 2,
  showStudioImage: true,
  currentBookId: null,
  lastStages: {},
  lastChapters: {},
};

export const APPEARANCE_STORAGE_KEY = "inkos:studio:appearance";

function isFontId(value: unknown): value is StudioFontId {
  return value === "sans" || value === "serif" || value === "wenkai";
}

function isProseSize(value: unknown): value is ProseSizePx {
  return value === 17 || value === 19 || value === 21 || value === 23;
}

function isProseLeading(value: unknown): value is ProseLeading {
  return value === 1.8 || value === 2 || value === 2.2;
}

function isStageId(value: unknown): value is StudioStageId {
  return value === "ask" || value === "ground" || value === "weave" || value === "write";
}

function parseLastStages(raw: unknown): Record<string, StudioStageId> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, StudioStageId> = {};
  for (const [bookId, stage] of Object.entries(raw as Record<string, unknown>)) {
    if (bookId.trim() && isStageId(stage)) out[bookId] = stage;
  }
  return out;
}

export function parseAppearancePrefs(raw: unknown): AppearancePrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_APPEARANCE };
  const body = raw as Record<string, unknown>;
  return {
    paperTone: body.paperTone === "warm" || body.paperTone === "mist" ? body.paperTone : "white",
    uiFont: isFontId(body.uiFont) ? body.uiFont : DEFAULT_APPEARANCE.uiFont,
    proseFont: isFontId(body.proseFont) ? body.proseFont : DEFAULT_APPEARANCE.proseFont,
    proseSize: isProseSize(body.proseSize) ? body.proseSize : DEFAULT_APPEARANCE.proseSize,
    proseLeading: isProseLeading(body.proseLeading) ? body.proseLeading : DEFAULT_APPEARANCE.proseLeading,
    showStudioImage: typeof body.showStudioImage === "boolean"
      ? body.showStudioImage
      : DEFAULT_APPEARANCE.showStudioImage,
    currentBookId: typeof body.currentBookId === "string" && body.currentBookId.trim()
      ? body.currentBookId
      : null,
    lastStages: parseLastStages(body.lastStages),
    lastChapters: Object.fromEntries(Object.entries(body.lastChapters && typeof body.lastChapters === "object" ? body.lastChapters : {}).filter(([key, value]) => key.trim() && typeof value === "number" && Number.isSafeInteger(value) && value > 0)) as Record<string, number>,
  };
}

export function continueStageForBook(
  bookId: string,
  lastStages: Readonly<Record<string, StudioStageId>>,
  fallback?: StudioStageId | null,
): StudioStageId {
  return lastStages[bookId] ?? fallback ?? "ask";
}

export function readStoredAppearance(
  storage: { getItem(key: string): string | null } | null | undefined,
): AppearancePrefs {
  if (!storage) return { ...DEFAULT_APPEARANCE };
  try {
    const raw = storage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    return parseAppearancePrefs(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function applyAppearanceToDocument(prefs: AppearancePrefs): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.paperTone = prefs.paperTone;
  root.style.setProperty("--ui", STUDIO_FONT_STACKS[prefs.uiFont]);
  root.style.setProperty("--prose", STUDIO_FONT_STACKS[prefs.proseFont]);
  root.style.setProperty("--prose-size", `${prefs.proseSize}px`);
  root.style.setProperty("--leading", String(prefs.proseLeading));
  root.classList.toggle("no-images", !prefs.showStudioImage);
}

export const STAGE_LABELS: Record<StudioStageId, { zh: string; en: string; purpose: { zh: string; en: string } }> = {
  ask: {
    zh: "问心",
    en: "Ask",
    purpose: { zh: "聊清故事框架，形成正典", en: "Clarify the story and form the canon" },
  },
  ground: {
    zh: "研墨",
    en: "Ground",
    purpose: { zh: "依据正典打磨全部设定", en: "Polish settings from the canon" },
  },
  weave: {
    zh: "织卷",
    en: "Weave",
    purpose: { zh: "规划故事大纲与每章概要", en: "Plan the outline and chapter briefs" },
  },
  write: {
    zh: "落笔",
    en: "Write",
    purpose: { zh: "依据正典、设定与概要创作", en: "Write from canon, settings, and briefs" },
  },
};
