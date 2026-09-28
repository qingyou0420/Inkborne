/** SPDX-License-Identifier: AGPL-3.0-only */
import { describe, expect, it } from "vitest";
import { bookAuthoringHash } from "./authoring-nav";

describe("authoring stage hashes", () => {
  it("maps adopt next-steps onto the four-stage routes", () => {
    expect(bookAuthoringHash("书一", "ground")).toBe("#/book/%E4%B9%A6%E4%B8%80/ground");
    expect(bookAuthoringHash("书一", "weave")).toBe("#/book/%E4%B9%A6%E4%B8%80/weave");
    expect(bookAuthoringHash("书一", "write")).toBe("#/book/%E4%B9%A6%E4%B8%80/write");
  });
});
