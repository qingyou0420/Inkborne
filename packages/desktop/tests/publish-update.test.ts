import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { resolveDesktopPath, createUpdatePublishPlan, resolveSetupHash, publishSetupCopies } = require("../../../scripts/publish-update-paths.cjs") as {
  resolveDesktopPath: (options: Record<string, unknown>) => string;
  createUpdatePublishPlan: (version: string, options: Record<string, unknown>) => { directories: string[]; names: string[] };
  resolveSetupHash: (setupPath: string) => string;
  publishSetupCopies: (destDir: string, srcPath: string, names: string[], hash: string) => string[];
};

const temps: string[] = [];
const FOUR_SETUP_NAMES = [
  "Lightbound-Setup-2.6.1.exe",
  "Inkborne-Setup-2.6.1.exe",
  "FantaWriter-Setup-2.6.1.exe",
  "Fantasy-Writer-Setup-2.6.1.exe",
];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("local update publication", () => {
  it("uses the redirected Windows Desktop for both branded folders and retains AppData", () => {
    const run = vi.fn(() => "E:\\桌面\r\n");
    const plan = createUpdatePublishPlan("2.2.2", {
      platform: "win32", homeDir: "C:\\Users\\Writer", appData: "C:\\Roaming", execFileSync: run,
    });
    // PR-1：桌面更新目录新增 Lightbound-Updates；userData 仍是 fantawriter\updates
    expect(plan.directories).toEqual([
      path.join("E:\\桌面", "Lightbound-Updates"),
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

  it("publishes all four setup names even when the selected input is a legacy alias", () => {
    // PR-1：发布名为主包 Lightbound-Setup，加 Inkborne / FantaWriter / Fantasy-Writer
    const { versionFromSetupName } = require("../lib/setup-artifact.cjs") as { versionFromSetupName: (name: string) => string | null };
    for (const source of ["Inkborne-Setup-2.2.2.exe", "FantaWriter-Setup-2.2.2.exe", "Fantasy-Writer-Setup-2.2.2.exe"]) {
      const plan = createUpdatePublishPlan(versionFromSetupName(source) || "", { platform: "linux", homeDir: "/home/writer", appData: "/data" });
      expect(plan.names).toEqual([
        "Lightbound-Setup-2.2.2.exe",
        "Inkborne-Setup-2.2.2.exe",
        "FantaWriter-Setup-2.2.2.exe",
        "Fantasy-Writer-Setup-2.2.2.exe",
      ]);
    }
  });

  it("writes four exe copies and a sha256 sidecar for each target name", () => {
    // 本机 publish-update：四个目标名各一份 exe 与 .sha256，哈希等于文件真实 SHA-256，名字是各自文件名
    const root = mkdtempSync(path.join(tmpdir(), "fw-publish-"));
    temps.push(root);
    const srcDir = path.join(root, "dist");
    mkdirSync(srcDir);
    const payload = Buffer.from("lightbound-setup-bytes");
    const srcPath = path.join(srcDir, "Lightbound-Setup-2.6.1.exe");
    writeFileSync(srcPath, payload);
    const real = createHash("sha256").update(payload).digest("hex");
    writeFileSync(`${srcPath}.sha256`, `${real.toUpperCase()}  Lightbound-Setup-2.6.1.exe\n`);

    const hash = resolveSetupHash(srcPath);
    expect(hash).toBe(real);
    publishSetupCopies(path.join(root, "out"), srcPath, FOUR_SETUP_NAMES, hash);

    for (const name of FOUR_SETUP_NAMES) {
      const exe = path.join(root, "out", name);
      const bytes = readFileSync(exe);
      expect(bytes.equals(payload)).toBe(true);
      const fileHash = createHash("sha256").update(bytes).digest("hex");
      expect(readFileSync(`${exe}.sha256`, "utf8")).toBe(`${fileHash}  ${name}\n`);
    }
  });

  it("hashes the installer when its sha256 sidecar is missing", () => {
    // 同名 .sha256 不存在时对安装包现算，再按目标文件名写 sidecar
    const root = mkdtempSync(path.join(tmpdir(), "fw-publish-hash-"));
    temps.push(root);
    const payload = Buffer.from("legacy-setup-bytes");
    const srcPath = path.join(root, "Inkborne-Setup-2.6.1.exe");
    writeFileSync(srcPath, payload);
    const real = createHash("sha256").update(payload).digest("hex");
    expect(resolveSetupHash(srcPath)).toBe(real);
    publishSetupCopies(path.join(root, "out"), srcPath, FOUR_SETUP_NAMES, resolveSetupHash(srcPath));
    for (const name of FOUR_SETUP_NAMES) {
      const sidecar = readFileSync(path.join(root, "out", `${name}.sha256`), "utf8");
      expect(sidecar).toBe(`${real}  ${name}\n`);
    }
  });

  it("prefers the dist sidecar hash over recomputing the file", () => {
    // 已有 sidecar 时采用其中记下的哈希
    const root = mkdtempSync(path.join(tmpdir(), "fw-publish-side-"));
    temps.push(root);
    const srcPath = path.join(root, "Lightbound-Setup-2.6.1.exe");
    writeFileSync(srcPath, Buffer.from("payload-not-this-hash"));
    const listed = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    writeFileSync(`${srcPath}.sha256`, `${listed}  Lightbound-Setup-2.6.1.exe\n`);
    expect(resolveSetupHash(srcPath)).toBe(listed);
  });

  it("publish-update.mjs writes sidecars through publishSetupCopies", () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "publish-update.mjs"), "utf8");
    expect(source).toMatch(/resolveSetupHash\(latest\.path\)/);
    expect(source).toMatch(/publishSetupCopies\(dir, latest\.path, names, hash\)/);
  });
});
