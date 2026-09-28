/**
 * P0-5 source contract: 问心 is a full page, not a drawer.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(rel: string): string {
  return readFileSync(join(studioRoot, rel), "utf8");
}

describe("ask page layout", () => {
  it("renders BookAskPage on book-ask and deletes the talk drawer stack", () => {
    const app = read("src/App.tsx");
    expect(app).not.toMatch(/book-talk-drawer/);
    expect(app).not.toMatch(/bookChatOpen/);
    expect(app).not.toMatch(/onToggleChat/);
    expect(app).not.toMatch(/\bchatOpen\b/);
    expect(app).not.toMatch(/closeAskDrawer/);
    expect(app).not.toMatch(/BookAskDrawerChrome/);
    expect(app).not.toMatch(/toBookChat/);
    expect(app).toMatch(/page === "book-ask"/);
    expect(app).toMatch(/BookAskPage/);
  });

  it("keeps ChatPage + story rail and does not mount BookSidebar", () => {
    const page = read("src/pages/BookAskPage.tsx");
    expect(page).toMatch(/mode="book"/);
    expect(page).toMatch(/ChatPage/);
    expect(page).not.toMatch(/AskStoryRail/);
    expect(existsSync(join(studioRoot, "src/components/AskStoryRail.tsx"))).toBe(false);
    expect(page).not.toMatch(/BookWorkspaceNav/);
    expect(page).not.toMatch(/BookSidebar/);
  });

  it("lifts book chrome into the App top bar", () => {
    const app = read("src/App.tsx");
    const nav = read("src/components/BookWorkspaceNav.tsx");
    expect(app).toMatch(/BookWorkspaceNav/);
    expect(app).toMatch(/justify-between/);
    expect(app).toMatch(/deriveBookChromeTab/);
    expect(nav).not.toMatch(/onToggleChat/);
    expect(nav).not.toMatch(/talkOpen/);
    expect(nav).toMatch(/ink-book-nav/);
    expect(nav).toMatch(/book-stage-strip/);
    expect(nav).not.toMatch(/<StageTools/);
    expect(nav).toMatch(/nav\.toAsk\(bookId\)/);
  });

  it("renders a derived story card when ask is done but story_card.md is missing", () => {
    const rail = read("src/pages/BookGround.tsx") + read("src/components/AskStoryCard.tsx");
    const study = read("src/pages/BookStudy.tsx");
    const ground = read("src/pages/BookGround.tsx");
    const server = read("src/api/server.ts");
    expect(rail).toMatch(/\/books\/\$\{bookId\}\/story-card/);
    expect(ground).toMatch(/<AskStoryCard[\s\S]*?derivedFromCanon=\{!legacyEditing && cardData\?\.source === "derived"\}/);
    expect(ground).toMatch(/editable=\{legacyEditing\}/);
    expect(rail).toMatch(/ask-story-card/);
    expect(ground).toMatch(/\/books\/\$\{bookId\}\/story-card/);
    expect(study).not.toMatch(/truth\/story\/story_card/);
    expect(server).toMatch(/\/api\/v1\/books\/:id\/story-card/);
    expect(server).toMatch(/truth:written/);
  });

  it("makes 整理正典 → 采用并建书 the only book-create entry", () => {
    const app = read("src/App.tsx");
    const panel = read("src/components/AskCanonPanel.tsx");
    const prompt = read("../core/src/agent/agent-system-prompt.ts");
    expect(app).toMatch(/data-testid="book-create-ask"/);
    expect(app).toMatch(/AskCanonPanel/);
    expect(app).not.toMatch(/AskCreateRail/);
    expect(panel).toMatch(/采用并建书/);
    expect(panel).toMatch(/ask-adopt-create/);
    expect(panel).toMatch(/ask-length-confirm/);
    expect(panel).not.toMatch(/propose_action/);
    expect(prompt).toMatch(/采用并建书/);
    expect(prompt).not.toMatch(/默认 200\/3000/);
  });

  it("strips book-page breadcrumbs and sends sidebar sessions to /ask", () => {
    const study = read("src/pages/BookStudy.tsx");
    const ground = read("src/pages/BookGround.tsx");
    const weave = read("src/pages/OutlineWorkspace.tsx");
    const write = read("src/pages/BookDetail.tsx");
    const sidebar = read("src/components/Sidebar.tsx");
    expect(study).not.toMatch(/bread\.books/);
    expect(ground).not.toMatch(/bread\.books/);
    expect(weave).not.toMatch(/bread\.books/);
    expect(write).not.toMatch(/bread\.books/);
    expect(sidebar).not.toMatch(/toBookChat/);
    expect(sidebar).toMatch(/nav\.toAsk/);
  });
});
