/**
 * Engine stop/restart helpers. Isolated so tests can cover races
 * without touching a live Inkborne process.
 */

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForSpawnExit(child, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!child || typeof child.once !== "function") {
      resolve("missing");
      return;
    }
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    const done = (reason) => {
      clearTimeout(timer);
      resolve(reason);
    };
    child.once("exit", () => done("exited"));
    child.once("error", () => done("error"));
  });
}

function isPidAlive(pid, killFn = process.kill.bind(process)) {
  if (!pid) return false;
  try {
    killFn(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

async function waitUntilPidGone(pid, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 100;
  const alive = options.isAlive ?? isPidAlive;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!alive(pid)) return true;
    await delay(intervalMs);
  }
  return !alive(pid);
}

function shouldAdoptHealth(health, options = {}) {
  if (!health?.ok) return false;
  if (options.ignorePid && Number(health.pid) === Number(options.ignorePid)) return false;
  if (options.instanceToken && health.instanceToken !== options.instanceToken) return false;
  return true;
}

function createRestartBudget(options = {}) {
  const windowMs = options.windowMs ?? 10 * 60 * 1000;
  const maxPerWindow = options.maxPerWindow ?? 2;
  const maxPerFault = options.maxPerFault ?? 1;
  let windowStart = 0;
  let windowCount = 0;
  let faultAttempts = 0;
  return {
    canAutoRestart(now = Date.now()) {
      if (now - windowStart > windowMs) {
        windowStart = now;
        windowCount = 0;
      }
      return faultAttempts < maxPerFault && windowCount < maxPerWindow;
    },
    recordAttempt(now = Date.now()) {
      if (now - windowStart > windowMs) {
        windowStart = now;
        windowCount = 0;
      }
      windowCount += 1;
      faultAttempts += 1;
    },
    recordSuccess() {
      faultAttempts = 0;
    },
    reset() {
      windowStart = 0;
      windowCount = 0;
      faultAttempts = 0;
    },
  };
}

function nextEngineStatus(input) {
  if (input.quitting) return "stopped";
  if (input.recovering) return "recovering";
  if (input.healthOk) return "ready";
  if (input.starting) return "connecting";
  return "needs-attention";
}

function shouldForceKillLiveEngine({ childAlive, healthSlow }) {
  return !(childAlive && healthSlow);
}

module.exports = {
  delay,
  waitForSpawnExit,
  isPidAlive,
  waitUntilPidGone,
  shouldAdoptHealth,
  createRestartBudget,
  nextEngineStatus,
  shouldForceKillLiveEngine,
};
