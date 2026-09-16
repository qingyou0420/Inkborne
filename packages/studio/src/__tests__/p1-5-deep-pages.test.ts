/**
 * P1-5 source contracts: 深页排版（落笔 / 研墨 / 织卷 / 章页 / 短篇 / 动态）.
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

describe("P1-5 落笔", () => {
  it("collapses row actions to 通过 + ⋯ and replaces native prompts", () => {
    const detail = read("src/pages/BookDetail.tsx");
    expect(detail).toMatch(/chapter-more-/);
    expect(detail).toMatch(/ConfirmDialog/);
    expect(detail).toMatch(/book\.rollbackChapter/);
    expect(detail).toMatch(/book\.syncTruth/);
    expect(detail).not.toMatch(/window\.prompt/);
    expect(detail).not.toMatch(/window\.confirm/);
    expect(detail).not.toMatch(/padStart\(2/);
    expect(detail).not.toMatch(/shadow-xl/);
    expect(detail).not.toMatch(/stagger-/);
    expect(detail).toMatch(/type="radio"/);
    expect(detail).toMatch(/book\.download/);
    expect(detail).toMatch(/formatStudyWords/);
    expect(detail).toMatch(/StageDot/);
  });

  it("pads the write empty state and hides the table header when there are no chapters", () => {
    const empty = read("src/components/LiteraryEmpty.tsx");
    expect(empty).toMatch(/className\?: string/);
    expect(empty).toMatch(/cn\(/);
    expect(empty).toMatch(/py-12/);
    const detail = read("src/pages/BookDetail.tsx");
    expect(detail).toMatch(/chapters\.length > 0 && \(/);
    expect(detail).toMatch(/className="px-6 py-14 sm:px-8"/);
    expect(detail).toMatch(/testId="write-empty"/);
  });

  it("keeps SerialCockpitStrip to one next-chapter line", () => {
    const strip = read("src/components/SerialCockpitStrip.tsx");
    expect(strip).toMatch(/serial-next-line/);
    expect(strip).toMatch(/下一章 · 第/);
    expect(strip).not.toMatch(/可以落墨/);
    expect(strip).toMatch(/去织卷/);
    expect(strip).not.toMatch(/rounded-2xl border border-border\/50 bg-secondary/);
  });
});

describe("P1-5 研墨 / 织卷 / 章页", () => {
  it("keeps adopted settings readable and explicitly edits separate ending / hooks", () => {
    const ground = read("src/pages/BookGround.tsx");
    expect(ground).toMatch(/ground-confirmed-stamp/);
    expect(ground).toMatch(/AuthoringGroundPanel/);
    expect(ground).not.toMatch(/研墨定稿/);
    expect(ground).not.toMatch(/foundation\/revise/);
    expect(ground).toMatch(/终局/);
    expect(ground).toMatch(/伏笔清单/);
    expect(ground).toMatch(/materialInput\("pending_hooks\.md"/);
    expect(ground).toMatch(/legacyEditing/);
    expect(ground).toMatch(/<ManuscriptView/);
    expect(ground).toMatch(/保存已采用资料/);
    expect(ground).toMatch(/onBeforeLegacyLeave=\{finishLegacy\}/);
    expect(ground).not.toMatch(/font-mono/);
    expect(ground).not.toMatch(/保存人物/);
    expect(ground).not.toMatch(/split\(\/\\n---\\n\/\)/);
  });

  it("keeps outline operations reachable in a menu and defaults its document to reading", () => {
    const weave = read("src/pages/OutlineWorkspace.tsx");
    expect(weave).not.toMatch(/outline-tree-more/);
    expect(weave).toMatch(/outline-add-chapter/);
    expect(weave).toMatch(/outline-tidy/);
    expect(weave).toMatch(/outline-filter/);
    expect(weave).toMatch(/outline-title-count/);
    expect(weave).toMatch(/\/ 12/);
    expect(weave).toMatch(/!editingSelected/);
    expect(weave).toMatch(/<ManuscriptView/);
    expect(weave).toMatch(/保存已采用卷纲/);
  });

  it("collapses chapter chrome to 编辑 / 通过 / ⋯ with gated override dialog", () => {
    const reader = read("src/pages/ChapterReader.tsx");
    expect(reader).toMatch(/chapter-more/);
    expect(reader).toMatch(/reader\.rollback/);
    expect(reader).toMatch(/reader\.packet/);
    expect(reader).toMatch(/reader\.stillApprove/);
    expect(reader).toMatch(/ConfirmDialog/);
    expect(reader).not.toMatch(/reader\.backToList/);
    expect(reader).not.toMatch(/带病通过原因/);
    expect(reader).not.toMatch(/critical/);
    expect(reader).not.toMatch(/shadow-2xl/);
    expect(reader).not.toMatch(/italic/);
    expect(reader).not.toMatch(/uppercase/);
  });
});

describe("P1-5 卡片 / 动态 / 短篇 / 清理", () => {
  it("maps truth filenames and folds diffs", () => {
    const card = read("src/components/TruthProposalCard.tsx");
    expect(card).toMatch(/mapTruthFileLabel/);
    expect(card).toMatch(/truth-diff-toggle/);
    expect(card).toMatch(/正典变更/);
    expect(card).toMatch(/写入/);
  });

  it("folds raw logs and uses literary daemon sentences", () => {
    const logs = read("src/pages/LogViewer.tsx");
    const daemon = read("src/pages/DaemonControl.tsx");
    expect(logs).toMatch(/logs-raw-toggle/);
    expect(logs).toMatch(/logs\.rawFold/);
    expect(logs).toMatch(/useI18n/);
    expect(logs).not.toMatch(/t\("nav\.connected"\) ===/);
    expect(daemon).toMatch(/formatActivityEvent/);
    expect(daemon).toMatch(/daemon\.schedulerIdle/);
    expect(daemon).not.toMatch(/font-mono/);
    expect(daemon).not.toMatch(/uppercase/);
  });

  it("gives shorts a 书房 + clickable 问心 strip", () => {
    const short = read("src/pages/ShortReader.tsx");
    expect(short).toMatch(/short-study-home/);
    expect(short).toMatch(/short-step-\$\{step\.id\}/);
    expect(short).toMatch(/openAsk/);
    expect(short).not.toMatch(/reader\.backToList/);
    expect(short).not.toMatch(/t\("nav\.connected"\) ===/);
  });

  it("drops global text-size overrides, isZh hacks on listed pages, and sidebar 16px items", () => {
    const css = read("src/index.css");
    expect(css).not.toMatch(/\.text-xs \{ font-size: 0\.8125rem/);
    expect(css).not.toMatch(/\.text-\[11px\] \{ font-size: 12px/);
    expect(read("src/pages/Dashboard.tsx")).toMatch(/useI18n/);
    expect(read("src/pages/Dashboard.tsx")).not.toMatch(/t\("nav\.connected"\) ===/);
    expect(read("src/components/Sidebar.tsx")).toMatch(/text-\[14px\] leading-5/);
    expect(read("src/components/Sidebar.tsx")).not.toMatch(/CreateItem[\s\S]*text-\[16px\]/);
  });
});
