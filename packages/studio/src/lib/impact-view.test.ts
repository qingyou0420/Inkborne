/** SPDX-License-Identifier: AGPL-3.0-only */
import { describe, expect, it } from "vitest";
import type { AuthoringImpactItem, AuthoringImpactSummary } from "./authoring-workspace";
import {
  defaultImpactFilter,
  degradedImpactOpen,
  filterGroundEntries,
  findImpactTriageRun,
  impactCompleteCopy,
  impactOpenTotal,
  impactRegenerateRequirements,
  impactVersionSpan,
  isImpactTriageRun,
  isLegacyCanonWatch,
  openCatalogImpact,
  openGroundItemForEntry,
  openImpactItems,
  openStructureImpact,
  openWeaveItemForChapter,
  shouldShowImpactFilter,
  studyImpactAttention,
  truncateImpactReason,
  weaveNodeMatchesItem,
  weaveReviseRangeFromIssues,
  writeImpactActionLabel,
  writeImpactBanner,
} from "./impact-view";

function item(partial: Partial<AuthoringImpactItem> & Pick<AuthoringImpactItem, "key" | "stage" | "targetId" | "label">): AuthoringImpactItem {
  return {
    verdict: "affected",
    fields: ["protagonist"],
    reason: "核心欲望由『复仇』改为『赎罪』",
    method: "llm",
    status: "open",
    ...partial,
  };
}

const impact: AuthoringImpactSummary = {
  impactId: "imp-1",
  from: { artifactId: "ask-v3", version: 3 },
  to: { artifactId: "ask-v4", version: 4 },
  openCount: { ground: 2, weave: 1 },
  items: [
    item({ key: "ground:shen-yan", stage: "ground", targetId: "shen-yan", label: "沈砚", hint: "重写动机" }),
    item({ key: "ground:zui-ci", stage: "ground", targetId: "zui-ci", label: "醉词楼", verdict: "maybe" }),
    item({ key: "ground:closed", stage: "ground", targetId: "closed", label: "已关", status: "reviewed" }),
    item({ key: "weave:chapter:12", stage: "weave", targetId: "chapter:12", label: "第 12 章" }),
    item({ key: "weave:structure", stage: "weave", targetId: "structure", label: "分卷结构", reason: "全书篇幅由 200 改为 240 章" }),
  ],
  globals: [],
  method: "llm",
  groundReportId: "g-rep",
  weaveReportId: "w-rep",
};

describe("impact-view filters", () => {
  it("defaults to 需核对 only when open items exist", () => {
    expect(defaultImpactFilter(9)).toBe("needs-review");
    expect(defaultImpactFilter(0)).toBe("all");
    expect(shouldShowImpactFilter(9, true)).toBe(true);
    expect(shouldShowImpactFilter(0, true)).toBe(false);
    expect(shouldShowImpactFilter(9, false)).toBe(false);
  });

  it("returns only the open subset for a stage", () => {
    expect(openImpactItems(impact, "ground").map((row) => row.targetId)).toEqual(["shen-yan", "zui-ci"]);
    expect(openImpactItems(impact, "weave").map((row) => row.key)).toEqual(["weave:chapter:12", "weave:structure"]);
    expect(impactOpenTotal(impact)).toBe(3);
    expect(openGroundItemForEntry(impact, "shen-yan")?.label).toBe("沈砚");
    expect(openCatalogImpact(impact)).toBeUndefined();
    expect(openStructureImpact(impact)?.targetId).toBe("structure");
  });

  it("filters a 157-entry catalog down to the affected subset", () => {
    const entries = Array.from({ length: 157 }, (_, index) => ({
      id: index === 3 ? "shen-yan" : index === 8 ? "zui-ci" : `entry-${index}`,
    }));
    expect(filterGroundEntries(entries, impact, "needs-review").map((row) => row.id)).toEqual(["shen-yan", "zui-ci"]);
    expect(filterGroundEntries(entries, impact, "all")).toHaveLength(157);
  });

  it("matches weave chapters by node id or chapter number", () => {
    const chapter = openImpactItems(impact, "weave")[0]!;
    expect(weaveNodeMatchesItem(chapter, "chapter:12", 12)).toBe(true);
    expect(weaveNodeMatchesItem(chapter, "chapter:3", 3)).toBe(false);
    expect(openWeaveItemForChapter(impact, 12)?.key).toBe("weave:chapter:12");
    expect(openWeaveItemForChapter(impact, 1)).toBeUndefined();
  });
});

