import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");
const repoRoot = join(desktopDir, "..", "..");
const rootPkg = require(join(repoRoot, "package.json")) as { version: string; scripts: Record<string, string> };
const desktopPkg = require(join(desktopDir, "package.json")) as {
  name: string;
  version: string;
  license: string;
  description: string;
  author: string;
};
const { setupFileNameForVersion } = require("../lib/setup-artifact.cjs") as {
  setupFileNameForVersion: (version: string) => string;
};
const { CURRENT_SETUP_PREFIX, setupNamesForVersion } = require("../../../scripts/alias-legacy-setup.cjs") as {
  CURRENT_SETUP_PREFIX: string;
  setupNamesForVersion: (version: string) => { primary: string; aliases: string[]; legacy: string };
};

describe("2.6.1 Windows installer contract", () => {
  it("keeps root and desktop on the same stable 2.6.1", () => {
    expect(rootPkg.version).toBe("2.6.1");
    expect(desktopPkg.version).toBe("2.6.1");
    expect(desktopPkg.license).toBe("AGPL-3.0-only");
    expect(desktopPkg.name).toBe("@fantawriter/desktop");
    expect(rootPkg.scripts["dist:win"]).toBe("node scripts/dist-win.mjs");
    expect(rootPkg.scripts["dist:win"]).not.toMatch(/exit 1/);
  });

  it("names the NSIS artifact Lightbound-Setup-2.6.1.exe and keeps appId", () => {
    // PR-1：主安装包、产品名、快捷方式改为 Lightbound / 轻光之集；appId 不变
    expect(setupFileNameForVersion(rootPkg.version)).toBe("Lightbound-Setup-2.6.1.exe");
    const yml = readFileSync(join(desktopDir, "electron-builder.yml"), "utf8");
    expect(yml).toMatch(/appId:\s*com\.fantawriter\.app/);
    expect(yml).toMatch(/productName:\s*Lightbound/);
    expect(yml).toMatch(/artifactName:\s*Lightbound-Setup-\$\{version\}\.\$\{ext\}/);
    expect(yml).toMatch(/shortcutName:\s*轻光之集 Lightbound/);
    expect(yml).toMatch(/uninstallDisplayName:\s*轻光之集 Lightbound/);
    expect(yml).toMatch(/轻光之集 \/ Lightbound/);
    expect(yml).toMatch(/原名墨生万象 \/ Inkborne，更早为幻想作家/);
    expect(yml).toMatch(/InkOS © upstream authors/);
    expect(yml).toMatch(/legalTrademarks:\s*Lightbound \/ 轻光之集/);
    expect(desktopPkg.description).toBe("Lightbound / 轻光之集 desktop shell around the InkOS Studio engine");
    expect(desktopPkg.author).toBe("Lightbound / 轻光之集");
    expect(yml).toMatch(/from:\s*\.\.\/\.\.\/dist-engine/);
    expect(yml).toMatch(/to:\s*engine/);
    expect(yml).not.toMatch(/src\/app|next\.config/);
  });

  it("packs and releases Lightbound-Setup as primary, with three legacy aliases", () => {
    // PR-1：主安装包改为 Lightbound-Setup，Release 同时上传三套旧名及各自 .sha256
    const distWin = readFileSync(join(repoRoot, "scripts", "dist-win.mjs"), "utf8");
    expect(distWin).toMatch(/setupFileNameForVersion\(rootPkg\.version\)/);
    expect(distWin).not.toMatch(/FantaWriter-Setup-\$\{rootPkg\.version\}/);
    expect(distWin).toMatch(/Lightbound\.exe/);
    expect(distWin).toMatch(/INKBORNE_ALLOW_UNBRANDED_EXE/);

    expect(CURRENT_SETUP_PREFIX).toBe("Lightbound-Setup");
    const names = setupNamesForVersion("2.6.1");
    expect(names.primary).toBe("Lightbound-Setup-2.6.1.exe");
    expect(names.aliases).toEqual([
      "Inkborne-Setup-2.6.1.exe",
      "FantaWriter-Setup-2.6.1.exe",
      "Fantasy-Writer-Setup-2.6.1.exe",
    ]);
    expect(names.legacy).toBe("FantaWriter-Setup-2.6.1.exe");

    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release-win.yml"), "utf8");
    expect(workflow).toMatch(/asset=Lightbound-Setup-\$\{PKG\}\.exe/);
    expect(workflow).toMatch(/win-unpacked\\Lightbound\.exe/);
    expect(workflow).toMatch(/ProductName -ne "Lightbound"/);
    expect(workflow).toMatch(/FileDescription -notmatch "Lightbound"/);
    expect(workflow).toMatch(/Lightbound\.exe has no usable associated icon/);
    for (const prefix of ["Lightbound-Setup", "Inkborne-Setup", "FantaWriter-Setup", "Fantasy-Writer-Setup"]) {
      expect(workflow).toMatch(new RegExp(`^\\s*dist-installer/${prefix}-\\*\\.exe\\s*$`, "m"));
      expect(workflow).toMatch(new RegExp(`^\\s*dist-installer/${prefix}-\\*\\.exe\\.sha256\\s*$`, "m"));
      expect(workflow).toMatch(new RegExp(`test -f "dist-installer/${prefix}-\\$\\{\\{\\s*steps\\.meta\\.outputs\\.version\\s*\\}\\}\\.exe"`));
      expect(workflow).toMatch(new RegExp(`test -f "dist-installer/${prefix}-\\$\\{\\{\\s*steps\\.meta\\.outputs\\.version\\s*\\}\\}\\.exe\\.sha256"`));
    }
    expect(workflow).toMatch(/fail_on_unmatched_files:\s*true/);
  });

  it("ships icon.ico so the Windows installer is not the default Electron icon", () => {
    const ico = join(repoRoot, "build", "icon.ico");
    const png = join(repoRoot, "build", "icon.png");
    const mark = join(repoRoot, "build", "inkborne-mark.png");
    const desktopIco = join(desktopDir, "icon.ico");
    const yml = readFileSync(join(desktopDir, "electron-builder.yml"), "utf8");
    expect(existsSync(ico)).toBe(true);
    expect(existsSync(png)).toBe(true);
    expect(existsSync(mark)).toBe(true);
    expect(existsSync(desktopIco)).toBe(true);
    const header = readFileSync(ico).subarray(0, 4);
    expect(header.equals(Buffer.from([0, 0, 1, 0]))).toBe(true);
    expect(icoFrameSizes(readFileSync(ico))).toContain(256);
    expect(readFileSync(desktopIco).equals(readFileSync(ico))).toBe(true);
    expect(yml).toMatch(/buildResources:\s*\.\.\/\.\.\/build/);
    expect(yml).toMatch(/icon:\s*icon\.ico/);
    expect(yml).toMatch(/^\s*- icon\.png$/m);
    expect(yml).toMatch(/^\s*- icon\.ico$/m);
    expect(yml).not.toMatch(/^\s*signAndEditExecutable:\s*false/m);
  });

  it("lets rcedit brand the exe and does not silently ship an unbranded fallback", () => {
    const yml = readFileSync(join(desktopDir, "electron-builder.yml"), "utf8");
    const distWin = readFileSync(join(repoRoot, "scripts", "dist-win.mjs"), "utf8");
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release-win.yml"), "utf8");
    const main = readFileSync(join(desktopDir, "main.cjs"), "utf8");
    expect(yml).toMatch(/appId:\s*com\.fantawriter\.app/);
    expect(yml).not.toMatch(/^\s*signAndEditExecutable:\s*false/m);
    expect(distWin).toMatch(/INKBORNE_ALLOW_UNBRANDED_EXE/);
    expect(distWin).toMatch(/UNBRANDED\.txt/);
    expect(distWin).not.toMatch(/首次打包失败，跳过签名重试/);
    expect(workflow).toMatch(/ProductName/);
    expect(workflow).toMatch(/ExtractAssociatedIcon/);
    expect(workflow).toMatch(/UNBRANDED\.txt/);
    expect(main).toMatch(/process\.platform === "win32" \? "icon\.ico" : "icon\.png"/);
    expect(main.match(/process\.platform === "win32" \? "icon\.ico" : "icon\.png"/g)?.length).toBe(3);
  });

  it("brands the Electron window as 墨生万象, not InkOS, and skips the setup wizard", () => {
    const main = readFileSync(join(desktopDir, "main.cjs"), "utf8");
    expect(main).toMatch(/title: "墨生万象 \/ Inkborne"/);
    expect(main).toMatch(/process\.platform === "win32" \? "icon\.ico" : "icon\.png"/);
    expect(main).not.toMatch(/title: "InkOS/);
    expect(main).not.toMatch(/createWindow\(firstRunFileUrl\(\)\)/);
    expect(main).toMatch(/provisionProjectRoot/);
  });
});

/** ICONDIR width bytes: 0 means 256. */
function icoFrameSizes(buf: Buffer): number[] {
  expect(buf.readUInt16LE(0)).toBe(0);
  expect(buf.readUInt16LE(2)).toBe(1);
  const count = buf.readUInt16LE(4);
  expect(count).toBeGreaterThan(0);
  const sizes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const width = buf[6 + i * 16];
    sizes.push(width === 0 ? 256 : width);
  }
  return sizes;
}
