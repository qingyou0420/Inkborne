import { describe, expect, it } from "vitest";
import { fanqieRangeProblem } from "./fanqie-range";

describe("fanqieRangeProblem", () => {
  it("rejects a bad range and allows a blank range", () => {
    expect(fanqieRangeProblem("", "", 12, true)).toBe("");
    expect(fanqieRangeProblem("0", "2", 12, true)).toContain("正整数");
    expect(fanqieRangeProblem("3", "1", 12, true)).toContain("不能大于");
    expect(fanqieRangeProblem("1", "13", 12, true)).toContain("超出");
    expect(fanqieRangeProblem("2", "4", 12, true)).toBe("");
  });
});