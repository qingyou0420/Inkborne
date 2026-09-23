import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(desktopDir, "main.cjs"), "utf8");
const appSource = readFileSync(join(desktopDir, "..", "studio", "src", "App.tsx"), "utf8");
const handles = require("../lib/engine-handle.cjs") as {
  emptyEngineHandle: () => { child: { pid?: number } | null; pid: number; port: number; token: string };
  attachSpawnedEngine: (handle: { child: unknown; pid: number; port: number; token: string }, child: { pid?: number }, port: number, token: string) => unknown;
};
const lifecycle = require("../lib/engine-lifecycle.cjs") as {
  createRestartBudget: () => unknown;
};

function part(from: string, to: string) {
  const a = source.indexOf(from);
  const b = source.indexOf(to, a);
  if (a < 0 || b <= a) throw new Error(`Cannot find ${from}`);
  return source.slice(a, b);
}

const stopPart = part("async function stopEngine(", "function provisionProjectRoot(");
const resolvePart = part("async function resolveEngineUrl(", "function createWindow(");
const restartPart = part("async function restartEngine(", "function parseSemver(");
const bootPart = part("async function boot()", "const gotLock =");

function context() {
  const events: unknown[] = [];
  const ctx: Record<string, unknown> = {
    ...handles,
    ...lifecycle,
    events,
    engineHandle: handles.emptyEngineHandle(),
    engineProcess: null,
    enginePort: 17831,
    instanceToken: "review-owner",
    projectRoot: "/synthetic-unused",
    quitting: false,
    stoppingEngine: false,
    recoveringEngine: false,
    restartJob: null,
    autoRestartBudget: lifecycle.createRestartBudget(),
    process: { platform: "win32" },
    HOST: "127.0.0.1",
    SCAN_START: 17831,
    setTimeout: (fn: () => void, ms: number) => {
      if (ms === 800) ctx.resumeWorker = fn;
      else fn();
      return 1;
    },
    clearTimeout: () => undefined,
    appendLog: (line: string) => events.push(line),
    setEngineStatus: (status: string, extra: Record<string, unknown> = {}) => {
      ctx.status = status;
      events.push({ status, ...extra });
    },
    loadShellConfig: () => ({ instanceToken: "review-owner", enginePort: 17831 }),
    provisionProjectRoot: () => "/synthetic-unused",
    ensureProjectLayout: () => undefined,
    saveShellConfig: (value: unknown) => events.push({ savedConfig: value }),
    postJson: async () => {
      events.push("shutdown requested");
      return 202;
    },
    waitUntilPidGone: async () => true,
    waitForSpawnExit: async () => "exited",
    canBindPort: async () => true,
    pickListenPort: async () => 17832,
    waitForHealth: async () => undefined,
    spawn: (cmd: string, args: string[]) => {
      events.push({ spawned: cmd, args });
      return {};
    },
    registerIpc: () => undefined,
    buildMenu: () => undefined,
    app: { quit: () => events.push("app quit") },
    dialog: { showErrorBox: (title: string, message: string) => events.push({ dialog: title, message }) },
    getLogPath: () => "/synthetic-unused/log",
    powerMonitor: { on: (_name: string, cb: () => void) => { ctx.resumeListener = cb; } },
    createWindow: (url: string) => { ctx.rendererUrl = `${url}/books/synthetic?stage=write&chapter=3`; },
    mainWindow: { loadURL: (url: string) => { ctx.rendererUrl = url; events.push({ loadURL: url }); } },
    isPidAlive: (pid: number) => pid === 4242,
  };
  ctx.startEngine = (port: number) => {
    events.push({ startEngine: port, quitting: ctx.quitting });
    ctx.engineProcess = { pid: 5151, exitCode: null };
    handles.attachSpawnedEngine(ctx.engineHandle as never, ctx.engineProcess as never, port, "review-owner");
    return `http://127.0.0.1:${port}`;
  };
  vm.createContext(ctx);
  return ctx;
}

describe("desktop main chain", () => {
  it("does not kill an adopted live engine when wake health is slow", async () => {
    const c = context();
    let first = true;
    let oldAlive = true;
    c.probeHealth = async () => {
      if (first) {
        first = false;
        return { ok: true, pid: 4242, instanceToken: "review-owner" };
      }
      (c.events as unknown[]).push({ healthTimeout: true, pidActuallyAlive: oldAlive });
      return null;
    };
    c.isPidAlive = () => oldAlive;
    c.spawn = (cmd: string, args: string[]) => {
      (c.events as unknown[]).push({ spawned: cmd, args, targetWasAlive: oldAlive });
      oldAlive = false;
      return {};
    };
    vm.runInContext(stopPart + resolvePart + restartPart + bootPart, c);
    await (c.boot as () => Promise<void>)();
    expect((c.engineHandle as { pid: number }).pid).toBe(4242);
    expect(c.engineProcess).toBeNull();
    (c.resumeListener as () => void)();
    await (c.resumeWorker as () => Promise<void>)();
    const killedLiveAdoptedEngine = (c.events as Array<{ spawned?: string; targetWasAlive?: boolean }>).some(
      (event) => event.spawned === "taskkill" && event.targetWasAlive,
    );
    expect(killedLiveAdoptedEngine).toBe(false);
    expect(c.status).toBe("needs-attention");
  });

  it("stops on the old port instead of announcing ready on a new origin", async () => {
    const c = context();
    c.rendererUrl = "http://127.0.0.1:17831/books/synthetic?stage=write&chapter=3";
    c.engineProcess = { pid: 4242, exitCode: null };
    handles.attachSpawnedEngine(c.engineHandle as never, c.engineProcess as never, 17831, "review-owner");
    let now = 0;
    c.Date = { now: () => { now += 1000; return now; } };
    c.canBindPort = async (port: number) => {
      (c.events as unknown[]).push({ canBindPort: port, available: false });
      return false;
    };
    c.probeHealth = async () => ({ ok: true, pid: 4343, instanceToken: "other-owner" });
    vm.runInContext(stopPart + resolvePart + restartPart, c);
    await expect((c.restartEngine as () => Promise<string>)()).rejects.toThrow(/原端口|占用|恢复/);
    expect(c.status).toBe("needs-attention");
    const started = (c.events as Array<{ startEngine?: number }>).some((event) => event.startEngine === 17832);
    expect(started).toBe(false);
    const start = appSource.indexOf("return api.onEngineStatus((detail) => {");
    const bodyStart = appSource.indexOf("{", start) + 1;
    const bodyEnd = appSource.indexOf("\n    });", bodyStart);
    const rendererEvents: Array<{ status?: string }> = [];
    const listener = new Function("detail", "emitEngineConnection", appSource.slice(bodyStart, bodyEnd));
    listener({ status: c.status }, (event: { status?: string }) => rendererEvents.push(event));
    expect(rendererEvents.some((event) => event.status === "ready")).toBe(false);
  });

  it("coalesces concurrent restart requests", async () => {
    const c = context();
    let release!: () => void;
    let stops = 0;
    let starts = 0;
    c.stopEngine = () => {
      stops += 1;
      return new Promise((resolve) => { release = () => resolve({ pidGone: true, portFree: true, port: 17831, pid: 1 }); });
    };
    c.resolveEngineUrl = async () => {
      starts += 1;
      return "http://127.0.0.1:17831";
    };
    vm.runInContext(restartPart, c);
    const first = (c.restartEngine as () => Promise<string>)();
    const second = (c.restartEngine as () => Promise<string>)();
    release();
    await Promise.all([first, second]);
    expect(stops).toBe(1);
    expect(starts).toBe(1);
  });
});
