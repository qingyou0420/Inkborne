/**
 * P1 information-architecture source contracts (H.2 / H.3 / H.6 / H.7).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lockedNamedVolumeCount, parseVolumeMapTree } from "../lib/volume-map-tree";
import { hasPreviousChapterUnapprovedReason, mapAuditSeverity } from "../lib/copy-map";
import { SIDEBAR_SECTION_ORDER } from "../lib/sidebar-create-items";

const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(rel: string): string {
  return readFileSync(join(studioRoot, rel), "utf8");
}

describe("P1-1 sidebar + author", () => {
  it("orders author chip → create → 问心记录, and sends the author chip home", () => {
    expect([...SIDEBAR_SECTION_ORDER]).toEqual(["author", "create", "sessions", "tools", "system"]);
    const sidebar = read("src/components/Sidebar.tsx");
    const home = read("src/pages/Dashboard.tsx");
    expect(sidebar).toMatch(/toDashboard/);
    expect(sidebar).toMatch(/sidebar-author/);
    expect(sidebar).toMatch(/toAuthor/);
    expect(sidebar).not.toMatch(/sidebar-works-list/);
    expect(sidebar).not.toMatch(/sidebar-all-shelf/);
    expect(sidebar).not.toMatch(/我的创作/);
    expect(sidebar.indexOf("sidebar-author")).toBeLessThan(sidebar.indexOf("sidebar-create-list"));
    expect(sidebar.indexOf("sidebar-create-list")).toBeLessThan(sidebar.indexOf("sidebar-sessions"));
    expect(sidebar).not.toMatch(/projectTalks|projectChatExpanded|SessionKindIcon/);
    expect(sidebar).not.toMatch(/新书与短篇/);
    expect(home).toMatch(/nav\.signYourName/);
    expect(home).toMatch(/isInProgressBookStatus/);
    expect(home).toMatch(/home-edit-author/);
    const author = read("src/pages/AuthorPage.tsx");
    expect(author).not.toMatch(/useApi.*\/books/);
    expect(author).not.toMatch(/author\.myBooks/);
  });

  it("persists author under explicit project root, not cwd", () => {
    const io = read("src/lib/author-io.ts");
    expect(io).toMatch(/\.inkos\/author\.json/);
    expect(io.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/process\.cwd/);
    const server = read("src/api/server.ts");
    expect(server).toMatch(/\/api\/v1\/author/);
    expect(server).toMatch(/\/api\/v1\/author\/avatar/);
  });
});

describe("P1-2 落笔", () => {
  it("declutters the write header and hides delete in the danger zone", () => {
    const write = read("src/pages/BookDetail.tsx");
    const settings = read("src/components/BookSettingsDrawer.tsx");
    const tools = read("src/components/BookToolsDrawer.tsx");
    expect(write).toMatch(/落笔/);
    expect(write).toMatch(/write-next-primary/);
    expect(write).toMatch(/book\.exportMenu/);
    expect(write).toMatch(/book\.draftOnly/);
    expect(write).not.toMatch(/规划下一章/);
    expect(write).not.toMatch(/删除书籍/);
    expect(write).not.toMatch(/\[critical\]/);
    expect(settings).toMatch(/book-danger-zone/);
    expect(settings).toMatch(/typeTitleToDelete/);
    expect(tools).toMatch(/book\.evaluate/);
    expect(tools).toMatch(/book\.consolidate/);
    expect(tools).toMatch(/book\.composeNext/);
    expect(tools).toMatch(/book\.analytics/);
  });

  it("maps audit tokens and gates skip to previous-chapter unapproved", () => {
    expect(mapAuditSeverity("critical", true)).toBe("须处理");
    expect(hasPreviousChapterUnapprovedReason([{ code: "missing_outline" }])).toBe(false);
    expect(hasPreviousChapterUnapprovedReason([{ code: "previous_chapter_not_approved" }])).toBe(true);
    const write = read("src/pages/BookDetail.tsx");
    expect(write).toMatch(/hasPreviousChapterUnapprovedReason/);
    expect(write).toMatch(/showSkip/);
  });
});

describe("P1-3 织卷", () => {
  it("keeps a single weave CTA and sends chapters to 落笔", () => {
    const weave = read("src/pages/OutlineWorkspace.tsx") + read("src/components/AuthoringWeavePanel.tsx");
    expect(weave).toMatch(/outline-weave/);
    expect(weave).toMatch(/outline-go-write/);
    expect(weave).toMatch(/去落笔/);
    expect(weave).not.toMatch(/outline-write-this/);
    expect(weave).not.toMatch(/落墨 · 写这一章/);
    expect(weave).toMatch(/仅粗纲/);
    expect(weave).toMatch(/待细化/);
    expect(weave).toMatch(/已细化/);
    expect(weave).toMatch(/整理卷纲/);
    expect(weave).toMatch(/outline-volume-detail/);
    expect(weave).toMatch(/outline-ungrounded/);
    expect(weave).not.toMatch(/\/books\/\$\{bookId\}\/outline\/weave/);
    expect((weave.match(/data-testid="outline-weave"/g) ?? []).length).toBe(1);
  });

  it("parses a messy 醉词-style map as 7 locked volumes, not 19", () => {
    const messy = [
      "## 第1卷 书院（1-38章）",
      "本卷要抵达：相识。",
      "## 第一卷分章事件清单（可在其上补合细纲）",
      "## 第一卷·节点A",
      "## 第 1 章 倒叙冷开",
      "## 第 4–13 章（粗纲）",
      "## 第二卷:以\"德者掌兵\"开局压阵",
      "## 第2卷 焚院（39-72章）",
      "## 第3卷 白羽（73-117章）",
      "## 第4卷 商陆（118-157章）",
      "## 第5卷 醉生（158-192章）",
      "## 第6卷 江山（193-227章）",
      "## 第7卷 清溪（228-260章）",
    ].join("\n");
    const tree = parseVolumeMapTree(messy);
    expect(tree.volumeCount).toBe(7);
    expect(lockedNamedVolumeCount(tree)).toBe(7);
    expect(tree.volumes[0]?.notes.some((note) => note.title.includes("节点A"))).toBe(true);
    expect(tree.volumes[0]?.chapters.some((node) => node.kind === "range")).toBe(true);
  });
});

describe("P1-4 书房", () => {
  it("uses 今日一笔 / 本卷要抵达 / 等你过目 and drops the old bottom buttons", () => {
    const study = read("src/pages/BookStudy.tsx");
    expect(study).toMatch(/serial-cockpit-home/);
    expect(study).toMatch(/study\.today/);
    expect(study).toMatch(/本卷要抵达/);
    expect(study).toMatch(/等你过目/);
    expect(study).toMatch(/四步一览/);
    expect(study).toMatch(/study-step-ask/);
    expect(study).toMatch(/grid-cols-\[8px_/);
    expect(study).not.toMatch(/待定 \$\{openCount\}/);
    expect(study).not.toMatch(/「\{oneLine\}」/);
    expect(study).toMatch(/fourStepCopy/);
    expect(study).toMatch(/hasPreviousChapterUnapprovedReason/);
    expect(study).not.toMatch(/打开大纲/);
    expect(study).not.toMatch(/带病续写/);
    expect(study).not.toMatch(/toOutline\(bookId\).*织卷/);
  });
});
