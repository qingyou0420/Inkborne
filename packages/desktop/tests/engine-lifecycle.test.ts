import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  waitForSpawnExit,
  waitUntilPidGone,
  shouldAdoptHealth,
  createRestartBudget,
  nextEngineStatus,
  shouldForceKillLiveEngine,
} = require("../lib/engine-lifecycle.cjs") as {
  waitForSpawnExit: (child: { once: Function } | null, timeoutMs?: number) => Promise<string>;
  waitUntilPidGone: (pid: number, options?: { timeoutMs?: number; intervalMs?: number; isAlive?: (pid: number) => boolean }) => Promise<boolean>;
  shouldAdoptHealth: (health: { ok?: boolean; pid?: number; instanceToken?: string } | null, options?: { ignorePid?: number; instanceToken?: string }) => boolean;
  createRestartBudget: (options?: { windowMs?: number; maxPerWindow?: number; maxPerFault?: number }) => {
    canAutoRestart: (now?: number) => boolean;
    recordAttempt: (now?: number) => void;
    recordSuccess: () => void;
  };
  nextEngineStatus: (input: { quitting?: boolean; recovering?: boolean; healthOk?: boolean; starting?: boolean }) => string;
  shouldForceKillLiveEngine: (input: { childAlive: boolean; healthSlow: boolean }) => boolean;
};

describe("engine lifecycle", () => {
  it("does not adopt a health payload for the pid that is still being stopped", () => {
    expect(shouldAdoptHealth({ ok: true, pid: 4242, instanceToken: "tok" }, { instanceToken: "tok", ignorePid: 4242 })).toBe(false);
    expect(shouldAdoptHealth({ ok: true, pid: 99, instanceToken: "tok" }, { instanceToken: "tok", ignorePid: 4242 })).toBe(true);
  });

  it("waits for the stop child to exit before continuing", async () => {
    const listeners: Record<string, () => void> = {};
    const child = {
      once(event: string, fn: () => void) {
        listeners[event] = fn;
      },
    };
    const pending = waitForSpawnExit(child, 1000);
    listeners.exit?.();
    await expect(pending).resolves.toBe("exited");
  });

  it("waits until a delayed pid is actually gone", async () => {
    let alive = true;
    setTimeout(() => { alive = false; }, 40);
    await expect(waitUntilPidGone(7, { timeoutMs: 400, intervalMs: 10, isAlive: () => alive })).resolves.toBe(true);
  });

  it("caps automatic restarts at one per fault and two per window", () => {
    const budget = createRestartBudget({ windowMs: 1000, maxPerWindow: 2, maxPerFault: 1 });
    expect(budget.canAutoRestart(1)).toBe(true);
    budget.recordAttempt(1);
    expect(budget.canAutoRestart(2)).toBe(false);
    budget.recordSuccess();
    expect(budget.canAutoRestart(3)).toBe(true);
    budget.recordAttempt(3);
    budget.recordSuccess();
    budget.recordAttempt(4);
    budget.recordSuccess();
    expect(budget.canAutoRestart(5)).toBe(false);
  });

  it("does not force-kill a live engine that is only slow to answer health", () => {
    expect(shouldForceKillLiveEngine({ childAlive: true, healthSlow: true })).toBe(false);
    expect(nextEngineStatus({ recovering: true })).toBe("recovering");
    expect(nextEngineStatus({ healthOk: true })).toBe("ready");
    expect(nextEngineStatus({ quitting: true })).toBe("stopped");
  });
});
