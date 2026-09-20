/** SPDX-License-Identifier: AGPL-3.0-only */
import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissToast, showToast, subscribeToasts } from "./toast";

describe("toast actions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  if (typeof globalThis.window === "undefined") {
    Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
  }

  it("keeps an action button payload for the host", () => {
    const seen: string[] = [];
    const stop = subscribeToasts((items) => {
      const last = items.at(-1);
      if (last) seen.push(`${last.message}:${last.action?.label ?? ""}`);
    });
    showToast("正典已采用", "success", { label: "进入研墨", onClick: () => undefined });
    stop();
    expect(seen.at(-1)).toBe("正典已采用:进入研墨");
  });

  it("dismisses the toast after the action timeout", () => {
    vi.useFakeTimers();
    let count = 0;
    const stop = subscribeToasts((items) => { count = items.length; });
    showToast("章节已采用", "success", { label: "写下一章", onClick: () => undefined });
    expect(count).toBe(1);
    vi.advanceTimersByTime(4200);
    expect(count).toBe(1);
    vi.advanceTimersByTime(4000);
    expect(count).toBe(0);
    stop();
    dismissToast(-1);
  });
});
