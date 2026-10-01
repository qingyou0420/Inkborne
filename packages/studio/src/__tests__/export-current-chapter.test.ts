/**
 * Write-page export: current chapter entry, and range fields that commit on blur.
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

describe("export current chapter menu", () => {
  it("offers 导出本章 on the write page and disables it when the chapter has no text", () => {
    const menu = read("src/components/ExportMenu.tsx");
    const panel = read("src/components/AuthoringWritePanel.tsx");
    expect(menu).toMatch(/book\.exportCurrentChapter"/);
    expect(menu).toMatch(/book\.exportCurrentChapterDisabled/);
    expect(menu).toMatch(/data-testid="export-current-chapter"/);
    expect(menu).toMatch(/disabled=\{!currentChapterReady\}/);
    expect(menu).toMatch(/export-current-chapter-hint/);
    expect(menu).toMatch(/chapter: currentChapter\.number/);
    expect(panel).toMatch(/currentChapter=\{\{ number: chapterNumber, title: chapterTitle \}\}/);
    expect(panel).toMatch(/currentChapterReady=/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/currentChapterReady=\{persistedByNumber\.has\(activeChapter\)\}/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/chapterCount=\{chapterCount\}/);
  });

  it("commits chapter numbers on blur and does not clamp them while typing", () => {
    const fields = read("src/components/FanqieExportFields.tsx");
    const fromInput = fields.slice(fields.indexOf('data-testid="fanqie-from"') - 900, fields.indexOf('data-testid="fanqie-from"'));
    const toInput = fields.slice(fields.indexOf('data-testid="fanqie-to"') - 700, fields.indexOf('data-testid="fanqie-to"'));
    expect(fromInput).toMatch(/type="number"/);
    expect(fromInput).toMatch(/min=\{1\}/);
    expect(fromInput).toMatch(/step=\{1\}/);
    expect(fromInput).toMatch(/onChange=\{\(event\) => onChange\(\{ from: event\.target\.value \}\)\}/);
    expect(fromInput).toMatch(/onBlur=\{\(event\) => onCommit\?.\(\{ from: event\.target\.value \}\)\}/);
    expect(fromInput).not.toMatch(/normalizeRange/);
    expect(toInput).toMatch(/onChange=\{\(event\) => onChange\(\{ to: event\.target\.value \}\)\}/);
    expect(toInput).toMatch(/onBlur=\{\(event\) => onCommit\?.\(\{ to: event\.target\.value \}\)\}/);
    expect(toInput).not.toMatch(/normalizeRange/);
    expect(fields).toMatch(/export\.rangeSwapped/);
    expect(read("src/components/ExportMenu.tsx")).toMatch(/onCommit=\{commitRange\}/);
    expect(read("src/components/ExportMenu.tsx")).toMatch(/fanqieRangeProblem\(settled\.from, settled\.to, chapterCount, isZh\)/);
  });
});
