/** SPDX-License-Identifier: AGPL-3.0-only */
import { describe, expect, it } from "vitest";
import {
  askRetryAction,
  groundRetryAction,
  previousChapterSettleHold,
  producedArtifactForScope,
  selectScopedAuthoringRun,
  shouldAutoTakeoverAuthoringRun,
  writeRetryAction,
  type AuthoringRunLike,
} from "./authoring-run-selection";

function run(partial: AuthoringRunLike): AuthoringRunLike {
  return partial;
}

describe("selectScopedAuthoringRun", () => {
  const runs = [
    run({ runId: "w5-review", stage: "write", status: "failed", operation: "review", scope: "chapter:5" }),
    run({ runId: "w7-gen", stage: "write", status: "completed", operation: "generate", scope: "chapter:7" }),
    run({ runId: "ask-1", stage: "ask", status: "failed", operation: "review" }),
  ];

  it("keeps a chapter-5 review failure off chapter 7", () => {
    expect(selectScopedAuthoringRun(runs, "write", "chapter:7")?.runId).toBe("w7-gen");
    expect(selectScopedAuthoringRun(runs, "write", "chapter:5")?.runId).toBe("w5-review");
    expect(selectScopedAuthoringRun(runs, "write", "chapter:1")).toBeUndefined();
  });

  it("still finds the latest ask run without a scope", () => {
    expect(selectScopedAuthoringRun(runs, "ask")?.runId).toBe("ask-1");
  });
});

describe("shouldAutoTakeoverAuthoringRun", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");

  it("takes over live runs and recent failures only", () => {
    expect(shouldAutoTakeoverAuthoringRun({ status: "running" }, now)).toBe(true);
    expect(shouldAutoTakeoverAuthoringRun({ status: "pausing" }, now)).toBe(true);
    expect(shouldAutoTakeoverAuthoringRun({ status: "failed", updatedAt: "2026-09-20T11:55:00.000Z" }, now)).toBe(true);
    expect(shouldAutoTakeoverAuthoringRun({ status: "failed", updatedAt: "2026-09-20T11:00:00.000Z" }, now)).toBe(false);
    expect(shouldAutoTakeoverAuthoringRun({ status: "completed", updatedAt: "2026-09-20T11:59:00.000Z" }, now)).toBe(false);
  });
});

describe("retry dispatch", () => {
  it("sends write settle / review / generate by operation", () => {
    expect(writeRetryAction("settle")).toBe("settle");
    expect(writeRetryAction("review")).toBe("review");
    expect(writeRetryAction("generate")).toBe("generate");
    expect(writeRetryAction("revise")).toBe("generate");
  });

  it("sends ask review failures back to review", () => {
    expect(askRetryAction("review")).toBe("review");
    expect(askRetryAction("revise")).toBe("generate");
    expect(askRetryAction("generate")).toBe("generate");
  });

  it("sends ground review to review and empty catalogs to catalog", () => {
    expect(groundRetryAction({ operation: "review" }, true)).toBe("review");
    expect(groundRetryAction({ operation: "generate" }, false)).toBe("catalog");
    expect(groundRetryAction({ operation: "generate" }, true)).toBe("generate");
    expect(groundRetryAction({ operation: "revise" }, true)).toBe("generate");
  });

  it("holds the next chapter while the previous settle is still live", () => {
    const runs = [
      run({ runId: "s1", stage: "write", status: "running", operation: "settle", scope: "chapter:1" }),
      run({ runId: "g2", stage: "write", status: "completed", operation: "generate", scope: "chapter:2" }),
    ];
    expect(previousChapterSettleHold(runs, 2)?.runId).toBe("s1");
    expect(previousChapterSettleHold(runs, 1)).toBeUndefined();
    expect(previousChapterSettleHold([
      run({ runId: "s1", stage: "write", status: "failed", operation: "settle", scope: "chapter:1" }),
    ], 2)).toBeUndefined();
  });

  it("only adopts produced artifacts that belong to the current scope", () => {
    expect(producedArtifactForScope({ scope: "chapter:5", producedArtifactIds: ["a5"] }, "chapter:5")).toBe("a5");
    expect(producedArtifactForScope({ scope: "chapter:5", producedArtifactIds: ["a5"] }, "chapter:7")).toBeUndefined();
  });
});
