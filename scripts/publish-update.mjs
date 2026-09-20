/**
 * 打包完成后，把最新 Inkborne-Setup（或旧名 FantaWriter-Setup / Fantasy-Writer-Setup）复制到可扫描目录：
 * 1. 桌面/Inkborne-Updates 与 FantaWriter-Updates
 * 2. %APPDATA%/fantawriter/updates（Electron userData）
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { SETUP_RE } = require("./setup-artifact.cjs");
const { createUpdatePublishPlan } = require("./publish-update-paths.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist-installer");

function parseSemver(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmp(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function copyTo(src, destDir, destName = path.basename(src)) {
  ensureDir(destDir);
  const dest = path.join(destDir, destName);
  fs.copyFileSync(src, dest);
  return dest;
}

function findLatestSetup() {
  if (!fs.existsSync(distDir)) {
    console.error("[publish-update] 无 dist-installer 目录");
    process.exit(1);
  }
  const files = fs
    .readdirSync(distDir)
    .map((name) => {
      const m = name.match(SETUP_RE);
      if (!m) return null;
      const full = path.join(distDir, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) return null;
        return { name, version: m[1], path: full, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!files.length) {
    console.error("[publish-update] 未找到 Inkborne-Setup-*.exe / FantaWriter-Setup-*.exe");
    process.exit(1);
  }
  files.sort((a, b) => {
    const c = cmp(b.version, a.version);
    return c !== 0 ? c : b.mtime - a.mtime;
  });
  return files[0];
}

const latest = findLatestSetup();
const { directories: targets, names } = createUpdatePublishPlan(latest.version);
console.log(
  `[publish-update] 发布 ${latest.name} (v${latest.version}) → 可被已安装客户端扫描的目录`
);
for (const dir of targets) {
  try {
    for (const name of names) {
      const dest = copyTo(latest.path, dir, name);
      console.log(`  ✓ ${dest}`);
    }
  } catch (e) {
    console.warn(`  ✗ ${dir}: ${e.message || e}`);
  }
}
console.log(
  "[publish-update] 完成。已装客户端可在应用内「系统 → 检查更新」后一键安装。"
);
