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
import { groupReviewIssues } from "../lib/review-dimensions";
import { isWriteNextRequest } from "../lib/write-next-request";

const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(rel: string): string {
  return readFileSync(join(studioRoot, rel), "utf8");
}

describe("authoring four-agent IA", () => {
  it("registers authoring routes and eight-role settings", () => {
    const server = read("src/api/server.ts");
    const routes = read("src/api/authoring-routes.ts");
    const settings = read("src/pages/ServiceListPage.tsx");
    expect(server).toMatch(/registerAuthoringRoutes/);
    expect(server).toMatch(/authoringRoles: fillMissingAuthoringRoles/);
    expect(server).toMatch(/isLightweightAuthoringBook/);
    expect(routes).toMatch(/\/api\/v1\/authoring\/roles/);
    expect(routes).toMatch(/\/api\/v1\/authoring\/ask\/adopt/);
    expect(routes).toMatch(/\/api\/v1\/authoring\/weave\/generate/);
    expect(routes).toMatch(/\/api\/v1\/authoring\/write\/revise/);
    expect(routes).toMatch(/\/api\/v1\/authoring\/write\/settle/);
    expect(routes).toMatch(/wait\?: boolean/);
    expect(routes).toMatch(/authoring:run/);
    expect(routes).toMatch(/\/api\/v1\/authoring\/drafts\/ensure/);
    expect(routes).toMatch(/\/api\/v1\/authoring\/roles\/:roleId\/test/);
    expect(routes).toMatch(/saveHandEditedArtifact/);
    expect(settings).toMatch(/AuthoringRolesPanel/);
    expect(read("src/pages/ProjectSettings.tsx")).not.toMatch(/project\/model-overrides/);
    expect(read("src/pages/ProjectSettings.tsx")).toMatch(/外观设置/);
    expect(read("src/pages/ServiceListPage.tsx")).not.toMatch(/SimpleModelSettings/);
    expect(read("src/components/BookWorkspaceNav.tsx")).toMatch(/设定档案/);
    expect(read("src/components/BookBusyCard.tsx")).toMatch(/这本书正在被写入/);
    expect(read("src/components/BookBusyCard.tsx")).toMatch(/等它写完/);
    expect(read("src/components/BookBusyCard.tsx")).toMatch(/强制放开/);
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

  it("uses 采用并建书 on the create page and has no confirmation-card rail", () => {
    const app = read("src/App.tsx");
    const panel = read("src/components/AskCanonPanel.tsx");
    expect(app).toMatch(/mode="book-create"/);
    expect(app).toMatch(/AskCanonPanel/);
    expect(app).not.toMatch(/AskCreateRail/);
    expect(panel).toMatch(/采用并建书/);
    expect(panel).toMatch(/creatingBook \? \(isZh \? "采用并建书"/);
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
    expect(read("src/pages/BookDetail.tsx")).toMatch(/authoringBook \?/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/write-legacy-tools/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/mergeWriteDirectory/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/firstUnwrittenChapter/);
    expect(read("src/pages/BookStudy.tsx")).toMatch(/study-four-steps/);
    expect(read("src/pages/BookStudy.tsx")).toMatch(/等你过目/);
    expect(read("src/pages/BookStudy.tsx")).not.toMatch(/study-write-chapter/);
    expect(read("src/pages/BookStudy.tsx")).not.toMatch(/cockpit-write-next-button/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/data-testid="write-generate"/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/onClick=\{\(\) => void generateChapter\(requirementNotes\)\}/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/写下一章/);
    expect(read("src/lib/toast.ts")).toMatch(/action\?: ToastAction/);
    expect(read("src/api/server.ts")).toMatch(/rejectLegacyPipelineForAuthoringBook/);
    expect(read("src/api/server.ts")).toMatch(/四阶段书请在落笔中生成候选并采用/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/resolveAdoptArtifactId/);
    expect(read("src/components/AskCanonPanel.tsx")).toMatch(/persistIfDirty/);
    expect(read("src/components/AuthoringGroundPanel.tsx")).toMatch(/persistIfDirty/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).toMatch(/persistIfDirty/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).toMatch(/生成分卷规划/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).toMatch(/outline-weave-chapters/);
    // Structure candidates still revise structure: mode is `range.structure || isStructureCandidate ? "structure" : "chapters"`.
    expect(read("src/components/AuthoringWeavePanel.tsx")).toMatch(/mode: range\.structure \|\| isStructureCandidate \? "structure" : "chapters"/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).toMatch(/reviseStructure: generation\.mode === "structure"/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).toMatch(/openChapterGeneration/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).toMatch(/const openChapterGeneration = \(\) => \{\s*applyVolumeRange\(\);/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).not.toMatch(/applyVolumeRange\(plannedVolumes\[0\]\)/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).not.toMatch(/targetChapters: Number\(endChapter\)/);
    expect(read("src/pages/OutlineWorkspace.tsx")).toMatch(/authoringBook \?/);
    expect(read("src/pages/OutlineWorkspace.tsx")).toMatch(/preferredVolume/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/请先/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).toMatch(/outline-weave-pause/);
    expect(read("src/components/AskCanonPanel.tsx")).toMatch(/放弃这次运行/);
    expect(read("src/components/AuthoringGroundPanel.tsx")).toMatch(/放弃这次运行/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/放弃这次运行/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).toMatch(/data-testid="authoring-abandon-run"/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/selectScopedAuthoringRun\(data\?\.runs, "write", scope\)/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/previousChapterSettleHold/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/writeRetryAction/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/整理状态/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/locateManuscriptEvidence/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/write-manuscript-body/);
    expect(read("src/components/AuthoringWritePanel.tsx")).not.toMatch(/window\.find/);
    expect(read("src/components/AuthoringReviewDrawer.tsx")).toMatch(/定位正文/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/状态未整理/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/chapter-settle-/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/serverStartedAt/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/migrateBookSession/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/persistStartingRun/);
    expect(read("src/components/AskCanonPanel.tsx")).toMatch(/ask-candidate-body/);
    expect(read("src/components/AuthoringRolesPanel.tsx")).toMatch(/测试此配置/);
    expect(read("src/components/AuthoringRolesPanel.tsx")).toMatch(/继承连接/);
    expect(read("src/components/AuthoringRolesPanel.tsx")).toMatch(/apiFormat: draft\.apiFormat[\s\S]*null/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/inheritProtocol/);
    expect(read("src/pages/BookStudy.tsx")).toMatch(/authoring\/workspace/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/\/api\/v1\/authoring\/ground\/revise/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/\/api\/v1\/authoring\/weave\/revise/);
  });

  it("keeps the 落笔 panel keyed by writeChapter or nextChapter", () => {
    expect(read("src/api/authoring-routes.ts")).toMatch(/baseBody/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/基于当前手改改写/);
    expect(read("src/components/AuthoringWritePanel.tsx")).toMatch(/另起一稿/);
    expect(read("src/lib/unsaved-edits.ts")).toMatch(/__inkborneHasUnsavedEdits/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/key=\{`\$\{bookId\}:\$\{writeChapter \?\? data\.nextChapter\}`\}/);
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

  it("groups review notes by aspect and marks added and removed lines", () => {
    const grouped = groupReviewIssues([
      { issueId: "a", dimension: "文笔" },
      { issueId: "b", dimension: "伏笔" },
      { issueId: "c" },
    ]);
    expect(grouped.map((group) => group.dimension)).toEqual(["伏笔", "文笔", "其他"]);
    const plain = groupReviewIssues([{ issueId: "old" }]);
    expect(plain).toHaveLength(1);
    expect(plain[0]?.dimension).toBe("");
    expect(plain[0]?.issues.map((issue) => issue.issueId)).toEqual(["old"]);
    const drawer = read("src/components/AuthoringReviewDrawer.tsx");
    const diff = read("src/components/AuthoringDiffDrawer.tsx");
    expect(drawer).toContain("groupReviewIssues");
    expect(drawer).toContain("自动检查");
    expect(drawer).toContain("rawExcerpt");
    expect(diff).toContain("data-diff-kind");
    expect(diff).toContain("新增");
    expect(diff).toContain("删除");
  });

  it("defaults 研墨 / 织卷 to 需核对 when impact items are open", () => {
    const ground = read("src/components/AuthoringGroundPanel.tsx");
    const weave = read("src/pages/OutlineWorkspace.tsx") + read("src/components/AuthoringWeavePanel.tsx");
    const write = read("src/components/AuthoringWritePanel.tsx");
    const study = read("src/pages/BookStudy.tsx");
    expect(ground).toMatch(/shouldShowImpactFilter/);
    expect(ground).toMatch(/defaultImpactFilter/);
    expect(ground).toMatch(/需核对/);
    expect(ground).toMatch(/\/authoring\/impact\/resolve/);
    expect(ground).toMatch(/标为已核对/);
    expect(ground).toMatch(/按影响重新生成所选/);
    expect(ground).toMatch(/相对正典重算影响/);
    expect(weave).toMatch(/需核对/);
    expect(weave).toMatch(/分卷需重规划/);
    expect(weave).toMatch(/\/authoring\/impact\/resolve/);
    // 「按意见修订」 on the weave:structure impact issue must actually replan volumes.
    expect(weave).toMatch(/reviseStructure: generation\.mode === "structure"/);
    expect(write).toMatch(/writeImpactBanner/);
    expect(write).toMatch(/write-impact-banner/);
    expect(write).not.toMatch(/watches\?\.some\(\(watch\) => !watch\.acknowledged\)/);
    expect(write).not.toMatch(/上游已有新采用版，审查依据可能需要更新/);
    expect(study).toMatch(/studyImpactAttention/);
    expect(study).toMatch(/相对正典重算影响/);
    expect(study).toMatch(/study-impact-ack/);
    expect(study).toMatch(/标为已核对/);
    expect(write).toMatch(/write-impact-globals/);
    expect(read("src/App.tsx")).toMatch(/invalidationPathsForAuthoringRunSse/);
    expect(read("src/hooks/use-api.ts")).toMatch(/invalidationPathsForAuthoringRunSse/);
    expect(read("src/components/AskCanonPanel.tsx")).toMatch(/impactRunId/);
    expect(read("src/lib/authoring-workspace.ts")).toMatch(/readonly impact\?: AuthoringImpactSummary/);
    expect(read("src/lib/impact-view.ts")).toMatch(/impactGlobalsCopy/);
  });

  it("keeps the catalog and outline unchanged when no impact items are open", () => {
    const ground = read("src/components/AuthoringGroundPanel.tsx");
    const weave = read("src/pages/OutlineWorkspace.tsx");
    expect(ground).toMatch(/shouldShowImpactFilter\(impact\?\.openCount\.ground \?\? 0/);
    expect(ground).toMatch(/showImpactFilter \? catalogFilter : "all"/);
    expect(weave).toMatch(/showImpactFilter \? impactFilter : "all"/);
    expect(weave).toMatch(/shouldShowImpactFilter\(impact\?\.openCount\.weave \?\? 0/);
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
