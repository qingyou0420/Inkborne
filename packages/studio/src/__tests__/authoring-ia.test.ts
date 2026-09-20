/**
 * Four-agent authoring IA: eight roles, ask canon rail, API surface.
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
    expect(read("src/api/authoring-routes.ts")).toMatch(/\/authoring\/write\/hand/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/\/authoring\/write\/select/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/key=\{`\$\{bookId\}:\$\{activeChapter\}`\}/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/authoringBook \?/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/write-legacy-tools/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/mergeWriteDirectory/);
    expect(read("src/pages/BookDetail.tsx")).toMatch(/firstUnwrittenChapter/);
    expect(read("src/pages/BookStudy.tsx")).toMatch(/study-write-chapter/);
    expect(read("src/pages/BookStudy.tsx")).toMatch(/落笔 · 第 \$\{writeChapterNumber\} 章/);
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
    expect(read("src/components/AuthoringWeavePanel.tsx")).toMatch(/reviseStructure: isStructureCandidate/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).toMatch(/openChapterGeneration/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).toMatch(/const openChapterGeneration = \(\) => \{\s*applyVolumeRange\(\);/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).not.toMatch(/applyVolumeRange\(plannedVolumes\[0\]\)/);
    expect(read("src/components/AuthoringWeavePanel.tsx")).not.toMatch(/targetChapters: Number\(endChapter\)/);
    expect(read("src/pages/OutlineWorkspace.tsx")).toMatch(/authoringBook \?/);
    expect(read("src/pages/OutlineWorkspace.tsx")).toMatch(/preferredVolume/);
    expect(read("src/api/authoring-routes.ts")).toMatch(/请先/);
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
});
