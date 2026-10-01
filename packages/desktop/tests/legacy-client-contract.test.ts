import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");
const repoRoot = join(desktopDir, "..", "..");

const { SETUP_RE, preferSetupRank } = require("../lib/setup-artifact.cjs") as {
  SETUP_RE: RegExp;
  preferSetupRank: (name: string) => number;
};
const { setupNamesForVersion } = require("../../../scripts/alias-legacy-setup.cjs") as {
  setupNamesForVersion: (version: string) => {
    primary: string;
    aliases: string[];
    legacy: string;
  };
};
const { createUpdatePublishPlan } = require("../../../scripts/publish-update-paths.cjs") as {
  createUpdatePublishPlan: (
    version: string,
    options: Record<string, unknown>,
  ) => { directories: string[]; names: string[] };
};

/** 2.6.1 已发布客户端内嵌的文件名正则，原样冻结。旧客户端不认 Lightbound-Setup。 */
const LEGACY_CLIENT_SETUP_RE =
  /^(?:Inkborne|FantaWriter|Fantasy-Writer)-Setup-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.exe$/i;

const RELEASE_3_0_0_ASSETS = [
  "Lightbound-Setup-3.0.0.exe",
  "Lightbound-Setup-3.0.0.exe.sha256",
  "Inkborne-Setup-3.0.0.exe",
  "Inkborne-Setup-3.0.0.exe.sha256",
  "FantaWriter-Setup-3.0.0.exe",
  "FantaWriter-Setup-3.0.0.exe.sha256",
  "Fantasy-Writer-Setup-3.0.0.exe",
  "Fantasy-Writer-Setup-3.0.0.exe.sha256",
];

