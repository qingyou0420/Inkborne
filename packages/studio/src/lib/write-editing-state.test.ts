/** SPDX-License-Identifier: AGPL-3.0-only */
import { describe, expect, it } from "vitest";
import { editingAfterStream } from "./write-editing-state";

describe("editingAfterStream", () => {
  it("returns to reading when a candidate was produced", () => {
    expect(editingAfterStream({ wasEditing: true, artifactProduced: true })).toBe(false);
    expect(editingAfterStream({ wasEditing: false, artifactProduced: true })).toBe(false);
  });

  it("keeps the mode from before the stream when nothing was produced", () => {
    expect(editingAfterStream({ wasEditing: true, artifactProduced: false })).toBe(true);
    expect(editingAfterStream({ wasEditing: false, artifactProduced: false })).toBe(false);
  });
});
