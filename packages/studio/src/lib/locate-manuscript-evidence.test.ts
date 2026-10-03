/** SPDX-License-Identifier: AGPL-3.0-only */
import { describe, expect, it } from "vitest";
import { evidenceQuery, findEvidenceInHaystack } from "./locate-manuscript-evidence";

describe("locate manuscript evidence", () => {
  it("finds the quote inside the manuscript text even with collapsed whitespace", () => {
    const haystack = "林把铜牌藏进抽屉。\n\n灯花轻轻一跳。";
    const match = findEvidenceInHaystack(haystack, "林把铜牌藏进抽屉。");
    expect(match).toEqual({ start: 0, length: "林把铜牌藏进抽屉。".length });
    const spaced = findEvidenceInHaystack("林把  铜牌藏进抽屉。", "林把 铜牌藏进抽屉。");
    expect(spaced?.start).toBe(0);
  });

  it("stays on the first manuscript match when the same quote is searched again", () => {
    const haystack = "依据短句。后文又写了依据短句。";
    const first = findEvidenceInHaystack(haystack, "依据短句");
    const second = findEvidenceInHaystack(haystack, "依据短句");
    expect(first).toEqual(second);
    expect(first?.start).toBe(0);
  });

  it("returns nothing when the quote is only in the review pane", () => {
    expect(findEvidenceInHaystack("正文完全是另一段。", "审查报告里的原句")).toBeUndefined();
    expect(evidenceQuery("  林把铜牌藏进抽屉。  ")).toBe("林把铜牌藏进抽屉。");
  });
});
