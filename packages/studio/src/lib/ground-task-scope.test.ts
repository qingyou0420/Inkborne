/** SPDX-License-Identifier: AGPL-3.0-only */
import { describe, expect, it } from "vitest";
import type { AuthoringCatalogEntry, AuthoringReport } from "./authoring-workspace";
import { groundGenerationScope, groundRevisionScope } from "./ground-task-scope";

const a: AuthoringCatalogEntry = { id: "a", name: "甲", category: "人物", file: "a.md", candidateArtifactId: "a1" };
const b: AuthoringCatalogEntry = { id: "b", name: "乙", category: "人物", file: "b.md", adoptedArtifactId: "b1" };
const c: AuthoringCatalogEntry = { id: "c", name: "丙", category: "人物", file: "c.md" };
const report: AuthoringReport = { reportId: "r", stage: "ground", coverage: "甲、乙", actualReviewModel: "test", summary: "review", targetRefs: ["a1", "b1"], issues: [{ issueId: "ia", severity: "improve", title: "甲的问题", target: "a" }, { issueId: "ib", severity: "improve", title: "乙的问题", target: "乙" }] };

describe("ground task scope", () => {
  it("fills only missing entries and prohibits regeneration", () => {
    expect(groundGenerationScope([a, b, c], [])).toEqual({ entryIds: ["c"], regenerate: false });
  });
  it("explicit selection can regenerate only selected visible entries", () => {
    expect(groundGenerationScope([a, b, c, { ...c, id: "old", archived: true }], ["a", "old"])).toEqual({ entryIds: ["a"], regenerate: true });
  });
  it("all complete entries are a clearly separate regeneration scope", () => {
    expect(groundGenerationScope([a, b], [])).toEqual({ entryIds: ["a", "b"], regenerate: true });
  });
  it("a batch report's B issue revises B even after the directory focuses A", () => {
    expect(groundRevisionScope([a, b], report, ["ib"])).toEqual({ entryIds: ["b"] });
  });
  it("combines targets for selected issues without duplicates", () => {
    expect(groundRevisionScope([a, b], report, ["ib", "ia", "ib"])).toEqual({ entryIds: ["a", "b"] });
  });
  it("rejects unknown issue IDs instead of silently performing a partial revision", () => {
    expect(groundRevisionScope([a, b], report, ["ia", "gone"])).toEqual({ error: "unknown-issue" });
  });
  it("rejects missing or archived targets instead of substituting the focused entry", () => {
    expect(groundRevisionScope([a], report, ["ib"])).toEqual({ error: "unavailable-target" });
    expect(groundRevisionScope([a, { ...b, archived: true }], report, ["ib"])).toEqual({ error: "unavailable-target" });
  });
  it("rejects untargeted issues and entries with no current artifact", () => {
    expect(groundRevisionScope([a], { ...report, issues: [{ issueId: "i", severity: "improve", title: "无目标" }] }, ["i"])).toEqual({ error: "unavailable-target" });
    expect(groundRevisionScope([a, { ...b, adoptedArtifactId: undefined }], report, ["ib"])).toEqual({ error: "unavailable-target" });
  });
  it("requires explicit reuse when the actual revision target has a newer version", () => {
    expect(groundRevisionScope([a, { ...b, candidateArtifactId: "b2" }], report, ["ib"])).toEqual({ error: "changed-version" });
    expect(groundRevisionScope([a, { ...b, candidateArtifactId: "b2" }], report, ["ib"], true)).toEqual({ entryIds: ["b"] });
  });
  it("never revises an incomplete report, even with explicit stale reuse", () => {
    expect(groundRevisionScope([a, b], { ...report, incomplete: true }, ["ib"], true)).toEqual({ error: "unavailable-report" });
  });
});
