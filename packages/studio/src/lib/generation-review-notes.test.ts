/** SPDX-License-Identifier: AGPL-3.0-only */
import { describe, expect, it } from "vitest";
import type { AuthoringReport } from "./authoring-workspace";
import { generationReviewNotes, withGenerationReview } from "./generation-review-notes";

const report: AuthoringReport = {
  reportId: "review-v1", stage: "ground", coverage: "world and cast", actualReviewModel: "reviewer",
  targetRefs: ["world-v1", "cast-v1"], summary: "Check continuity",
  issues: [{ issueId: "i1", severity: "priority", title: "Character age changes", suggestion: "Preserve the established age" }],
};

describe("review notes carried into regeneration", () => {
  it("includes the complete current advice together with the author's new requirements", () => {
    const notes = generationReviewNotes(report, ["world-v1", "cast-v1"]);
    expect(notes).toContain("Character age changes");
    expect(notes).toContain("Preserve the established age");
    const combined = withGenerationReview("Keep the ending", notes);
    expect(combined).toContain("Keep the ending");
    expect(combined).toContain("Check continuity");
  });
  it.each([
    { reviewed: report, targets: ["world-v2"] },
    { reviewed: report, targets: ["world-v1", "cast-v2"] },
    { reviewed: report, targets: [undefined] },
    { reviewed: report, targets: [] },
    { reviewed: { ...report, stale: true }, targets: ["world-v1"] },
    { reviewed: { ...report, incomplete: true }, targets: ["world-v1"] },
  ])("does not implicitly apply a partial, stale, missing or different-version report: $targets", ({ reviewed, targets }) => {
    expect(generationReviewNotes(reviewed, targets)).toBeUndefined();
    expect(withGenerationReview("Keep the ending", generationReviewNotes(reviewed, targets))).toBe("Keep the ending");
  });
});
