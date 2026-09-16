/**
 * P0-6 copy: one meaning per status word, ask chips, home menu labels.
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

describe("P0-6 copy", () => {
  it("unifies status words and drops leftover keys", () => {
    const i18n = read("src/hooks/use-i18n.ts");
    expect(i18n).toMatch(/"chapter\.readyForReview": \{ zh: "待审稿"/);
    expect(i18n).toMatch(/"chapter\.auditFailed": \{ zh: "须处理"/);
    expect(i18n).toMatch(/"book\.statusCompleted": \{ zh: "完结"/);
    expect(i18n).toMatch(/"daemon\.title": \{ zh: "守护进程"/);
    expect(i18n).toMatch(/"nav\.createNovel": \{ zh: "长篇"/);
    expect(i18n).toMatch(/"nav\.createShort": \{ zh: "短篇"/);
    expect(i18n).not.toMatch(/logs\.showingRecent/);
    expect(i18n).not.toMatch(/待审核/);
    expect(i18n).not.toMatch(/审计失败/);
  });

  it("keeps book-mode ask chips to 重新推敲前提 only", () => {
    const chat = read("src/pages/ChatPage.tsx");
    expect(chat).toMatch(/mode !== "book"/);
    expect(chat).toMatch(/说说那个让你想动笔的念头/);
    expect(chat).toMatch(/重新推敲前提/);
  });

  it("uses one cover continuation entry without a second write button", () => {
    const dashboard = read("src/pages/Dashboard.tsx");
    expect(dashboard).toMatch(/goBookStage\(nav, book.id, stage\)/);
    expect(dashboard).toMatch(/bookResumeStage/);
    expect(dashboard).not.toMatch(/home\.toWrite/);
    expect(dashboard).not.toMatch(/t\("book\.settings"\)/);
  });
});
