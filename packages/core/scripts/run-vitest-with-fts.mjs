/**
 * Run the core Vitest suite with FTS5-only files included.
 * Meant for Electron's node:sqlite (which has FTS5), not system Node.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const vitestEntry = require.resolve("vitest/vitest.mjs");
const child = spawn(process.execPath, [vitestEntry, "run"], {
  stdio: "inherit",
  env: { ...process.env, INKOS_TEST_INCLUDE_FTS: "1" },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
