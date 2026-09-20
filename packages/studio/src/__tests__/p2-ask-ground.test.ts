/**
 * P2 source contracts: 问心 / 研墨 / 视觉 / 短篇 / 安装包双模式（H.4 H.5 H.8 H.9 / F.3）.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(studioRoot, "..", "..");

function read(rel: string): string {
  return readFileSync(join(studioRoot, rel), "utf8");
}

describe("P2-1 问心", () => {
  it("writes story_card.md and gates 就此建书 on three fields", () => {
    const card = read("src/lib/story-card.ts");
    const ask = read("src/components/AskStoryCard.tsx") + read("src/pages/ChatPage.tsx");
    const rail = read("src/components/AskCreateRail.tsx") + read("src/components/AskStoryCard.tsx");
    const sidebar = read("src/components/Sidebar.tsx");
    const nav = read("src/components/BookWorkspaceNav.tsx");
    expect(card).toMatch(/story_card\.md/);
    expect(card).toMatch(/workingTitle/);
    expect(card).toMatch(/oneLine/);
    expect(card).toMatch(/synopsis/);
    expect(rail).toMatch(/create-book-from-card/);
    expect(rail).toMatch(/requestedIntent: "create_book"/);
    expect(ask).toMatch(/reopen-ask/);
    expect(ask).toMatch(/REOPEN_ASK_PROMPT/);
    expect(ask).not.toMatch(/wipe|rm\(.*story/);
    expect(nav).not.toMatch(/book-tab-talk/);
    expect(sidebar).toMatch(/toBookCreate/);
    expect(sidebar).toMatch(/startFreshBookCreateSession/);
  });

  it("does not render genre template chips above the ask composer", () => {
    const chat = read("src/pages/ChatPage.tsx");
    const rail = read("src/components/AskCreateRail.tsx");
    expect(chat).not.toMatch(/AskGenreChips/);
    expect(rail).not.toMatch(/AskGenreChips/);
    expect(chat + rail).not.toMatch(/ask-genre-chips/);
    expect(chat).toMatch(/reopen-ask/);
  });
});

describe("P2-2 研墨", () => {
  it("maps five zones and confirms through groundConfirmedAt + TruthProposal", () => {
    const ground = read("src/pages/BookGround.tsx");
    const server = read("src/api/server.ts");
    expect(ground).toMatch(/世界规则/);
    expect(ground).toMatch(/人物/);
    expect(ground).toMatch(/关系与主线/);
    expect(ground).toMatch(/结局与伏笔/);
    expect(ground).toMatch(/待定项/);
    expect(ground).toMatch(/基础设定/);
    expect(ground).toMatch(/故事概要/);
    expect(read("src/components/AuthoringGroundPanel.tsx")).toMatch(/showLegacy/);
    expect(read("src/components/AuthoringGroundPanel.tsx")).toMatch(/authoringBook === false/);
    expect(ground).toMatch(/legacySections=/);
    expect(ground).toMatch(/AuthoringGroundPanel/);
    expect(ground).toMatch(/\/books\/\$\{bookId\}\/story-card/);
    expect(ground).not.toMatch(/ground-nav/);
    expect(ground).not.toMatch(/ground-confirm-bar/);
    expect(ground).not.toMatch(/foundation\/revise/);
    expect(ground).toMatch(/open_questions\.md/);
    expect(ground).toMatch(/TruthProposalCard/);
    expect(ground).toMatch(/GROUND_REEDIT_WARNING/);
    expect(server).toMatch(/\/api\/v1\/books\/:id\/ground\/confirm/);
    expect(server).toMatch(/app\.put\("\/api\/v1\/books\/:id\/story-card"/);
    expect(server).toMatch(/groundConfirmedAt/);
    expect(server).toMatch(/story_card\.md/);
    expect(server).toMatch(/open_questions\.md/);
  });
});

describe("P2-3 visual", () => {
  it("uses local ONE reading tokens and no Google Fonts CDN", () => {
    const css = read("src/index.css");
    expect(css).not.toMatch(/fonts\.googleapis\.com/);
    expect(css).toMatch(/noto-sans-sc\.ttf/);
    expect(css).toMatch(/lxgw-wenkai-subset\.woff2/);
    expect(css).toMatch(/instrument-serif-regular\.woff2/);
    expect(css).toMatch(/--background: #ffffff/);
    expect(css).toMatch(/--seal: #386254/);
    expect(css).not.toMatch(/oklch\(0\.36 0\.07 160\)/);
    expect(css).not.toMatch(/oklch\(0\.70 0\.09 82\)/);
    expect(existsSync(join(studioRoot, "public/paper-grain.svg"))).toBe(true);
    expect(existsSync(join(studioRoot, "public/fonts/lxgw-wenkai-subset.woff2"))).toBe(true);
    expect(existsSync(join(studioRoot, "public/fonts/noto-sans-sc.ttf"))).toBe(true);
    expect(readFileSync(join(studioRoot, "public/paper-grain.svg")).byteLength).toBeLessThan(3072);
    const src = [
      read("src/pages/Dashboard.tsx"),
      read("src/pages/BookDetail.tsx"),
      read("src/pages/ChatPage.tsx"),
      read("src/pages/TruthFiles.tsx"),
      read("src/components/TruthProposalCard.tsx"),
    ].join("\n");
    expect(src).not.toMatch(/hover:scale-105/);
    expect(src).not.toMatch(/uppercase tracking-widest/);
    expect(src).not.toMatch(/\balert\(/);
    const p06 = [
      read("src/components/BookWorkspaceNav.tsx"),
      read("src/pages/BookGround.tsx"),
      read("src/pages/OutlineWorkspace.tsx"),
      read("src/components/Sidebar.tsx"),
      read("src/pages/ChapterReader.tsx"),
      read("src/pages/LogViewer.tsx"),
      read("src/pages/DaemonControl.tsx"),
      read("src/pages/ServiceListPage.tsx"),
      read("src/pages/ProjectSettings.tsx"),
      read("src/components/ConfirmDialog.tsx"),
      read("src/components/SerialCockpitStrip.tsx"),
      read("src/hooks/use-colors.ts"),
    ].join("\n");
    expect(p06).not.toMatch(/(emerald|amber|blue|rose)-[0-9]{3}/);
    expect(p06).not.toMatch(/oklch\(/);
    expect(p06).not.toMatch(/\buppercase\b/);
    expect(p06 + "\n" + read("src/pages/BookDetail.tsx")).not.toMatch(/window\.prompt/);
  });
});

describe("P2-4 short study", () => {
  it("shows 创作书房, three steps, and a danger-zone delete", () => {
    const short = read("src/pages/ShortReader.tsx");
    const settings = read("src/pages/ShortSettings.tsx");
    expect(short).toMatch(/创作书房/);
    expect(short).toMatch(/short-stage-strip/);
    expect(short).toMatch(/short-study-home/);
    expect(short).toMatch(/short-primary-cta/);
    expect(short).not.toMatch(/reader\.backToList/);
    expect(short).not.toMatch(/short-danger-zone/);
    expect(short).toMatch(/toShortSettings/);
    expect(short).toMatch(/toShortAnalytics/);
    expect(settings).toMatch(/short-danger-zone/);
  });
});
