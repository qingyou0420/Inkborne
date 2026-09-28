import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  CURRENT_SETUP_PREFIX,
  LEGACY_SETUP_PREFIXES,
  setupNamesForVersion,
  hashFromSha256Sidecar,
  aliasLegacySetup,
} = require("../../../scripts/alias-legacy-setup.cjs") as {
  CURRENT_SETUP_PREFIX: string;
  LEGACY_SETUP_PREFIXES: string[];
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
  it("treats Inkborne-Setup as primary and emits both legacy prefixes", () => {
    expect(CURRENT_SETUP_PREFIX).toBe("Inkborne-Setup");
    expect(LEGACY_SETUP_PREFIXES).toEqual(["FantaWriter-Setup", "Fantasy-Writer-Setup"]);
    const names = setupNamesForVersion("v2.1.10");
    expect(names.version).toBe("2.1.10");
    expect(names.primary).toBe("Inkborne-Setup-2.1.10.exe");
    expect(names.aliases).toEqual(["FantaWriter-Setup-2.1.10.exe", "Fantasy-Writer-Setup-2.1.10.exe"]);
    expect(names.legacy).toBe("FantaWriter-Setup-2.1.10.exe");
  });
});

describe("aliasLegacySetup", () => {
  it("copies primary Inkborne-Setup to both legacy names with matching sha256", () => {
    const distDir = mkdtempSync(join(tmpdir(), "fw-alias-"));
    temps.push(distDir);
    const primaryName = "Inkborne-Setup-2.1.10.exe";
    const payload = Buffer.from("inkborne-setup-fixture");
    writeFileSync(join(distDir, primaryName), payload);
    const sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    writeFileSync(join(distDir, `${primaryName}.sha256`), `${sha256}  ${primaryName}\n`);

    const result = aliasLegacySetup({ distDir, version: "2.1.10" });
    expect(result.sha256).toBe(sha256);
    expect(result.aliases).toHaveLength(2);

    for (const name of ["FantaWriter-Setup-2.1.10.exe", "Fantasy-Writer-Setup-2.1.10.exe"]) {
      const dest = join(distDir, name);
      expect(readFileSync(dest).equals(payload)).toBe(true);
      expect(hashFromSha256Sidecar(readFileSync(`${dest}.sha256`, "utf8"))).toBe(sha256);
      expect(readFileSync(`${dest}.sha256`, "utf8")).toMatch(new RegExp(`  ${name}\\n$`));
    }
  });

  it("throws when the Inkborne primary is missing", () => {
    const distDir = mkdtempSync(join(tmpdir(), "fw-alias-missing-"));
    temps.push(distDir);
    expect(() => aliasLegacySetup({ distDir, version: "2.1.10" })).toThrow(/找不到安装包/);
  });
});
