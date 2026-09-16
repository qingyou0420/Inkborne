/**
 * StageDot contract: currentColor-driven dots; page highlight vs stage progress.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(rel: string): string {
  return readFileSync(join(studioRoot, rel), "utf8");
}

describe("StageDot", () => {
  it("replaces stepDotClass in nav and uses currentColor CSS", () => {
    const nav = read("src/components/BookWorkspaceNav.tsx");
    const css = read("src/index.css");
    const navCss = read("src/ink-home.css");
    expect(nav).not.toMatch(/stepDotClass/);
    expect(nav).not.toMatch(/oklch\(/);
    expect(nav).toMatch(/StageDot/);
    expect(nav).toMatch(/aria-current=\{current === step\.id \? "page" : undefined\}/);
    expect(navCss).toMatch(/\.ink-stage-link\[aria-current="page"\]\s*\{\s*color:\s*var\(--foreground\)/);
    expect(navCss).toMatch(/\.ink-stage-link\[aria-current="page"\]::after\s*\{[^}]*background:currentColor/);
    expect(css).toMatch(/\.stage-dot\[data-state="done"\]\s*\{\s*background:\s*currentColor/);
    expect(css).toMatch(/--dot-core, var\(--seal\)/);
  });

  it("renders shared progress marks where needed and text states for ground manuscripts", () => {
    const study = read("src/pages/BookStudy.tsx");
    const ground = read("src/pages/BookGround.tsx");
    const weave = read("src/pages/OutlineWorkspace.tsx");
    const short = read("src/pages/ShortReader.tsx");
    for (const src of [study, weave, short]) {
      expect(src).toMatch(/<StageDot\s+state=/);
    }
    expect(ground).toMatch(/confirmed && \([\s\S]*?data-testid="ground-confirmed-stamp"[\s\S]*?已定稿/);
    expect(ground).toMatch(/className="version-state"[\s\S]*?已采用资料/);
    expect(ground).toMatch(/materialKeys\(\)\.some\([\s\S]*?materialDrafts\.has\(key\)\)[\s\S]*?未保存修改/);
    expect(study).not.toMatch(/"✓"/);
    expect(study).not.toMatch(/"●"/);
    expect(study).not.toMatch(/"○"/);
    expect(ground).not.toMatch(/"✓"/);
    expect(weave).not.toMatch(/"●"/);
    expect(weave).not.toMatch(/"○"/);
  });
});
