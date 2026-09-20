/**
 * P0 B/E source contracts: chrome close, radius tokens, read-only legacy pages.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(rel: string): string {
  return readFileSync(join(studioRoot, rel), "utf8");
}

function walkSrc(dir = join(studioRoot, "src")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkSrc(full));
    else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("P0-E radius tokens", () => {
  it("pulls xl back to the 5px control radius and adds 2xl", () => {
    const theme = read("src/index.css");
    expect(theme).toMatch(/--radius-xl:\s*var\(--radius\)/);
    expect(theme).toMatch(/--radius-2xl:\s*calc\(var\(--radius\) \+ 1px\)/);
    expect(read("src/ink-design.css")).toMatch(/\.ink-notice/);
  });

  it("has no hardcoded 10px rounds and no rounded-2xl banners in the five pages", () => {
    for (const file of walkSrc()) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/rounded-\[10px\]/);
    }
    for (const file of [
      "src/App.tsx",
      "src/pages/BookDetail.tsx",
      "src/pages/BookStudy.tsx",
      "src/pages/OutlineWorkspace.tsx",
      "src/pages/ProjectSettings.tsx",
    ]) {
      expect(read(file), file).not.toMatch(/rounded-2xl/);
    }
  });
});

describe("P0-B authoring chrome close", () => {
  it("hides 作品工具 for four-stage books and keeps the drawer for legacy", () => {
    const menu = read("src/components/AppMoreMenu.tsx");
    expect(menu).toMatch(/authoring\/workspace/);
    expect(menu).toMatch(/showWorkTools/);
    expect(menu).toMatch(/authoring\?\.authoringBook === false/);
    expect(menu).toMatch(/showWorkTools && currentBookId/);
    expect(menu).toMatch(/BookToolsDrawer/);
    expect(menu).not.toMatch(/dash\.stats/);
    expect(menu).not.toMatch(/导出正文/);
    expect(menu).toMatch(/原始资料/);
  });

  it("gives ChapterReader and TruthFiles a readOnly branch", () => {
    const reader = read("src/pages/ChapterReader.tsx");
    const truth = read("src/pages/TruthFiles.tsx");
    expect(reader).toMatch(/const readOnly = authoring\?\.authoringBook === true/);
    expect(reader).toMatch(/chapter-reader-readonly/);
    expect(reader).toMatch(/readOnly \? null/);
    expect(truth).toMatch(/pageReadOnly/);
    expect(truth).toMatch(/canEdit && !pageReadOnly|canEdit = presentation\.canEdit && !pageReadOnly/);
    expect(truth).toMatch(/原始资料（只读）/);
  });

  it("does not steal stage highlight for truth or chapter routes", () => {
    const app = read("src/App.tsx");
    expect(app).toMatch(/case "truth":\s*case "chapter":\s*return "study"/);
    expect(app).not.toMatch(/case "truth":\s*return "ground"/);
  });
});
