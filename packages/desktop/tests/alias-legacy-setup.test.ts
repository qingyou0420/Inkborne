import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  CURRENT_SETUP_PREFIX,
  LEGACY_SETUP_PREFIXES,
  LEGACY_SETUP_PREFIX,
  setupNamesForVersion,
  hashFromSha256Sidecar,
  aliasLegacySetup,
} = require("../../../scripts/alias-legacy-setup.cjs") as {
  CURRENT_SETUP_PREFIX: string;
  LEGACY_SETUP_PREFIXES: string[];
  LEGACY_SETUP_PREFIX: string;
  setupNamesForVersion: (version: string) => {
    version: string;
    primary: string;
    aliases: string[];
    legacy: string;
  };
  hashFromSha256Sidecar: (text: string) => string;
  aliasLegacySetup: (opts: { distDir: string; version: string }) => {
    primary: string;
    aliases: string[];
    legacy: string;
    sha256: string;
  };
};

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("alias-legacy-setup names", () => {
  it("treats Lightbound-Setup as primary and emits three legacy prefixes", () => {
    // PR-1：主安装包前缀改为 Lightbound-Setup，另复制三套旧名
    expect(CURRENT_SETUP_PREFIX).toBe("Lightbound-Setup");
    expect(LEGACY_SETUP_PREFIXES).toEqual(["Inkborne-Setup", "FantaWriter-Setup", "Fantasy-Writer-Setup"]);
    // 别名数组前插入 Inkborne-Setup 后，该导出仍指最旧前缀，不跟下标走
    expect(LEGACY_SETUP_PREFIX).toBe("Fantasy-Writer-Setup");
    const names = setupNamesForVersion("v3.0.0");
    expect(names.version).toBe("3.0.0");
    expect(names.primary).toBe("Lightbound-Setup-3.0.0.exe");
    expect(names.aliases).toEqual([
      "Inkborne-Setup-3.0.0.exe",
      "FantaWriter-Setup-3.0.0.exe",
      "Fantasy-Writer-Setup-3.0.0.exe",
    ]);
    expect(names.legacy).toBe("FantaWriter-Setup-3.0.0.exe");
    expect(names.legacy).not.toBe(names.aliases[0]);
  });
});

describe("aliasLegacySetup", () => {
  it("copies primary Lightbound-Setup to three legacy names with matching sha256", () => {
    // PR-1：主文件改为 Lightbound-Setup，复制出三个旧名并各写 .sha256
    const distDir = mkdtempSync(join(tmpdir(), "fw-alias-"));
    temps.push(distDir);
    const primaryName = "Lightbound-Setup-3.0.0.exe";
    const payload = Buffer.from("lightbound-setup-fixture");
    writeFileSync(join(distDir, primaryName), payload);
    const sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    writeFileSync(join(distDir, `${primaryName}.sha256`), `${sha256}  ${primaryName}\n`);

    const result = aliasLegacySetup({ distDir, version: "3.0.0" });
    expect(result.sha256).toBe(sha256);
    expect(result.aliases).toHaveLength(3);
    expect(result.legacy).toBe(join(distDir, "FantaWriter-Setup-3.0.0.exe"));
    expect(result.legacy).not.toBe(result.aliases[0]);

    for (const name of ["Inkborne-Setup-3.0.0.exe", "FantaWriter-Setup-3.0.0.exe", "Fantasy-Writer-Setup-3.0.0.exe"]) {
      const dest = join(distDir, name);
      expect(readFileSync(dest).equals(payload)).toBe(true);
      expect(hashFromSha256Sidecar(readFileSync(`${dest}.sha256`, "utf8"))).toBe(sha256);
      expect(readFileSync(`${dest}.sha256`, "utf8")).toMatch(new RegExp(`  ${name}\\n$`));
    }
  });

  it("throws when the Lightbound primary is missing", () => {
    const distDir = mkdtempSync(join(tmpdir(), "fw-alias-missing-"));
    temps.push(distDir);
    expect(() => aliasLegacySetup({ distDir, version: "3.0.0" })).toThrow(/找不到安装包/);
  });
});
