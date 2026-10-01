import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  SETUP_RE,
  CURRENT_SETUP_PREFIX,
  versionFromSetupName,
  setupFileNameForVersion,
  preferSetupRank,
} = require("../lib/setup-artifact.cjs") as {
  SETUP_RE: RegExp;
  CURRENT_SETUP_PREFIX: string;
  versionFromSetupName: (name: string) => string | null;
  setupFileNameForVersion: (version: string) => string;
  preferSetupRank: (name: string) => number;
};

describe("versionFromSetupName (group 1 = semver)", () => {
  it("parses Inkborne-Setup-3.0.0.exe as 3.0.0", () => {
    const m = "Inkborne-Setup-3.0.0.exe".match(SETUP_RE);
    expect(m?.[1]).toBe("3.0.0");
    expect(versionFromSetupName("Inkborne-Setup-3.0.0.exe")).toBe("3.0.0");
  });

  it("parses FantaWriter-Setup-1.4.1.exe as 1.4.1", () => {
    const m = "FantaWriter-Setup-1.4.1.exe".match(SETUP_RE);
    expect(m?.[1]).toBe("1.4.1");
    expect(versionFromSetupName("FantaWriter-Setup-1.4.1.exe")).toBe("1.4.1");
  });

  it("parses already-shipped Fantasy-Writer-Setup-1.4.0.exe as 1.4.0", () => {
    const m = "Fantasy-Writer-Setup-1.4.0.exe".match(SETUP_RE);
    expect(m?.[1]).toBe("1.4.0");
    expect(versionFromSetupName("Fantasy-Writer-Setup-1.4.0.exe")).toBe("1.4.0");
  });

  it("parses Fantasy-Writer-Setup-1.0.0.exe as 1.0.0", () => {
    const m = "Fantasy-Writer-Setup-1.0.0.exe".match(SETUP_RE);
    expect(m?.[1]).toBe("1.0.0");
    expect(versionFromSetupName("Fantasy-Writer-Setup-1.0.0.exe")).toBe("1.0.0");
  });

  it("parses pre-release suffix on all prefixes", () => {
    expect(versionFromSetupName("Inkborne-Setup-3.0.0-beta.1.exe")).toBe("3.0.0-beta.1");
    expect(versionFromSetupName("FantaWriter-Setup-1.5.0-beta.1.exe")).toBe("1.5.0-beta.1");
    expect(versionFromSetupName("Fantasy-Writer-Setup-1.5.0-beta.1.exe")).toBe("1.5.0-beta.1");
  });

  it("rejects spaced Fantasy Writer-Setup filename", () => {
    expect(versionFromSetupName("Fantasy Writer-Setup-2.0.0.exe")).toBeNull();
  });

  it("rejects unrelated installer names", () => {
    expect(versionFromSetupName("Other-Setup-1.0.0.exe")).toBeNull();
    expect(versionFromSetupName("Fanta-Writer-Setup-1.0.0.exe")).toBeNull();
    expect(versionFromSetupName("FantasyWriter-Setup-1.0.0.exe")).toBeNull();
  });
});

describe("current installer filename", () => {
  it("builds Inkborne-Setup-${version}.exe", () => {
    expect(CURRENT_SETUP_PREFIX).toBe("Inkborne-Setup");
    expect(setupFileNameForVersion("3.0.0")).toBe("Inkborne-Setup-3.0.0.exe");
    expect(setupFileNameForVersion("v3.0.0")).toBe("Inkborne-Setup-3.0.0.exe");
    expect(versionFromSetupName(setupFileNameForVersion("3.0.0"))).toBe("3.0.0");
  });

  it("ranks Inkborne ahead of FantaWriter and the shipped 1.4.0 name", () => {
    expect(preferSetupRank("Inkborne-Setup-3.0.0.exe")).toBeLessThan(
      preferSetupRank("FantaWriter-Setup-3.0.0.exe")
    );
    expect(preferSetupRank("FantaWriter-Setup-1.4.1.exe")).toBeLessThan(
      preferSetupRank("Fantasy-Writer-Setup-1.4.0.exe")
    );
  });
});
