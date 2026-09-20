/**
 * Four-step study copy and stage-aware CTA strings.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it } from "vitest";
import { fourStepCopy, weaveLengthGateCopy } from "./stage-copy";

describe("fourStepCopy", () => {
  it("renders Chinese status sentences for a mid-book", () => {
    const copy = fourStepCopy({
      askDone: true,
      grounded: false,
      roleCount: 3,
      lockedVolumes: 2,
      outlineDone: false,
      plannedChapters: 38,
      writtenChapters: 12,
      targetChapters: 260,
      weaveReady: true,
    }, true);
    expect(copy.ask).toBe("故事正典已完成");
    expect(copy.ground).toBe("设定未定稿 · 3 位人物");
    expect(copy.weave).toBe("已锁 2 卷 · 细纲未完成 · 章节规划 38/260");
    expect(copy.write).toBe("已写 12/260 章");
  });

  it("drops the target denominator when targetChapters is 0", () => {
    const copy = fourStepCopy({
      askDone: false,
      grounded: true,
      roleCount: 1,
      lockedVolumes: 0,
      outlineDone: false,
      plannedChapters: 38,
      writtenChapters: 12,
      targetChapters: 0,
      weaveReady: true,
    }, true);
    expect(copy.ask).toBe("故事正典未完成");
    expect(copy.ground).toBe("设定已定稿 · 1 位人物");
    expect(copy.weave).toBe("已锁 0 卷 · 细纲未完成 · 章节规划 38");
    expect(copy.write).toBe("已写 12 章");
  });

  it("shows an em dash for weave when the snapshot is not ready", () => {
    const copy = fourStepCopy({
      askDone: true,
      grounded: true,
      roleCount: 2,
      lockedVolumes: 7,
      outlineDone: true,
      plannedChapters: 260,
      writtenChapters: 0,
      targetChapters: 260,
      weaveReady: false,
    }, true);
    expect(copy.weave).toBe("—");
  });

  it("names the weave length gate", () => {
    expect(weaveLengthGateCopy(true)).toMatchObject({
      title: "先定全书篇幅",
      action: "去问心",
      target: "ask",
    });
    expect(weaveLengthGateCopy(false).title).toBe("Set the book length first");
  });

  it("renders English status sentences", () => {
    const copy = fourStepCopy({
      askDone: true,
      grounded: true,
      roleCount: 4,
      lockedVolumes: 7,
      outlineDone: true,
      plannedChapters: 260,
      writtenChapters: 12,
      targetChapters: 260,
      weaveReady: true,
    }, false);
    expect(copy.ask).toBe("Canon settled");
    expect(copy.ground).toBe("Grounded · 4 people");
    expect(copy.weave).toBe("7 vol locked · Outline done · 260/260 planned");
    expect(copy.write).toBe("12/260 chapters");
  });
});
