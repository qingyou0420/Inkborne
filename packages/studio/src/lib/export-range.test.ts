/**
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, it } from "vitest";
import { normalizeRange, normalizeRangeField, parseChapterDraft } from "./export-range";

describe("export range drafts", () => {
  it("reads a typed number without clamping it", () => {
    expect(parseChapterDraft("12")).toBe(12);
    expect(parseChapterDraft("  7 ")).toBe(7);
    expect(parseChapterDraft("999")).toBe(999);
  });

  it("keeps an empty draft empty", () => {
    expect(parseChapterDraft("")).toBeNull();
    expect(parseChapterDraft("   ")).toBeNull();
    expect(normalizeRangeField("", 12)).toBe("");
    expect(normalizeRangeField("   ", 12)).toBe("");
    expect(normalizeRange("", "", 12)).toEqual({ from: "", to: "", swapped: false });
  });

  it("clamps out-of-range numbers and truncates decimals toward zero", () => {
    expect(normalizeRangeField("0", 12)).toBe("1");
    expect(normalizeRangeField("999", 12)).toBe("12");
    expect(normalizeRangeField("-3", 12)).toBe("1");
    expect(parseChapterDraft("3.7")).toBe(3);
    expect(normalizeRangeField("3.7", 12)).toBe("3");
    expect(normalizeRangeField("0.4", 12)).toBe("1");
  });

  it("treats non-numeric text as an empty bound instead of guessing 1", () => {
    expect(parseChapterDraft("abc")).toBeNull();
    expect(parseChapterDraft("3章")).toBeNull();
    expect(normalizeRangeField("abc", 12)).toBe("");
    expect(normalizeRangeField("3章", 12)).toBe("");
  });

  it("swaps when the start is after the end", () => {
    expect(normalizeRange("5", "2", 12)).toEqual({ from: "2", to: "5", swapped: true });
    expect(normalizeRange("  8 ", "3", 12)).toEqual({ from: "3", to: "8", swapped: true });
    expect(normalizeRange("2", "5", 12)).toEqual({ from: "2", to: "5", swapped: false });
    expect(normalizeRange("4", "", 12).swapped).toBe(false);
  });

  it("only clamps the lower bound when the chapter total is unknown", () => {
    expect(normalizeRangeField("999", 0)).toBe("999");
    expect(normalizeRangeField("0", 0)).toBe("1");
    expect(normalizeRangeField("-3", 0)).toBe("1");
    expect(normalizeRange("0", "999", 0)).toEqual({ from: "1", to: "999", swapped: false });
  });

  it("accepts fullwidth digits", () => {
    expect(parseChapterDraft("１２")).toBe(12);
    expect(parseChapterDraft("  ７ ")).toBe(7);
    expect(normalizeRangeField("１２", 20)).toBe("12");
    expect(normalizeRangeField("０", 20)).toBe("1");
    expect(normalizeRangeField("３．７", 20)).toBe("3");
    expect(normalizeRange("５", "２", 12)).toEqual({ from: "2", to: "5", swapped: true });
  });
});
