/** Local update publication paths and setup names, shared with regression tests. */
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { setupNamesForVersion } = require("./alias-legacy-setup.cjs");

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
      path.join(desktop, "Inkborne-Updates"),
      path.join(desktop, "FantaWriter-Updates"),
      path.join(appData, "fantawriter", "updates"),
    ],
    // Always publish the primary name, even when a newer-mtime alias was selected.
    names: [setup.primary, ...setup.aliases],
  };
}

module.exports = { resolveDesktopPath, createUpdatePublishPlan };
