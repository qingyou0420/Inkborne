/**
 * Windows NSIS pack for @fantawriter/desktop wrapping the InkOS Studio engine.
 * Never starts or ships the retired Next.js 1.x Studio.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { assertNoSecrets } = require("./lib/refuse-secrets.cjs");
const { setupFileNameForVersion } = require("./setup-artifact.cjs");
const { aliasLegacySetup } = require("./alias-legacy-setup.cjs");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(repoRoot, "packages", "desktop");
const distDir = join(repoRoot, "dist-installer");
const skipPublish = process.argv.includes("--publish-never") || Boolean(process.env.CI);
const dirOnly = process.argv.includes("--dir");

function run(command, args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      // Node is an executable, not a command shim. A shell splits paths such as
      // C:\Program Files\nodejs\node.exe and a workspace containing spaces.
      shell: process.platform === "win32" && command !== process.execPath,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", ...extraEnv },
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function runNode(script, args = []) {
  return run(process.execPath, [join(repoRoot, script), ...args], repoRoot);
}

const rootPkg = require(join(repoRoot, "package.json"));
const desktopPkg = require(join(desktopDir, "package.json"));
if (rootPkg.version !== desktopPkg.version) {
  throw new Error(`root version ${rootPkg.version} ≠ desktop ${desktopPkg.version}`);
}
if (/-/.test(rootPkg.version)) {
  throw new Error(`拒绝预发布安装包名 ${rootPkg.version}；正式 Windows 包请用 2.0.0 这类稳定版本`);
}

await runNode("scripts/refuse-next-1x.mjs");
console.log("[dist:win] build core + studio");
await run("pnpm", ["--filter", "@actalk/inkos-core", "build"], repoRoot);
await run("pnpm", ["--filter", "@actalk/inkos-studio", "build"], repoRoot);
await runNode("scripts/assemble-engine.mjs");
assertNoSecrets(join(repoRoot, "dist-engine"), "dist-engine");

if (process.platform === "win32") {
  try {
    await runNode("scripts/patch-electron-rename.mjs");
  } catch (error) {
    console.warn(`[dist:win] electron-builder rename patch skipped: ${error instanceof Error ? error.message : error}`);
  }
}

const builderArgs = dirOnly
  ? ["exec", "electron-builder", "--win", "dir", "--publish", "never"]
  : ["exec", "electron-builder", "--win", "nsis", "--publish", "never"];

async function buildInstaller() {
  try {
    await run("pnpm", builderArgs, desktopDir);
  } catch (first) {
    if (dirOnly) throw first;
    if (process.env.INKBORNE_ALLOW_UNBRANDED_EXE !== "1") {
      throw new Error(
        "[dist:win] electron-builder 失败。不要用 signAndEditExecutable=false 兜底（会跳过 rcedit，桌面 / 任务栏仍是 Electron 默认图标）。紧急放行请设 INKBORNE_ALLOW_UNBRANDED_EXE=1。"
        + ` 原错误：${first instanceof Error ? first.message : first}`,
        { cause: first },
      );
    }
    console.error("[dist:win] 首次打包失败；INKBORNE_ALLOW_UNBRANDED_EXE=1，将跳过 rcedit（无品牌图标）");
    await run("pnpm", [...builderArgs, "-c.win.signAndEditExecutable=false"], desktopDir, {
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      CSC_LINK: "",
      WIN_CSC_LINK: "",
      CSC_KEY_PASSWORD: "",
      WIN_CSC_KEY_PASSWORD: "",
    });
    writeFileSync(
      join(distDir, "UNBRANDED.txt"),
      [
        "UNBRANDED Windows build",
        "Packed with signAndEditExecutable=false; Inkborne.exe keeps the default Electron icon.",
        "Do not ship this artifact. Rebuild with rcedit enabled.",
        "",
      ].join("\n"),
    );
    console.error("[dist:win] 已写出 dist-installer/UNBRANDED.txt — 此包不得发版");
  }
}

await buildInstaller();

if (!dirOnly) {
  const asset = setupFileNameForVersion(rootPkg.version);
  const assetPath = join(distDir, asset);
  if (!existsSync(assetPath)) {
    throw new Error(`找不到安装包 ${assetPath}`);
  }
  const bytes = statSync(assetPath).size;
  if (bytes < 10 * 1024 * 1024) {
    throw new Error(
      `安装包过小（${bytes} bytes）。NSIS 可能没打完（Linux 上需要 wine；发版请用 windows-latest）。`,
    );
  }
  const sha = createHash("sha256").update(readFileSync(assetPath)).digest("hex");
  writeFileSync(`${assetPath}.sha256`, `${sha}  ${asset}\n`);
  console.log(`[dist:win] sha256 ${sha}  ${asset}`);
  aliasLegacySetup({ distDir, version: rootPkg.version });
  assertNoSecrets(distDir, "dist-installer");
}

if (!skipPublish && !dirOnly) {
  await runNode("scripts/publish-update.mjs");
}

console.log("[dist:win] done");
