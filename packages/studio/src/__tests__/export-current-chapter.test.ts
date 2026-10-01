/**
 * Write-page export: current chapter entry, and range fields that commit on blur or Enter.
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

  it("commits chapter numbers on blur or Enter and does not rewrite them while typing", () => {
    const fields = read("src/components/FanqieExportFields.tsx");
    expect(fields).not.toMatch(/type="number"/);
    expect(fields).toMatch(/type="text"/);
    expect(fields).toMatch(/inputMode="numeric"/);
    expect(fields).toMatch(/onChange=\{\(event\) => onChange\(\{ from: event\.target\.value \}\)\}/);
    expect(fields).toMatch(/onBlur=\{\(event\) => onCommit\?\.?\(\{ from: event\.target\.value \}\)\}/);
    expect(fields).toMatch(/onChange=\{\(event\) => onChange\(\{ to: event\.target\.value \}\)\}/);
    expect(fields).toMatch(/onBlur=\{\(event\) => onCommit\?\.?\(\{ to: event\.target\.value \}\)\}/);
    const fromInput = fields.slice(fields.indexOf('data-testid="fanqie-from"') - 700, fields.indexOf('data-testid="fanqie-from"'));
    const toInput = fields.slice(fields.indexOf('data-testid="fanqie-to"') - 700, fields.indexOf('data-testid="fanqie-to"'));
    expect(fromInput).toMatch(/type="text"/);
    expect(fromInput).toMatch(/inputMode="numeric"/);
    expect(fromInput).not.toMatch(/normalizeRange/);
    expect(fromInput).not.toMatch(/stepRangeField/);
    expect(toInput).not.toMatch(/normalizeRange/);
    expect(fields).toMatch(/event\.key === "Enter"/);
    expect(fields).toMatch(/onCommit\?\.?\(\{ \[field\]: event\.currentTarget\.value \}\)/);
    expect(fields).toMatch(/event\.key === "ArrowUp"/);
    expect(fields).toMatch(/event\.key === "ArrowDown"/);
    expect(fields).toMatch(/stepRangeField/);
    expect(fields).toMatch(/preventDefault\(\)/);
    expect(fields).toMatch(/stopPropagation\(\)/);
    expect(fields).toMatch(/export\.rangeSwapped/);
    expect(fields).toMatch(/type="button"/);
    expect(read("src/pages/ShortReader.tsx")).toMatch(/maxChapterNumber\(shape\.chapters\)/);
    expect(read("src/pages/ShortReader.tsx")).not.toMatch(/const chapterCount = shape\.chapters\.length/);
    expect(read("src/components/ExportMenu.tsx")).toMatch(/onCommit=\{commitRange\}/);
    expect(read("src/components/ExportMenu.tsx")).toMatch(/fanqieRangeProblem\(settled\.from, settled\.to, chapterCount, isZh\)/);
  });

  it("downloads the current chapter with fetch and reports a failed response", () => {
    const menu = read("src/components/ExportMenu.tsx");
    const download = menu.slice(menu.indexOf("const downloadCurrent"), menu.indexOf("return ("));
    expect(download).toMatch(/buildApiUrl\(currentHref\)/);
    expect(download).toMatch(/fetch\(/);
    expect(download).toMatch(/if \(!res\.ok\)/);
    expect(download).toMatch(/onError\(/);
    expect(download).toMatch(/filenameFromContentDisposition/);
    expect(download).not.toMatch(/onSaved\(/);
    expect(menu).toMatch(/payload\.error/);
    expect(menu).not.toMatch(/href=\{currentHref\}/);
    const marker = 'data-testid="export-current-chapter-download"';
    const around = menu.slice(menu.indexOf(marker) - 400, menu.indexOf(marker) + 80);
    expect(around).toMatch(/type="button"/);
    expect(around).toMatch(/btn-secondary/);
    expect(around).toMatch(/disabled=\{!currentChapterReady \|\| downloadingChapter\}/);
    expect(around).not.toMatch(/<a\b/);
    expect(menu).toMatch(/data-testid="book-export-manuscript"/);
    expect(menu).toMatch(/download/);
  });
});
