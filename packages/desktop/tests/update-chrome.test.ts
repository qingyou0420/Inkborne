import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");
const { DEFAULT_GITHUB_REPO } = require("../lib/github-release.cjs") as {
  DEFAULT_GITHUB_REPO: string;
};

function read(rel: string): string {
  return readFileSync(join(desktopDir, rel), "utf8");
}

describe("desktop update chrome", () => {
  it("exposes check/download/install on the preload bridge", () => {
    const preload = read("preload.cjs");
    expect(preload).toMatch(/checkUpdate:/);
    expect(preload).toMatch(/app:checkUpdate/);
    expect(preload).toMatch(/downloadUpdate:/);
    expect(preload).toMatch(/app:downloadUpdate/);
    expect(preload).toMatch(/installUpdate:/);
    expect(preload).toMatch(/app:installUpdate/);
    expect(preload).toMatch(/openUpdatePanel:/);
    expect(preload).toMatch(/exposeInMainWorld\("fantaWriter"/);
    expect(preload).not.toMatch(/window\.fw\b/);
  });

  it("puts 检查更新 on Help/About and ships a file:// overlay", () => {
    const main = read("main.cjs");
    const panel = read("update-panel.html");
    const yml = read("electron-builder.yml");
    const firstRun = read("first-run.html");

    expect(existsSync(join(desktopDir, "update-panel.html"))).toBe(true);
    expect(main).toMatch(/label: "帮助"/);
    expect(main).toMatch(/label: "检查更新"/);
    expect(main).toMatch(/openUpdatePanel/);
    expect(main).toMatch(/openCheckUpdateUi/);
    expect(main).toMatch(/buttons: \["检查更新", "关闭"\]/);
    expect(main).toMatch(/update-panel\.html/);
    expect(main).toMatch(/选择墨生万象安装包/);
    expect(main).not.toMatch(/选择 FantaWriter 安装包/);
    const bootFn = main.match(/async function boot\(\) \{[\s\S]*?\nconst gotLock/);
    expect(bootFn?.[0] ?? "").not.toMatch(/checkUpdate\(|checkGithubLatest|findLatestInstaller/);
    expect(bootFn?.[0] ?? "").not.toMatch(/firstRunFileUrl|first-run\.html/);

    expect(panel).toMatch(/<h1>检查更新<\/h1>/);
    expect(panel).toMatch(/>下载</);
    expect(panel).toMatch(/>安装并重启</);
    expect(panel).not.toMatch(/更新源/);
    expect(panel).not.toMatch(/从 GitHub 检查/);
    expect(panel).toMatch(/window\.fantaWriter/);
    expect(panel).toMatch(/api\.checkUpdate\(\)/);
    expect(panel).toMatch(/api\.downloadUpdate/);
    expect(panel).toMatch(/api\.installUpdate/);
    expect(panel).not.toMatch(/silent:\s*true/);

    expect(yml).toMatch(/^\s*- update-panel\.html$/m);
    expect(firstRun).toMatch(/系统 → 检查更新/);
    expect(DEFAULT_GITHUB_REPO).toBe("qingyou0420/Inkborne");
  });
});
