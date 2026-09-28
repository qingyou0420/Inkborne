import { describe, expect, it } from "vitest";
import {
  deriveBookStage,
  migrateWorkflowFromFacts,
  parseBookWorkflow,
  storyFrameHasFourSections,
  type BookStageFacts,
} from "./book-stage";

function facts(overrides: Partial<BookStageFacts> = {}): BookStageFacts {
  return {
    bookExists: true,
    authorIntentNonEmpty: false,
    storyCardExists: false,
    storyFrameNonEmpty: false,
    storyFrameFourSectionsNonEmpty: false,
    majorRoleCount: 0,
    weaveLocked: false,
    nextChapterHasOutline: false,
    chaptersWritten: 0,
    ...overrides,
  };
}

describe("storyFrameHasFourSections", () => {
  it("accepts four named Chinese sections", () => {
    const markdown = [
      "## 世界铁律",
      "不可飞升。",
      "## 人物底色",
      "苏绻冷而直。",
      "## 核心冲突",
      "德与兵。",
      "## 终局",
      "书院重开。",
    ].join("\n");
    expect(storyFrameHasFourSections(markdown)).toBe(true);
  });

  it("rejects a single paragraph", () => {
    expect(storyFrameHasFourSections("# 骨架\n\n一段话。")).toBe(false);
  });

  it("accepts theme + world + conflict + ending without a 人物 heading", () => {
    const markdown = [
      "## 主题与基调",
      "权谋。",
      "## 世界观底色",
      "不可飞升。",
      "## 核心冲突",
      "德与兵。",
      "## 终局方向",
      "书院重开。",
    ].join("\n");
    expect(storyFrameHasFourSections(markdown)).toBe(true);
  });

  it("rejects three named sections", () => {
    const markdown = [
      "## 世界观底色",
      "不可飞升。",
      "## 核心冲突",
      "德与兵。",
      "## 终局",
      "书院重开。",
    ].join("\n");
    expect(storyFrameHasFourSections(markdown)).toBe(false);
  });
});

describe("deriveBookStage", () => {
  it("keeps an unadopted Ask candidate at 问心 despite old confirmation marks", () => {
    const snap = deriveBookStage(facts({
      askCandidatePending: true,
      authorIntentNonEmpty: true,
      storyCardExists: true,
      askConfirmedAt: "2026-09-01T00:00:00.000Z",
      groundConfirmedAt: "2026-09-01T00:00:00.000Z",
      weaveLockedAt: "2026-09-01T00:00:00.000Z",
    }));
    expect(snap).toEqual({ stage: "ask", steps: { ask: "current", ground: "todo", weave: "todo", write: "todo" } });
  });

  it("starts a bare book at 问心", () => {
    const snap = deriveBookStage(facts());
    expect(snap.stage).toBe("ask");
    expect(snap.steps.ask).toBe("current");
    expect(snap.steps.ground).toBe("todo");
  });

  it("treats adopted canon.md as 问心 done without foundation files", () => {
    const snap = deriveBookStage(facts({ canonExists: true }));
    expect(snap.stage).toBe("ground");
    expect(snap.steps.ask).toBe("done");
    expect(snap.steps.ground).toBe("current");
  });

  it("treats adopted settings catalog as 研墨 done without story_frame.md", () => {
    const snap = deriveBookStage(facts({
      canonExists: true,
      settingsAdoptedCount: 2,
    }));
    expect(snap.stage).toBe("weave");
    expect(snap.steps.ground).toBe("done");
  });

  it("does not rewind an old book that already has a story frame", () => {
    const snap = deriveBookStage(facts({
      storyFrameNonEmpty: true,
      authorIntentNonEmpty: true,
      groundConfirmedAt: "2026-09-01T00:00:00.000Z",
      majorRoleCount: 2,
    }));
    expect(snap.stage).toBe("weave");
    expect(snap.steps.ask).toBe("done");
    expect(snap.steps.ground).toBe("done");
    expect(snap.steps.weave).toBe("current");
  });

  it("lands a locked outline with a next-chapter card on 落笔", () => {
    const snap = deriveBookStage(facts({
      storyFrameNonEmpty: true,
      groundConfirmedAt: "2026-09-01T00:00:00.000Z",
      majorRoleCount: 1,
      weaveLocked: true,
      nextChapterHasOutline: true,
    }));
    expect(snap.stage).toBe("write");
    expect(snap.steps.weave).toBe("done");
    expect(snap.steps.write).toBe("current");
  });

  it("never forces 问心 when chapters already exist", () => {
    const snap = deriveBookStage(facts({
      chaptersWritten: 3,
      storyFrameNonEmpty: false,
      storyCardExists: false,
    }));
    expect(snap.stage).toBe("write");
    expect(snap.steps.ask).toBe("done");
  });
});

describe("migrateWorkflowFromFacts", () => {
  it("does not infer or retain completed stages from a pending candidate's author source", () => {
    const pending = facts({ askCandidatePending: true, authorIntentNonEmpty: true });
    const initial = migrateWorkflowFromFacts(null, pending, "2026-09-17T00:00:00.000Z");
    expect(initial.workflow).toEqual({ lastStage: "ask" });
    const stale = migrateWorkflowFromFacts({
      lastStage: "ask", askConfirmedAt: "old", groundConfirmedAt: "old", weaveLockedAt: "old",
    }, pending, "2026-09-17T00:00:00.000Z");
    expect(stale).toEqual({ workflow: { lastStage: "ask" }, wrote: true });
    expect(migrateWorkflowFromFacts(stale.workflow, pending, "later").wrote).toBe(false);
  });

  it("writes confirm timestamps for an existing story_frame book", () => {
    const { workflow, wrote } = migrateWorkflowFromFacts(null, facts({
      authorIntentNonEmpty: true,
      storyFrameNonEmpty: true,
      majorRoleCount: 1,
      weaveLocked: true,
      nextChapterHasOutline: true,
    }), "2026-09-06T00:00:00.000Z");
    expect(wrote).toBe(true);
    expect(workflow.groundConfirmedAt).toBe("2026-09-06T00:00:00.000Z");
    expect(workflow.askConfirmedAt).toBe("2026-09-06T00:00:00.000Z");
    expect(workflow.weaveLockedAt).toBe("2026-09-06T00:00:00.000Z");
    expect(workflow.lastStage).toBe("write");
  });

  it("keeps an existing workflow and only refreshes lastStage", () => {
    const existing = parseBookWorkflow({
      askConfirmedAt: "2026-01-01T00:00:00.000Z",
      groundConfirmedAt: "2026-01-02T00:00:00.000Z",
      lastStage: "ground",
    });
    const { workflow, wrote } = migrateWorkflowFromFacts(existing, facts({
      storyFrameNonEmpty: true,
      majorRoleCount: 1,
      weaveLocked: true,
      nextChapterHasOutline: true,
    }), "2026-09-06T00:00:00.000Z");
    expect(wrote).toBe(true);
    expect(workflow.askConfirmedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(workflow.lastStage).toBe("write");
  });
});
