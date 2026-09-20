/**
 * P0-A glossary: forbidden product words stay out of non-legacy surfaces.
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

const glossaryFiles = [
  "src/hooks/use-i18n.ts",
  "src/lib/stage-copy.ts",
  "src/components/StudioHeader.tsx",
  "src/pages/ServiceListPage.tsx",
  "src/pages/OutlineWorkspace.tsx",
  "src/components/AuthoringWeavePanel.tsx",
  "src/pages/BookGround.tsx",
  "src/pages/BookStudy.tsx",
  "src/pages/ShortReader.tsx",
] as const;

describe("P0-A ink copy glossary", () => {
  it("drops banned words from the listed non-legacy surfaces", () => {
    const src = glossaryFiles.map((file) => read(file)).join("\n");
    expect(src).not.toMatch(/连载书房/);
    expect(src).not.toMatch(/创作书房/);
    expect(src).not.toMatch(/返回书房/);
    expect(src).not.toMatch(/全书大纲/);
    expect(src).not.toMatch(/全书规划/);
    expect(src).not.toMatch(/已采用资料/);
    expect(src).not.toMatch(/真相文件/);
    expect(src).not.toMatch(/落墨/);
    expect(src).not.toMatch(/项目设置/);
  });

  it("uses the unified titles for 配置 / 本书规划 / 原始资料", () => {
    const i18n = read("src/hooks/use-i18n.ts");
    expect(i18n).toMatch(/"settings\.title": \{ zh: "配置"/);
    expect(i18n).toMatch(/"weave\.bookOutline": \{ zh: "本书规划"/);
    expect(i18n).toMatch(/"truth\.title": \{ zh: "原始资料"/);
    expect(i18n).toMatch(/"cockpit\.writeNext": \{ zh: "写下一章（旧管线）", en: "Write next \(legacy\)"/);
    expect(i18n).toMatch(/"cockpit\.weave": \{ zh: "织卷", en: "Weave"/);
    expect(read("src/components/StudioHeader.tsx")).toMatch(/回到书架/);
    expect(read("src/pages/ServiceListPage.tsx")).toMatch(/t\("settings\.title"\)/);
  });
});