describe("impact-view copy", () => {
  it("truncates reasons and joins reason+hint for regenerate", () => {
    expect(truncateImpactReason("短理由")).toBe("短理由");
    expect(truncateImpactReason("x".repeat(61)).endsWith("…")).toBe(true);
    expect(impactRegenerateRequirements(openImpactItems(impact, "ground"), true)).toMatch(/对照新正典的影响/);
    expect(impactRegenerateRequirements(openImpactItems(impact, "ground"), true)).toMatch(/重写动机/);
    expect(impactRegenerateRequirements(openImpactItems(impact, "ground"), true)).not.toMatch(/已关/);
  });

  it("builds the write banner from open impact, not coarse watches", () => {
    const banner = writeImpactBanner({
      impact,
      watches: [{ id: "w1", stage: "ground", label: "正典已采用新版本，设定可能需要核对", acknowledged: false, impactReportId: "imp-1" }],
      chapterNumber: 12,
      isZh: true,
    });
    expect(banner?.kind).toBe("open");
    expect(banner?.text).toBe("正典 v3→v4 影响未核对完：设定 2 条、章概要 1 章");
    expect(banner?.chapterText).toMatch(/本章概要被标记受影响/);
    expect(banner?.actions).toEqual(["ground", "weave", "chapter"]);
    expect(writeImpactActionLabel("ground", true)).toBe("去研墨");
  });

  it("clears the write banner when every impact item is closed", () => {
    expect(writeImpactBanner({
      impact: { ...impact, openCount: { ground: 0, weave: 0 }, items: impact.items.map((row) => ({ ...row, status: "reviewed" })) },
      isZh: true,
    })).toBeNull();
    expect(writeImpactBanner({
      watches: [{ id: "w1", stage: "ground", label: "正典已采用新版本，设定可能需要核对", acknowledged: true }],
      isZh: true,
    })).toBeNull();
  });

  it("shows degraded and legacy banners, and hides them for old books", () => {
    expect(writeImpactBanner({
      impact: { ...impact, openCount: { ground: 0, weave: 0 }, items: [], degraded: { reason: "模型超时" } },
      isZh: true,
    })).toMatchObject({ kind: "degraded", actions: ["recompute", "ack"] });
    expect(writeImpactBanner({
      watches: [{ id: "old", stage: "ground", label: "正典已采用新版本，设定可能需要核对", acknowledged: false }],
      isZh: true,
    })).toMatchObject({ kind: "legacy" });
    expect(writeImpactBanner({
      impact,
      authoringBook: false,
      isZh: true,
    })).toBeNull();
    expect(writeImpactBanner({
      triageRunning: true,
      isZh: true,
    })?.kind).toBe("running");
  });

  it("clears the degraded banner once its watches are acknowledged, and surfaces stuck pending watches", () => {
    const degraded = { ...impact, openCount: { ground: 0, weave: 0 }, items: [], degraded: { reason: "模型超时" } };
    const acked = [
      { id: "g", stage: "ground", label: "失败", acknowledged: true, impactReportId: "imp-1" },
      { id: "w", stage: "weave", label: "失败", acknowledged: true, impactReportId: "imp-1" },
    ];
    expect(degradedImpactOpen(degraded, acked)).toBe(false);
    expect(degradedImpactOpen(degraded, [{ ...acked[0]!, acknowledged: false }])).toBe(true);
    expect(writeImpactBanner({ impact: degraded, watches: acked, isZh: true })).toBeNull();
    expect(studyImpactAttention({ impact: degraded, watches: acked, isZh: true })).toBeNull();
    expect(writeImpactBanner({ impact: degraded, watches: [{ ...acked[0]!, acknowledged: false }], isZh: true })?.kind).toBe("degraded");
    const pending = [{ id: "p", stage: "ground", label: "正典已采用新版本", acknowledged: false, impactReportId: "pending" }];
    expect(isLegacyCanonWatch(pending[0]!)).toBe(true);
    expect(writeImpactBanner({ impact: { ...impact, openCount: { ground: 0, weave: 0 }, items: [] }, watches: pending, isZh: true })?.kind).toBe("legacy");
    expect(writeImpactBanner({ watches: pending, triageRunning: true, isZh: true })?.kind).toBe("running");
  });

  it("merges 等你过目 into one impact line", () => {
    const line = studyImpactAttention({ impact, isZh: true });
    expect(line?.label).toBe("正典 v3→v4：设定 2 条、章概要 1 章待核对");
    expect(line?.groundOpen).toBe(2);
    expect(line?.weaveOpen).toBe(1);
    expect(studyImpactAttention({
      watches: [{ id: "old", stage: "ground", label: "正典已采用新版本", acknowledged: false }],
      isZh: true,
    })?.legacy).toBe(true);
    expect(studyImpactAttention({ impact, authoringBook: false, isZh: true })).toBeNull();
  });

  it("builds the ask completion toast and revise range", () => {
    expect(impactCompleteCopy({ impact, isZh: true })).toEqual({
      message: "影响分辨完成：设定 2 条、章概要 1 章需核对",
      stage: "ground",
      action: "去研墨",
    });
    expect(weaveReviseRangeFromIssues([
      { issueId: "a", title: "12", severity: "priority", target: "12" },
      { issueId: "b", title: "30", severity: "improve", target: "30" },
      { issueId: "c", title: "结构", severity: "priority", target: "structure" },
    ])).toEqual({ startChapter: 12, endChapter: 30, structure: true });
    expect(impactVersionSpan(impact.from, impact.to)).toBe("正典 v3→v4");
    expect(isImpactTriageRun({ stage: "ask", operation: "review", scope: "impact:a..b" })).toBe(true);
    expect(isImpactTriageRun({ stage: "ask", operation: "review", scope: "canon" })).toBe(false);
    expect(findImpactTriageRun([
      { runId: "old", stage: "ask", operation: "review", scope: "impact:a..b", status: "completed" },
      { runId: "live", stage: "ask", operation: "review", scope: "impact:a..c", status: "running" },
    ])?.runId).toBe("live");
    expect(isLegacyCanonWatch({ id: "x", stage: "ground", label: "旧提醒", acknowledged: false })).toBe(true);
    expect(isLegacyCanonWatch({ id: "y", stage: "ground", label: "新", acknowledged: false, impactReportId: "imp-1" })).toBe(false);
  });
});
