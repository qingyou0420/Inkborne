/**
 * H3: assemble extraResources/engine from prebuilt Studio dist + core build.
 * Server runtime is only hono + @hono/node-server + @actalk/inkos-core
 * (and core's registry deps). Do not deploy the Studio SPA's frontend graph.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { assertNoSecrets } = require("./lib/refuse-secrets.cjs");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(repoRoot, "dist-engine");

function run(command, args, cwd = repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      // Keep executable/script paths with spaces intact for Node subprocesses.
      shell: process.platform === "win32" && command !== process.execPath,
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function mustExist(rel, label = rel) {
  const abs = join(dest, rel);
  if (!existsSync(abs)) {
    throw new Error(`assemble-engine: 缺少 ${label} (${abs})`);
  }
  return abs;
}

const studioDist = join(repoRoot, "packages", "studio", "dist");
const studioEntry = join(studioDist, "api", "index.js");
const studioHtml = join(studioDist, "index.html");
const coreDir = join(repoRoot, "packages", "core");
const coreEntry = join(coreDir, "dist", "index.js");
if (!existsSync(studioEntry) || !existsSync(studioHtml) || !existsSync(coreEntry)) {
  console.log("[assemble-engine] building @actalk/inkos-core + @actalk/inkos-studio");
  await run("pnpm", ["--filter", "@actalk/inkos-core", "build"]);
  await run("pnpm", ["--filter", "@actalk/inkos-studio", "build"]);
}

const studioPkg = JSON.parse(readFileSync(join(repoRoot, "packages", "studio", "package.json"), "utf8"));
const hono = studioPkg.dependencies.hono;
const honoNode = studioPkg.dependencies["@hono/node-server"];
if (!hono || !honoNode) {
  throw new Error("assemble-engine: studio package.json missing hono / @hono/node-server");
}

if (existsSync(dest)) {
  rmSync(dest, { recursive: true, force: true });
}
mkdirSync(dest, { recursive: true });

console.log("[assemble-engine] copy packages/studio/dist");
cpSync(studioDist, join(dest, "dist"), { recursive: true });

console.log("[assemble-engine] copy packages/core build + genres/skills/craft");
const vendorCore = join(dest, "vendor", "inkos-core");
mkdirSync(vendorCore, { recursive: true });
for (const part of ["dist", "genres", "skills", "craft", "package.json"]) {
  const from = join(coreDir, part);
  if (!existsSync(from)) throw new Error(`assemble-engine: 缺少 core ${part}`);
  cpSync(from, join(vendorCore, part), { recursive: true });
}

writeFileSync(
  join(dest, "package.json"),
  `${JSON.stringify(
    {
      name: "@fantawriter/engine",
      version: studioPkg.version,
      private: true,
      type: "module",
      main: "dist/api/index.js",
      license: "AGPL-3.0-only",
      dependencies: {
        "@actalk/inkos-core": "file:./vendor/inkos-core",
        "@hono/node-server": honoNode,
        hono,
      },
    },
    null,
    2,
  )}\n`,
);

console.log("[assemble-engine] npm install server runtime (core + hono)");
await run(
  "npm",
  ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  dest,
);

mustExist("dist/api/index.js", "packages/studio/dist/api/index.js");
mustExist("dist/index.html", "packages/studio/dist/index.html");
mustExist("node_modules/@actalk/inkos-core/dist/index.js", "core build");
mustExist("vendor/inkos-core/genres", "core genres");
mustExist("vendor/inkos-core/skills", "core skills");
mustExist("vendor/inkos-core/craft", "core craft");
mustExist("node_modules/hono/package.json", "hono");
mustExist("node_modules/@hono/node-server/package.json", "@hono/node-server");

assertNoSecrets(dest, "dist-engine");
await run(process.execPath, [join(repoRoot, "scripts", "engine-pack-smoke.mjs")]);
console.log(`[assemble-engine] ok ${dest}`);
console.log("[assemble-engine] studio dist + core build + slim server node_modules ready for extraResources");
