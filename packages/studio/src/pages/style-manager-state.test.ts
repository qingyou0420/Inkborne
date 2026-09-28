import { describe, expect, it } from "vitest";
import { buildStyleStatusNotice } from "./StyleManager";

describe("buildStyleStatusNotice", () => {
  it("surfaces analyze errors even when no profile is available yet", () => {
    expect(buildStyleStatusNotice("失败：分析没有完成", "")).toEqual({
      tone: "error",
      message: "失败：分析没有完成",
    });
  });

  it("falls back to import status when there is no analyze error", () => {
    expect(buildStyleStatusNotice("", "文风已导入")).toEqual({
      tone: "success",
      message: "文风已导入",
    });
  });

  it("returns null when there is nothing to show", () => {
    expect(buildStyleStatusNotice("", "")).toBeNull();
  });
});
