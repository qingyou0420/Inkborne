/**
 * Four-agent authoring IA: eight roles, ask canon rail, API surface.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseVolumeMapTree } from "@actalk/inkos-core/volume-map-tree";
import {
  buildChapterGroups,
  defaultOpenGroupId,
  filterChapterGroups,
} from "../lib/chapter-table";
import { chapterEditRequest, trackChapterEdit } from "../lib/pending-chapter-edit";
import { workspaceQuery } from "../lib/authoring-workspace";
import { isWriteNextRequest } from "../lib/write-next-request";

const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(rel: string): string {
  return readFileSync(join(studioRoot, rel), "utf8");
}

describe("authoring four-agent IA", () => {
  it("registers authoring routes and eight-role settings", () => {
    const server = read("src/api/server.ts");
    const routes = read("src/api/authoring-routes.ts");
    const settings = read("src/pages/ProjectSettings.tsx");
    expect(server).toMatch(/registerAuthoringRoutes/);
    expect(server).toMatch(/authoringRoles: fillMissingAuthoringRoles/);
    expect(server).toMatch(/isLightweightAuthoringBook/);
    expect(routes).toMatch(/\/api\/v1\/authoring\/roles/);
    expect(routes).toMatch(/\/api\/v1\/authoring\/ask\/adopt/);
    expect(routes).toMatch(/\/api\/v1\/authoring\/weave\/generate/);
    expect(routes).toMatch(/\/api\/v1\/authoring\/write\/revise/);
    expect(routes).toMatch(/\/api\/v1\/authoring\/drafts\/ensure/);
    expect(routes).toMatch(/\/api\/v1\/authoring\/roles\/:roleId\/test/);
    expect(routes).toMatch(/saveHandEditedArtifact/);
    expect(settings).toMatch(/AuthoringRolesPanel/);
  });

  it("keeps 问心 chat from writing the project default model", () => {
    const chat = read("src/pages/ChatPage.tsx");
    expect(chat).toMatch(/mode === "book" \|\| mode === "book-create"/);
    expect(chat).toMatch(/\/authoring\/roles\/ask\.main/);
    expect(chat).toMatch(/ask\.main/);
  });

  it("shows a canon panel on 问心 without replacing ChatPage", () => {
    const page = read("src/pages/BookAskPage.tsx");
    expect(page).toMatch(/AskCanonPanel/);
    expect(page).toMatch(/ChatPage/);
    expect(page).toMatch(/mode="book"/);
  });

  it("wires 研墨 / 织卷 / 落笔 / 书房 to authoring panels", () => {
    expect(read("src/pages/BookGround.tsx")).toMatch(/AuthoringGroundPanel/);
    expect(read("src/pages/OutlineWorkspace.tsx")).toMatch(/AuthoringWeavePanel/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/AuthoringWritePanel/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/setWriteChapter/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/write-candidate-body/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/loading && !data/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/parentArtifactId/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/baseBody/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/parentArtifactId/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/基于当前手改改写/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/另起一稿/);
    expect(read("src/lib/unsaved-edits.ts")).toMatch(/__inkborneHasUnsavedEdits/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/\/authoring\/write\/hand/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/\/authoring\/write\/select/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/key=\{`\$\{bookId\}:\$\{writeChapter \?\? data\.nextChapter\}`\}/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/resolveAdoptArtifactId/);
    expect(read("src/components/AskCanonPanel.tsx")).toMatch(/persistIfDirty/);
    expect(read("src/components/AuthoringGroundPanel.tsx")).toMatch(/persistIfDirty/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).toMatch(/persistIfDirty/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).toMatch(/outline-weave-pause/);
    expect(read("src/components/AskCanonPanel.tsx")).toMatch(/ask-candidate-body/);
    expect(read("src/components/AuthoringRolesPanel.tsx")).toMatch(/测试此配置/);
    expect(read("src/components/AuthoringRolesPanel.tsx")).toMatch(/继承连接/);
    expect(read("src/components/AuthoringRolesPanel.tsx")).toMatch(/apiFormat: draft\.apiFormat[\s\S]*null/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/inheritProtocol/);
    expect(read("src/pages/BookStudy.tsx")).toMatch(/authoring\/workspace/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/\/api\/v1\/authoring\/ground\/revise/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/\/api\/v1\/authoring\/weave\/revise/);
  });

  it("sends a chapter hand edit to the chapter that was open when it was typed", () => {
    const pending = trackChapterEdit("zui-ci", 12, "新的一段", "旧的一段");
    const viewChapter = 13;
    expect(pending).not.toBeNull();
    const request = chapterEditRequest(pending!);
    expect(request.chapterNumber).toBe(12);
    expect(request.chapterNumber).not.toBe(viewChapter);
    expect(request.content).toBe("新的一段");
    expect(request.autosave).toBe(true);
    expect(trackChapterEdit("zui-ci", 12, "旧的一段", "旧的一段")).toBeNull();
  });

  it("treats a bare 写下一章 as a request to open 落笔", () => {
    expect(isWriteNextRequest("写下一章")).toBe(true);
    expect(isWriteNextRequest("写下一章。")).toBe(true);
    expect(isWriteNextRequest("请写下一章")).toBe(true);
    expect(isWriteNextRequest("帮我看看下一章的伏笔")).toBe(false);
    expect(read("src/pages/ChatPage.tsx")).toMatch(/isWriteNextRequest/);
    expect(read("src/pages/DaemonControl.tsx")).toMatch(/审稿方式/);
    expect(read("src/components/SerialCockpitStrip.tsx")).not.toMatch(/startWriteNext/);
    expect(read("src/components/SerialCockpitStrip.tsx")).not.toMatch(/startDraft/);
  });
});

describe("large-book chapter table", () => {
  it("folds chapters by volume, searches, and opens the current volume", () => {
    const tree = parseVolumeMapTree([
      "## 第1卷 上卷（1-2章）",
      "## 第2卷 下卷（3-4章）",
    ].join("\n"));
    const chapters = [
      { number: 1, title: "开篇" },
      { number: 2, title: "夜雨" },
      { number: 3, title: "重逢" },
      { number: 4, title: "离城" },
    ];
    const groups = buildChapterGroups(chapters, tree, true);
    expect(groups.map((group) => group.title)).toEqual(["第1卷 上卷", "第2卷 下卷"]);
    expect(groups[0]?.chapters.map((chapter) => chapter.number)).toEqual([1, 2]);
    expect(defaultOpenGroupId(groups, 3)).toBe(groups[1]?.id);
    expect(filterChapterGroups(groups, "重逢").flatMap((group) => group.chapters.map((chapter) => chapter.number))).toEqual([3]);
    expect(filterChapterGroups(groups, "4").flatMap((group) => group.chapters.map((chapter) => chapter.number))).toEqual([4]);
  });

  it("asks the workspace for one chapter on 落笔 and a summary on 书房", () => {
    expect(workspaceQuery("demo", undefined, { chapter: 137 })).toBe("bookId=demo&chapter=137");
    expect(workspaceQuery("demo", undefined, { summary: true })).toBe("bookId=demo&summary=1");
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/chapter: chapterNumber/);
    expect(read("src/pages/BookStudy.tsx")).toMatch(/summary: true/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/chapter-table-search|ChapterManuscriptTable/);
    expect(read("src/hooks/use-hash-route.ts")).toMatch(/chapter\/\$\{route\.chapterNumber\}/);
  });
});
