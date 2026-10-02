/** Local update publication paths and setup names, shared with regression tests. */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { setupNamesForVersion, hashFromSha256Sidecar, writeSha256Sidecar } = require("./alias-legacy-setup.cjs");

function resolveDesktopPath(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  if ((options.platform || process.platform) === "win32") {
    try {
      const run = options.execFileSync || execFileSync;
      const desktop = String(run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)",
      ], { encoding: "utf8", windowsHide: true, timeout: 5000 })).trim();
      if (path.win32.isAbsolute(desktop)) return desktop;
    } catch {
      // A missing or unavailable shell must not prevent AppData publication.
    }
  }
  return path.join(homeDir, "Desktop");
}

function createUpdatePublishPlan(version, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const desktop = resolveDesktopPath({ ...options, homeDir });
  const appData = options.appData || process.env.APPDATA || path.join(homeDir, "AppData", "Roaming");
  const setup = setupNamesForVersion(version);
  return {
    directories: [
      path.join(desktop, "Lightbound-Updates"),
      path.join(desktop, "Inkborne-Updates"),
      path.join(desktop, "FantaWriter-Updates"),
      path.join(appData, "fantawriter", "updates"),
    ],
    // Always publish the primary name, even when a newer-mtime alias was selected.
    names: [setup.primary, ...setup.aliases],
  };
}

function sha256OfFile(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

/** 优先读同名 .sha256；没有则对安装包现算 SHA-256。 */
function resolveSetupHash(setupPath) {
  const sidecar = `${setupPath}.sha256`;
  if (fs.existsSync(sidecar)) {
    return hashFromSha256Sidecar(fs.readFileSync(sidecar, "utf8"));
  }
  return sha256OfFile(setupPath);
}

/** 把一个安装包复制成多个文件名，并为每个目标写 `<名字>.sha256`。 */
function publishSetupCopies(destDir, srcPath, names, hash) {
  fs.mkdirSync(destDir, { recursive: true });
  const written = [];
  for (const name of names) {
    const dest = path.join(destDir, name);
    fs.copyFileSync(srcPath, dest);
    writeSha256Sidecar(dest, hash, name);
    written.push(dest);
  }
  return written;
}

module.exports = { resolveDesktopPath, createUpdatePublishPlan, resolveSetupHash, publishSetupCopies };
