// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Every test is checked with the project's strict options and full transitive
// imports. Sequential fresh compiler processes bound peak memory on Windows.
const project = process.cwd();
const require = createRequire(resolve(project, "package.json"));
const ts = require("typescript");
const configPath = resolve(project, "tsconfig.tests.json");
const raw = ts.readConfigFile(configPath, ts.sys.readFile);
if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, project, { noEmit: true }, configPath);
const diagnosticHost = { getCanonicalFileName: (name) => name, getCurrentDirectory: () => project, getNewLine: () => "\n" };
if (parsed.errors.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(parsed.errors, diagnosticHost));
  process.exit(1);
}
const batchSize = 20;
if (process.argv[2] === "--batch") {
  const offset = Number(process.argv[3]);
  const program = ts.createProgram(parsed.fileNames.slice(offset, offset + batchSize), parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost));
  process.exit(diagnostics.length ? 1 : 0);
}
if (!parsed.fileNames.length) throw new Error("No test files were found; refusing an empty type check.");
console.log(`Strict test typecheck: ${parsed.fileNames.length} files, sequential batches of ${batchSize}.`);
let failed = false;
for (let offset = 0; offset < parsed.fileNames.length; offset += batchSize) {
  console.log(`Checking test files ${offset + 1}–${Math.min(offset + batchSize, parsed.fileNames.length)}…`);
  const result = spawnSync(process.execPath, ["--max-old-space-size=768", "--max-semi-space-size=4", fileURLToPath(import.meta.url), "--batch", String(offset)], {
    cwd: project, stdio: "inherit", windowsHide: true,
  });
  if (result.status !== 0) {
    failed = true;
    if (result.error || result.signal || result.status === null || result.status < 0 || result.status > 1) {
      console.error(`Test compiler process failed: ${result.error?.message ?? result.signal ?? result.status}`);
      break;
    }
  }
}
process.exitCode = failed ? 1 : 0;
