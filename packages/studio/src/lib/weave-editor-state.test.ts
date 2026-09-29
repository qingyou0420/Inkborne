/** SPDX-License-Identifier: AGPL-3.0-only */
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendUnplannedChapter, pollWeaveRun, readWeaveSegment, replaceWeaveSegment, resolveWeaveVolumeRange, saveOutlineMap } from "./weave-editor-state";
import { applyOutlineWorkspaceSave, parseVolumeMapTree } from "./volume-map-tree";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("candidate segment replace", () => {
  const markdown = [
    "卷前备注：这句必须保留。",
    "",
    "# 第一卷 起（1-2章）",
    "上卷目标。",
    "",
    "## 第 1 章 雨",
    "港口开场。",
    "",
    "## 第 12 章 旧账",
    "夜里翻账。",
    "",
  ].join("\n");

  it("replaces one chapter without dropping leading notes or other chapters", () => {
    const next = replaceWeaveSegment(markdown, "chapter:12", { title: "夜深", summary: "只改这一章。" });
    expect(next).toContain("卷前备注：这句必须保留。");
    expect(next).toContain("港口开场。");
    expect(next).toContain("上卷目标。");
    expect(next).toContain("只改这一章。");
    expect(next).not.toContain("夜里翻账。");
    expect(readWeaveSegment(next, "chapter:12")).toMatchObject({ title: "夜深", summary: "只改这一章。" });
  });
});

describe("weave generation and revision range", () => {
  const volumes = [{ startChapter: 1, endChapter: 50 }, { startChapter: 51, endChapter: 100 }, { startChapter: 101, endChapter: 260 }];

  it("starts with the selected volume instead of the full 260 chapters", () => {
    expect(resolveWeaveVolumeRange(volumes, volumes[1], 260)).toEqual({ startChapter: 51, endChapter: 100 });
    expect(resolveWeaveVolumeRange(volumes, null, 260)).toEqual({ startChapter: 1, endChapter: 50 });
  });

  it("keeps the selected volume when its end chapter changed after replanning", () => {
    expect(resolveWeaveVolumeRange(volumes, { startChapter: 51, endChapter: 120 }, 260)).toEqual({ startChapter: 51, endChapter: 100 });
  });
});

describe("adopted outline writes", () => {
  it("keeps the edited chapter when adding a new chapter to the same saved file", async () => {
    const state = { current: "## 第 1 章 旧题\n旧提要\n", pending: false };
    const persist = vi.fn().mockResolvedValue(undefined);
    await saveOutlineMap(state, (current) => {
      const edited = applyOutlineWorkspaceSave(current, "chapter:1", "新题", "新提要");
      return appendUnplannedChapter(edited, 1).content;
    }, persist);
    const chapters = parseVolumeMapTree(state.current).orphanChapters;
    expect(chapters.map((chapter) => chapter.chapterNumber)).toEqual([1, 2]);
    expect(chapters[0]).toMatchObject({ title: "新题", summary: "新提要" });
    expect(persist).toHaveBeenCalledExactlyOnceWith(state.current);
  });

  it("rejects a competing tidy/add during a save, then transforms the newly saved map", async () => {
    const state = { current: "before", pending: false };
    const firstWrite = deferred<void>();
    const persist = vi.fn().mockReturnValueOnce(firstWrite.promise).mockResolvedValue(undefined);
    const first = saveOutlineMap(state, () => "edited", persist);
    const competingTransform = vi.fn(() => "stale overwrite");
    expect(await saveOutlineMap(state, competingTransform, persist)).toBe(false);
    expect(competingTransform).not.toHaveBeenCalled();
    firstWrite.resolve();
    expect(await first).toBe(true);
    expect(await saveOutlineMap(state, (current) => `${current}\nappended`, persist)).toBe(true);
    expect(state.current).toBe("edited\nappended");
    expect(persist.mock.calls.map(([body]) => body)).toEqual(["edited", "edited\nappended"]);
  });

  it("preserves the prior map and releases the write lock after a rejected save", async () => {
    const state = { current: "kept", pending: false };
    await expect(saveOutlineMap(state, () => "draft", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(state).toEqual({ current: "kept", pending: false });
    expect(await saveOutlineMap(state, () => "retry", async () => {})).toBe(true);
    expect(state.current).toBe("retry");
  });

  it("does not duplicate a prose chapter already covered by a planned range", () => {
    const next = appendUnplannedChapter("## 第 1–12 章 起\n粗纲\n", 1);
    expect(next.chapterNumber).toBe(13);
    expect(next.content).toContain("## 第 13 章");
  });
});

describe("weave run polling", () => {
  it("surfaces a revision failure reason and refreshes its saved partial candidate", async () => {
    vi.useFakeTimers();
    const result = { runId: "revision", status: "partial", error: "模型达到输出上限，请继续剩余范围。", progressDone: 4, progressTotal: 50 };
    const read = vi.fn().mockResolvedValue(result);
    const update = vi.fn();
    const settled = vi.fn().mockResolvedValue(undefined);
    const stop = pollWeaveRun({ read, update, settled, error: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(update).toHaveBeenCalledExactlyOnceWith(result);
    expect(settled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(1);
    stop();
  });
  it("never overlaps slow reads and stops once the terminal result is refreshed", async () => {
    vi.useFakeTimers();
    const slow = deferred<{ status: string }>();
    const read = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue({ status: "completed" });
    const update = vi.fn();
    const settled = vi.fn().mockResolvedValue(undefined);
    const stop = pollWeaveRun({ read, update, settled, error: vi.fn() });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    slow.resolve({ status: "running" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(update.mock.calls.map(([run]) => run.status)).toEqual(["running", "completed"]);
    expect(settled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it("discards a late response from the old polling cycle after resuming the same run ID", async () => {
    vi.useFakeTimers();
    const oldRead = deferred<{ runId: string; status: string }>();
    const update = vi.fn();
    const settled = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockReturnValueOnce(oldRead.promise).mockResolvedValue({ runId: "same", status: "running" });
    const options = { read, update, settled, error: vi.fn() };
    const stopOld = pollWeaveRun(options);
    stopOld();
    const stopResumed = pollWeaveRun(options);
    await vi.advanceTimersByTimeAsync(0);
    oldRead.resolve({ runId: "same", status: "paused" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(update.mock.calls.map(([run]) => run.status)).toEqual(["running", "running"]);
    expect(settled).not.toHaveBeenCalled();
    stopResumed();
  });

  it("retries a failed read without discarding the last progress", async () => {
    vi.useFakeTimers();
    const failure = new Error("offline");
    const read = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ status: "paused" });
    const error = vi.fn();
    const update = vi.fn();
    const stop = pollWeaveRun({ read, update, error, settled: async () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(update).toHaveBeenCalledExactlyOnceWith({ status: "paused" });
    stop();
  });
});
