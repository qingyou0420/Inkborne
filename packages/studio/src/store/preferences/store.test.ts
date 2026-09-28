import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_APPEARANCE, parseAppearancePrefs, readStoredAppearance } from "../../lib/appearance";
import { readStoredToolDetailsDefaultOpen, usePreferencesStore, TOOL_DETAILS_STORAGE_KEY } from "./store";

function fakeStorage(entries: Record<string, string>) {
  return {
    getItem: (key: string) => (key in entries ? entries[key] : null),
  };
}

describe("readStoredToolDetailsDefaultOpen", () => {
  it("defaults to true when no storage is available", () => {
    expect(readStoredToolDetailsDefaultOpen(null)).toBe(true);
    expect(readStoredToolDetailsDefaultOpen(undefined)).toBe(true);
  });

  it("defaults to true when nothing is stored", () => {
    expect(readStoredToolDetailsDefaultOpen(fakeStorage({}))).toBe(true);
  });

  it("returns false only for an explicitly stored \"false\"", () => {
    expect(readStoredToolDetailsDefaultOpen(fakeStorage({ [TOOL_DETAILS_STORAGE_KEY]: "false" }))).toBe(false);
    expect(readStoredToolDetailsDefaultOpen(fakeStorage({ [TOOL_DETAILS_STORAGE_KEY]: "true" }))).toBe(true);
    expect(readStoredToolDetailsDefaultOpen(fakeStorage({ [TOOL_DETAILS_STORAGE_KEY]: "garbage" }))).toBe(true);
  });
});

describe("appearance prefs", () => {
  it("keeps explicit legacy fonts while adding valid per-book chapter positions", () => {
    const prefs = parseAppearancePrefs({proseFont:"sans",paperTone:"warm",lastChapters:{one:4,bad:-1,decimal:1.5,text:"2"}});
    expect(prefs.proseFont).toBe("sans");
    expect(prefs.paperTone).toBe("warm");
    expect(prefs.lastChapters).toEqual({one:4});
    expect(parseAppearancePrefs({}).proseFont).toBe("serif");
  });
  it("defaults when storage is empty or invalid", () => {
    expect(readStoredAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(readStoredAppearance(fakeStorage({}))).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearancePrefs({ uiFont: "comic", proseSize: 12, showStudioImage: "yes" })).toEqual(DEFAULT_APPEARANCE);
  });

  it("keeps valid stored fields", () => {
    expect(parseAppearancePrefs({
      uiFont: "wenkai",
      proseFont: "serif",
      proseSize: 21,
      proseLeading: 1.8,
      showStudioImage: false,
      currentBookId: "book-1",
      lastStages: { "book-1": "weave" },
    })).toEqual({
      paperTone: "white",
      lastChapters: {},
      uiFont: "wenkai",
      proseFont: "serif",
      proseSize: 21,
      proseLeading: 1.8,
      showStudioImage: false,
      currentBookId: "book-1",
      lastStages: { "book-1": "weave" },
    });
  });
});

describe("usePreferencesStore", () => {
  beforeEach(() => {
    usePreferencesStore.setState({
      toolDetailsDefaultOpen: true,
      ...DEFAULT_APPEARANCE,
    });
  });

  it("starts with details expanded by default", () => {
    expect(usePreferencesStore.getState().toolDetailsDefaultOpen).toBe(true);
  });

  it("setToolDetailsDefaultOpen updates the state", () => {
    usePreferencesStore.getState().setToolDetailsDefaultOpen(false);
    expect(usePreferencesStore.getState().toolDetailsDefaultOpen).toBe(false);

    usePreferencesStore.getState().setToolDetailsDefaultOpen(true);
    expect(usePreferencesStore.getState().toolDetailsDefaultOpen).toBe(true);
  });

  it("setAppearance updates ui and prose fonts independently", () => {
    usePreferencesStore.getState().setAppearance({ uiFont: "serif", proseFont: "wenkai", proseSize: 23 });
    const state = usePreferencesStore.getState();
    expect(state.uiFont).toBe("serif");
    expect(state.proseFont).toBe("wenkai");
    expect(state.proseSize).toBe(23);
    expect(state.proseLeading).toBe(2);
  });

  it("setLastStage records the last four-stage page per book", () => {
    usePreferencesStore.getState().setLastStage("book-1", "ground");
    usePreferencesStore.getState().setLastStage("book-1", "write");
    expect(usePreferencesStore.getState().lastStages["book-1"]).toBe("write");
  });
});