describe("frozen 2.6.1 client can still install 3.0.0", () => {
  it("keeps the 2.6.1 filename regex byte-for-byte", () => {
    expect(LEGACY_CLIENT_SETUP_RE.source).toBe(
      "^(?:Inkborne|FantaWriter|Fantasy-Writer)-Setup-(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)\\.exe$",
    );
    expect(LEGACY_CLIENT_SETUP_RE.flags).toBe("i");
  });

  it("lets a 2.6.1 client see the three legacy 3.0.0 setups and their sha256 files", () => {
    const recognized = RELEASE_3_0_0_ASSETS.filter((name) => LEGACY_CLIENT_SETUP_RE.test(name));
    expect(recognized).toEqual([
      "Inkborne-Setup-3.0.0.exe",
      "FantaWriter-Setup-3.0.0.exe",
      "Fantasy-Writer-Setup-3.0.0.exe",
    ]);
    for (const name of recognized) {
      expect(name.match(LEGACY_CLIENT_SETUP_RE)?.[1]).toBe("3.0.0");
      expect(RELEASE_3_0_0_ASSETS).toContain(`${name}.sha256`);
    }
    expect(LEGACY_CLIENT_SETUP_RE.test("Lightbound-Setup-3.0.0.exe")).toBe(false);
    expect(LEGACY_CLIENT_SETUP_RE.test("Lightbound-Setup-3.0.0.exe.sha256")).toBe(false);
  });

  it("publishes Lightbound as primary and three aliases the frozen regex accepts", () => {
    const names = setupNamesForVersion("3.0.0");
    expect(names.primary).toBe("Lightbound-Setup-3.0.0.exe");
    expect(names.aliases).toEqual([
      "Inkborne-Setup-3.0.0.exe",
      "FantaWriter-Setup-3.0.0.exe",
      "Fantasy-Writer-Setup-3.0.0.exe",
    ]);
    expect(names.legacy).toBe("FantaWriter-Setup-3.0.0.exe");
    for (const alias of names.aliases) {
      expect(alias.match(LEGACY_CLIENT_SETUP_RE)?.[1]).toBe("3.0.0");
    }
    expect(LEGACY_CLIENT_SETUP_RE.test(names.primary)).toBe(false);
  });

  it("recognizes four prefixes and ranks Lightbound before the older names", () => {
    expect(SETUP_RE.flags).toContain("i");
    for (const name of [
      "Lightbound-Setup-3.0.0.exe",
      "Inkborne-Setup-3.0.0.exe",
      "FantaWriter-Setup-3.0.0.exe",
      "Fantasy-Writer-Setup-3.0.0.exe",
    ]) {
      expect(name.match(SETUP_RE)?.[1]).toBe("3.0.0");
    }
    expect(SETUP_RE.test("Lightbound Setup-3.0.0.exe")).toBe(false);
    expect(preferSetupRank("Lightbound-Setup-3.0.0.exe")).toBe(0);
    expect(preferSetupRank("Inkborne-Setup-3.0.0.exe")).toBe(1);
    expect(preferSetupRank("FantaWriter-Setup-3.0.0.exe")).toBe(2);
    expect(preferSetupRank("Fantasy-Writer-Setup-3.0.0.exe")).toBe(3);
  });

  it("keeps appId, process name, userData and the AppUserModelId", () => {
    const yml = readFileSync(join(desktopDir, "electron-builder.yml"), "utf8");
    const main = readFileSync(join(desktopDir, "main.cjs"), "utf8");
    expect(yml).toMatch(/appId:\s*com\.fantawriter\.app/);
    expect(main).toMatch(/app\.setName\("fantawriter"\)/);
    expect(main).toMatch(/app\.setPath\("userData", path\.join\(app\.getPath\("appData"\), "fantawriter"\)\)/);
    expect(main).toMatch(/setAppUserModelId\("com\.fantawriter\.app"\)/);
    expect(main).toMatch(/process\.env\.UPDATE_GITHUB_REPO \|\| DEFAULT_GITHUB_REPO/);
  });

  it("scans Lightbound-Updates first and still scans the three older desktop folders", () => {
    const main = readFileSync(join(desktopDir, "main.cjs"), "utf8");
    const block = main.match(/desktopUpdatesFolder:[\s\S]*?exeDir:/)?.[0] ?? "";
    const lightbound = block.indexOf('"Lightbound-Updates"');
    const inkborne = block.indexOf('"Inkborne-Updates"');
    const fanta = block.indexOf('"FantaWriter-Updates"');
    const fantasy = block.indexOf('"Fantasy-Writer-Updates"');
    expect(lightbound).toBeGreaterThanOrEqual(0);
    expect(lightbound).toBeLessThan(inkborne);
    expect(inkborne).toBeLessThan(fanta);
    expect(fanta).toBeLessThan(fantasy);
    expect(main).toMatch(/path\.join\(app\.getPath\("temp"\), "Lightbound-Updates"\)/);
    expect(main).toMatch(/Lightbound-Setup-x\.y\.z\.exe/);
    expect(main).toMatch(/Inkborne-Setup-x\.y\.z\.exe/);
    expect(main).toMatch(/FantaWriter-Setup-x\.y\.z\.exe/);
    expect(main).toMatch(/Fantasy-Writer-Setup-x\.y\.z\.exe/);
  });

  it("release-win.yml uploads and checks four setup exes plus sha256", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release-win.yml"), "utf8");
    for (const prefix of ["Lightbound-Setup", "Inkborne-Setup", "FantaWriter-Setup", "Fantasy-Writer-Setup"]) {
      expect(workflow).toMatch(new RegExp(`^\\s*dist-installer/${prefix}-\\*\\.exe\\s*$`, "m"));
      expect(workflow).toMatch(new RegExp(`^\\s*dist-installer/${prefix}-\\*\\.exe\\.sha256\\s*$`, "m"));
      expect(workflow).toMatch(
        new RegExp(`test -f "dist-installer/${prefix}-\\$\\{\\{\\s*steps\\.meta\\.outputs\\.version\\s*\\}\\}\\.exe"`),
      );
      expect(workflow).toMatch(
        new RegExp(`test -f "dist-installer/${prefix}-\\$\\{\\{\\s*steps\\.meta\\.outputs\\.version\\s*\\}\\}\\.exe\\.sha256"`),
      );
    }
    expect(workflow).toMatch(/fail_on_unmatched_files:\s*true/);
    expect(workflow).toMatch(/asset=Lightbound-Setup-\$\{PKG\}\.exe/);
  });

  it("publishes Lightbound-Updates and keeps userData updates under fantawriter", () => {
    const plan = createUpdatePublishPlan("3.0.0", {
      platform: "win32",
      homeDir: "C:\\Users\\Writer",
      appData: "C:\\Users\\Writer\\AppData\\Roaming",
      execFileSync: () => "E:\\桌面\r\n",
    });
    expect(plan.directories).toEqual([
      path.join("E:\\桌面", "Lightbound-Updates"),
      path.join("E:\\桌面", "Inkborne-Updates"),
      path.join("E:\\桌面", "FantaWriter-Updates"),
      path.join("C:\\Users\\Writer\\AppData\\Roaming", "fantawriter", "updates"),
    ]);
    expect(plan.names).toEqual([
      "Lightbound-Setup-3.0.0.exe",
      "Inkborne-Setup-3.0.0.exe",
      "FantaWriter-Setup-3.0.0.exe",
      "Fantasy-Writer-Setup-3.0.0.exe",
    ]);
  });
});
