/** SPDX-License-Identifier: AGPL-3.0-only */
import { describe, expect, it, vi } from "vitest";
import { StudioApiError } from "./use-api";
import {
  keepPollingAuthoringRunError,
  AUTHORING_RUN_NOT_FOUND_LIMIT,
  suppressSettledAuthoringRunPollError,
} from "./use-authoring-run";
import { pollWeaveRun } from "../lib/weave-editor-state";
import {
  AUTHORING_SUBMIT_UNKNOWN_MESSAGE,
  isLostSubmitResponse,
  matchActiveAuthoringSubmit,
  recoverAuthoringSubmit,
  submitAuthoringAction,
} from "../lib/recover-authoring-submit";

describe("suppressSettledAuthoringRunPollError", () => {
  it("ignores transient fetch failures once a write run already completed", () => {
    const transient = new StudioApiError("请求暂时失败，请重试；若正文已出现可先刷新");
    expect(suppressSettledAuthoringRunPollError(transient, "completed")).toBe(true);
    expect(suppressSettledAuthoringRunPollError(transient, "running")).toBe(false);
    expect(suppressSettledAuthoringRunPollError(new Error("chapter missing"), "completed")).toBe(false);
  });
});

describe("keepPollingAuthoringRunError", () => {
  it("stops after 10 consecutive 404s and keeps polling other errors", () => {
    const missing = new StudioApiError("找不到运行记录", "NOT_FOUND", 404);
    expect(keepPollingAuthoringRunError(missing, 9)).toBe(true);
    expect(keepPollingAuthoringRunError(missing, 10)).toBe(false);
    expect(keepPollingAuthoringRunError(new Error("offline"), 20)).toBe(true);
  });
});

describe("pollWeaveRun completed-run jitter", () => {
  it("does not surface a transient poll error after the run already completed", async () => {
    vi.useFakeTimers();
    const transient = new StudioApiError("请求暂时失败，请重试；若正文已出现可先刷新");
    const read = vi
      .fn()
      .mockResolvedValueOnce({ runId: "r1", status: "completed", producedArtifactIds: ["a1"] })
      .mockRejectedValueOnce(transient);
    const update = vi.fn();
    const error = vi.fn();
    const stop = pollWeaveRun({
      read,
      update,
      error: (cause) => {
        if (suppressSettledAuthoringRunPollError(cause, update.mock.calls.at(-1)?.[0]?.status)) return;
        error(cause);
      },
      settled: async () => undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledWith({ runId: "r1", status: "completed", producedArtifactIds: ["a1"] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(error).not.toHaveBeenCalled();
    stop();
    vi.useRealTimers();
  });
});

describe("pollWeaveRun 404 stop", () => {
  it("stops polling once keepPollingOnError returns false", async () => {
    vi.useFakeTimers();
    const missing = new StudioApiError("找不到运行记录", "NOT_FOUND", 404);
    const read = vi.fn().mockRejectedValue(missing);
    const error = vi.fn();
    const stop = pollWeaveRun({
      read,
      update: vi.fn(),
      error,
      settled: async () => undefined,
      keepPollingOnError: keepPollingAuthoringRunError,
    });
    for (let i = 0; i < AUTHORING_RUN_NOT_FOUND_LIMIT; i += 1) {
      await vi.advanceTimersByTimeAsync(i === 0 ? 0 : 1000);
    }
    expect(read).toHaveBeenCalledTimes(AUTHORING_RUN_NOT_FOUND_LIMIT);
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(AUTHORING_RUN_NOT_FOUND_LIMIT);
    expect(error).toHaveBeenCalledTimes(AUTHORING_RUN_NOT_FOUND_LIMIT);
    stop();
    vi.useRealTimers();
  });
});

describe("recoverAuthoringSubmit", () => {
  it("binds the existing running review and never posts again", async () => {
    let posts = 0;
    const lost = new StudioApiError("请求暂时失败，请重试；若正文已出现可先刷新");
    lost.kind = "transient";
    expect(isLostSubmitResponse(lost)).toBe(true);
    const result = await submitAuthoringAction({
      post: async () => {
        posts += 1;
        throw lost;
      },
      readWorkspace: async () => ({
        runs: [{ runId: "review-accepted-1", stage: "weave", operation: "review", status: "running" }],
      }),
      match: matchActiveAuthoringSubmit("weave", "review"),
    });
    expect(posts).toBe(1);
    expect(result).toEqual({
      kind: "bound",
      run: { runId: "review-accepted-1", stage: "weave", operation: "review", status: "running" },
    });
  });

  it("stays unknown when no run exists and does not invent a retry post", async () => {
    const lost = new StudioApiError("请求暂时失败，请重试；若正文已出现可先刷新");
    lost.kind = "transient";
    const result = await submitAuthoringAction({
      post: async () => {
        throw lost;
      },
      readWorkspace: async () => ({ runs: [] }),
      match: matchActiveAuthoringSubmit("weave", "review"),
    });
    expect(result).toEqual({ kind: "unknown" });
    const checked = await recoverAuthoringSubmit({
      readWorkspace: async () => ({ runs: [] }),
      match: matchActiveAuthoringSubmit("weave", "review"),
    });
    expect(checked.kind).toBe("unknown");
    expect(AUTHORING_SUBMIT_UNKNOWN_MESSAGE).toContain("核对");
  });
});
