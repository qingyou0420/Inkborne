import { describe, expect, it, vi } from "vitest";
import { createProposeActionTool, createShortFictionRunTool, createSubAgentTool } from "../../../core/src/agent/agent-tools.js";
import {
  applyStudioFeaturePolicy,
  isRetiredStudioIntent,
  isRetiredStudioSessionKind,
  isRetiredStudioWriteRoute,
} from "./feature-policy.js";

describe("Lightbound feature policy", () => {
  it.each(["fanfic_init", "continuation_import", "spinoff_create", "style_imitation", "script_create", "storyboard_create", "interactive_film_create", "translation_create", "draft_structure", "connect_choice", "remove_node"])("retires saved %s confirmations", (intent) => {
    expect(isRetiredStudioIntent(intent)).toBe(true);
  });

  it("preserves short fiction, book setup, and existing book sessions", () => {
    expect(isRetiredStudioIntent("short_run")).toBe(false);
    expect(isRetiredStudioIntent("create_book")).toBe(false);
    expect(isRetiredStudioSessionKind("short")).toBe(false);
    expect(isRetiredStudioSessionKind("book")).toBe(false);
    expect(isRetiredStudioSessionKind("interactive-film-authoring")).toBe(true);
  });

  it.each([
    "/fanfic/init", "/spinoff/init", "/imitation/init", "/books/b/fanfic/refresh", "/radar/scan", "/daemon/start",
    "/translations/upload", "/translations/create", "/translations/t/run",
    "/projects/film/story-graph/delta", "/projects/film/nodes/n/image",
    "/project/detection", "/project/notify", "/project/model-overrides", "/prompt-packs/legacy",
    "/books/b/detect/2", "/books/b/detect-all", "/books/b/import/chapters", "/books/b/import/canon-file", "/import/canon/upload",
  ])("blocks the retired write route %s", (path) => {
    expect(isRetiredStudioWriteRoute("POST", `/api/v1${path}`)).toBe(true);
  });

  it("preserves historical reads/exports, cancellation, short editing and Ask materials", () => {
    for (const path of ["/radar/history", "/translations/t", "/books/b/fanfic", "/sessions/s"]) {
      expect(isRetiredStudioWriteRoute("GET", `/api/v1${path}`)).toBe(false);
    }
    for (const path of ["/translations/t/export", "/daemon/stop", "/sessions/s/abort", "/shorts/s", "/books/b/authoring/ask/materials", "/materials/upload"]) {
      expect(isRetiredStudioWriteRoute("POST", `/api/v1${path}`)).toBe(false);
    }
  });

  it("removes retired proposal options and refuses replay before producing a card", async () => {
    const [proposal] = applyStudioFeaturePolicy([createProposeActionTool("zh")]);
    expect(proposal.parameters.properties.action.anyOf.map((choice: { const: string }) => choice.const)).toEqual(["create_book", "short_run", "play_start", "generate_cover"]);
    expect(proposal.parameters.properties).not.toHaveProperty("fanficCreate");
    await expect(proposal.execute("old", { action: "fanfic_init", instruction: "创建同人" })).rejects.toThrow("已从轻光之集移除");
    const result = await proposal.execute("short", {
      action: "short_run", instruction: "写雨夜里的悬疑短篇",
      shortRun: { title: "雨夜", direction: "雨夜里的悬疑故事" },
    });
    expect(result.details).toMatchObject({ kind: "proposed_action", action: "short_run" });
  });

  it("blocks chat legacy writer/architect and anti-detection without changing the short production tool", async () => {
    const pipeline = { writeChapters: vi.fn(), initBook: vi.fn() } as never;
    const subAgent = createSubAgentTool(pipeline, "book", "D:/isolated-test");
    const short = createShortFictionRunTool(pipeline, "D:/isolated-test");
    const tools = applyStudioFeaturePolicy([subAgent, short]);
    expect(tools[1]).toBe(short);
    await expect(tools[0].execute("writer", { agent: "writer", chapterCount: 4, instruction: "连写四章" })).rejects.toThrow("已从轻光之集移除");
    await expect(tools[0].execute("architect", { agent: "architect", instruction: "创建作品" })).rejects.toThrow("已从轻光之集移除");
    await expect(tools[0].execute("detect", { agent: "reviser", mode: "anti-detect", instruction: "去检测" })).rejects.toThrow("已从轻光之集移除");
  });
});
