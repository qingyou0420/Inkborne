import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { resolveDesktopPath, createUpdatePublishPlan } = require("../../../scripts/publish-update-paths.cjs") as {
  resolveDesktopPath: (options: Record<string, unknown>) => string;
  createUpdatePublishPlan: (version: string, options: Record<string, unknown>) => { directories: string[]; names: string[] };
};

describe("local update publication", () => {
  it("uses the redirected Windows Desktop for both branded folders and retains AppData", () => {
    const run = vi.fn(() => "E:\\桌面\r\n");
    const plan = createUpdatePublishPlan("2.2.2", {
      platform: "win32", homeDir: "C:\\Users\\Writer", appData: "C:\\Roaming", execFileSync: run,
    });
    expect(plan.directories).toEqual([
      path.join("E:\\桌面", "Inkborne-Updates"),
      path.join("E:\\桌面", "FantaWriter-Updates"),
      path.join("C:\\Roaming", "fantawriter", "updates"),
    ]);
    expect(run).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining(["-NoProfile", "-NonInteractive"]), expect.objectContaining({ windowsHide: true, encoding: "utf8", timeout: 5000 }));
  });

  it.each([() => { throw new Error("PowerShell unavailable"); }, () => "", () => "relative-desktop"])("falls back to the home Desktop if Known Folder resolution fails", (run) => {
    expect(resolveDesktopPath({ platform: "win32", homeDir: "C:\\Users\\Writer", execFileSync: run }))
      .toBe(path.join("C:\\Users\\Writer", "Desktop"));
  });

  it("publishes all three setup names even when the selected input is a legacy alias", () => {
    const { versionFromSetupName } = require("../lib/setup-artifact.cjs") as { versionFromSetupName: (name: string) => string };
    for (const source of ["FantaWriter-Setup-2.2.2.exe", "Fantasy-Writer-Setup-2.2.2.exe"]) {
      const plan = createUpdatePublishPlan(versionFromSetupName(source), { platform: "linux", homeDir: "/home/writer", appData: "/data" });
      expect(plan.names).toEqual(["Inkborne-Setup-2.2.2.exe", "FantaWriter-Setup-2.2.2.exe", "Fantasy-Writer-Setup-2.2.2.exe"]);
    }
  });
});
