/**
 * Four-step study copy and stage-aware CTA strings.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it } from "vitest";
import { fourStepCopy, weaveLengthGateCopy, type FourStepCopyInput } from "./stage-copy";
import type { AuthoringCatalogEntry, AuthoringWorkspace } from "./authoring-workspace";

const newBook: FourStepCopyInput = {
  askDone: true, grounded: false, roleCount: 0, lockedVolumes: 0,
  outlineDone: false, plannedChapters: 0, writtenChapters: 0,
  targetChapters: 80, weaveReady: false,
};

function workspaceWith(entries: ReadonlyArray<AuthoringCatalogEntry>): AuthoringWorkspace {
  return { authoringBook: true, catalog: { categories: ["主要人物", "世界"], entries } };
}

const adoptedPerson: AuthoringCatalogEntry = {
  id: "lin", category: "主要人物", name: "林舟",
  file: "story/settings/主要人物/林舟.md", adoptedArtifactId: "lin-v1",
};
const unadoptedWorld: AuthoringCatalogEntry = {
  id: "river", category: "世界", name: "河港", file: "story/settings/世界/河港.md",
};

describe("fourStepCopy", () => {
  it("uses adopted catalog people without legacy files or a ground confirmation timestamp", () => {
    const authoring = workspaceWith([adoptedPerson, unadoptedWorld]);
    expect(fourStepCopy({ ...newBook, authoring }, true).ground)
      .toBe("设定部分采用 1/2 · 1 位已采用人物");
    expect(fourStepCopy({ ...newBook, authoring }, false).ground)
      .toBe("Settings partly adopted 1/2 · 1 adopted people");
  });

  it("counts current catalog adoptions despite stale coverage, archived entries and new candidates", () => {
    const authoring: AuthoringWorkspace = {
      ...workspaceWith([
        { ...adoptedPerson, candidateArtifactId: "lin-v2" },
        { ...unadoptedWorld, adoptedArtifactId: "river-v1" },
        { ...adoptedPerson, id: "archived", archived: true },
      ]),
      manifest: { coverage: { settingsAdopted: 8, settingsTarget: 10 } },
    };
    expect(fourStepCopy({ ...newBook, authoring }, true).ground)
      .toBe("设定全部采用 2/2 · 1 位已采用人物");
  });

  it("does not count a candidate person as adopted or a world entry as a person", () => {
    const candidatePerson = { ...adoptedPerson, adoptedArtifactId: undefined, candidateArtifactId: "lin-v1" };
    const authoring = workspaceWith([candidatePerson, unadoptedWorld]);
    expect(fourStepCopy({ ...newBook, authoring }, true).ground)
      .toBe("设定尚未采用 0/2 · 0 位已采用人物");
    expect(fourStepCopy({ ...newBook, authoring: workspaceWith([
      candidatePerson, { ...unadoptedWorld, adoptedArtifactId: "river-v1" },
    ]) }, true).ground).toBe("设定部分采用 1/2 · 0 位已采用人物");
  });

  it("recognizes person categories and role paths without counting relationship charts", () => {
    const categories = ["人物", "主要人物", "次要角色", "Characters", "Supporting Characters", "人物关系", "Character Relationships", "世界"];
    const entries = categories.map((category, index) => ({ ...adoptedPerson, id: String(index), category }));
    entries.push({ ...adoptedPerson, id: "path", category: "同伴", file: "story\\roles\\major\\Kai.md" });
    expect(fourStepCopy({ ...newBook, authoring: workspaceWith(entries) }, true).ground)
      .toBe("设定全部采用 9/9 · 6 位已采用人物");
  });

  it("shows an empty catalog for new books and keeps legacy books on their original facts", () => {
    expect(fourStepCopy({ ...newBook, grounded: true, roleCount: 9, authoring: workspaceWith([]) }, true).ground)
      .toBe("尚未拟定设定目录");
    expect(fourStepCopy({ ...newBook, grounded: true, roleCount: 9, authoring: {
      authoringBook: false, catalog: { categories: [], entries: [] },
    } }, true).ground).toBe("设定已定稿 · 9 位人物");
    expect(fourStepCopy({ ...newBook, authoring: {
      ...workspaceWith([adoptedPerson]), authoringBook: false,
    } }, true).ground).toBe("设定全部采用 1/1 · 1 位已采用人物");
  });

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
