import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import { createLightweightBook } from "../authoring/book-create.js";
import {
  adoptChapterDraft,
  generateChapterDraft,
  reviewChapterDraft,
  reviseChapterDraft,
} from "../authoring/stages/write.js";
import { adoptWeave, generateWeaveRange, generateWeaveStructure } from "../authoring/stages/weave.js";
import { loadManifest, loadReport } from "../authoring/store.js";
import type { AuthoringLlmFn } from "../authoring/types.js";

function project() {
  return ProjectConfigSchema.parse({
    name: "test",
    version: "0.1.0",
    llm: {
      provider: "custom",
      service: "zenmux",
      configSource: "studio",
      baseUrl: "https://zenmux.ai/api/v1",
      model: "write-main",
      apiKey: "sk",
      temperature: 0.6,
      thinkingBudget: 0,
      apiFormat: "chat",
      stream: true,
    },
    authoringRoles: {
      "write.main": { modelId: "write-main", serviceRef: "zenmux" },
      "write.review": { modelId: "write-review", serviceRef: "zenmux" },
    },
  });
}

describe("write stage", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("does not review while generating, revises from the selected report, and adopts one version", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "夜港",
        oneLine: "会计",
        proposition: "",
        protagonist: "沈砚",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 4,
      },
    });
    const roles: string[] = [];
    const llm: AuthoringLlmFn = async (call) => {
      roles.push(call.roleId);
      if (call.roleId === "write.review") {
        return JSON.stringify({
          summary: "开头可收紧",
          coverage: "chapter:1",
          issues: [{
            issueId: "w1",
            title: "开头散",
            severity: "improve",
            suggestion: "第一段直接写港口雨",
          }],
        });
      }
      if (call.messages.some((message) => message.content.includes("按选中意见"))) {
        return "# 第1章\n雨打在夜港铁皮上。沈砚把账本按进怀里。";
      }
      if (call.messages.some((message) => message.content.includes("整理人物状态"))) {
        return "沈砚已拿到账本残页。";
      }
      return "# 第1章\n沈砚走在街上。";
    };
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm };
    const structured = await generateWeaveStructure({
      root: ctx.root,
      project: ctx.project,
      llm: async () => JSON.stringify({
        bookOutline: "一卷",
        volumes: [{ volumeNumber: 1, title: "上", startChapter: 1, endChapter: 4, body: "上卷" }],
      }),
    });
    await adoptWeave({ root: ctx.root, project: ctx.project, artifactId: structured.artifactId });
    const planned = await generateWeaveRange({
      root: ctx.root,
      project: ctx.project,
      startChapter: 1,
      endChapter: 1,
      llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "雨", summary: "港口开场。" }] }),
    });
    await adoptWeave({ root: ctx.root, project: ctx.project, artifactId: planned.artifactId });
    const draft = await generateChapterDraft({ ...ctx, chapterNumber: 1, title: "雨" });
    expect(roles).toEqual(["write.main"]);
    const report = await reviewChapterDraft({ ...ctx, artifactId: draft.artifactId });
    expect(report.actualReviewModel).toBe("write-review");
    const revised = await reviseChapterDraft({
      ...ctx,
      artifactId: draft.artifactId,
      reportId: report.reportId,
      selectedIssueIds: ["w1"],
    });
    const adopted = await adoptChapterDraft({ ...ctx, artifactId: revised.artifactId });
    expect(adopted.adopted).toBe(true);
    expect(adopted.settled).toBe(true);
    const body = await readFile(join(created.bookDir, "chapters", "0001_雨.md"), "utf-8");
    expect(body).toContain("夜港铁皮");
    const manifest = await loadManifest(ctx.root);
    expect(manifest.adopted.write["1"]).toBe(revised.artifactId);
    expect(await loadReport(ctx.root, report.reportId)).toMatchObject({ stale: false });
    const indexRaw = await readFile(join(created.bookDir, "chapters", "index.json"), "utf-8");
    const index = JSON.parse(indexRaw) as Array<{ number: number; title: string }>;
    expect(index.some((item) => item.number === 1 && item.title.includes("雨"))).toBe(true);
  });

  it("includes adopted canon, settings, and outline when revising a chapter (R7-07)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r7-07-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "夜港",
        oneLine: "会计",
        proposition: "MARK-PROP-R7",
        protagonist: "沈砚",
        conflict: "",
        voice: "",
        boundaries: "MARK-BOUND-R7",
        direction: "",
        openQuestions: [],
        targetChapters: 4,
      },
    });
    await mkdir(join(created.bookDir, "story", "settings"), { recursive: true });
    await writeFile(join(created.bookDir, "story", "settings", "index.json"), JSON.stringify({
      categories: ["规则"],
      entries: [{ id: "rule", category: "规则", name: "铁律", file: "story/settings/rule.md", adoptedArtifactId: "g1" }],
    }), "utf-8");
    await writeFile(join(created.bookDir, "story", "settings", "rule.md"), "MARK-SETTING-R7 魔法有代价。\n", "utf-8");
    const seen: string[] = [];
    const roles: string[] = [];
    const llm: AuthoringLlmFn = async (call) => {
      const text = call.messages.map((message) => message.content).join("\n");
      seen.push(text);
      roles.push(call.roleId);
      if (call.roleId === "write.review") {
        return JSON.stringify({
          summary: "补代价",
          coverage: "chapter:1",
          issues: [{ issueId: "w1", title: "补设定", severity: "priority", suggestion: "按已采用设定补充魔法代价" }],
        });
      }
      if (text.includes("按选中意见")) {
        return "# 第1章\n雨里付了代价。";
      }
      if (text.includes("整理人物状态")) return "状态";
      return "# 第1章\n沈砚走在街上。";
    };
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm };
    const structured = await generateWeaveStructure({
      root: ctx.root,
      project: ctx.project,
      llm: async () => JSON.stringify({
        bookOutline: "一卷",
        volumes: [{ volumeNumber: 1, title: "上", startChapter: 1, endChapter: 4, body: "上卷" }],
      }),
    });
    await adoptWeave({ root: ctx.root, project: ctx.project, artifactId: structured.artifactId });
    const planned = await generateWeaveRange({
      root: ctx.root,
      project: ctx.project,
      startChapter: 1,
      endChapter: 1,
      llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "雨", summary: "MARK-OUTLINE-R7 港口开场。" }] }),
    });
    await adoptWeave({ root: ctx.root, project: ctx.project, artifactId: planned.artifactId });
    const draft = await generateChapterDraft({ ...ctx, chapterNumber: 1, title: "雨" });
    const report = await reviewChapterDraft({ ...ctx, artifactId: draft.artifactId });
    await reviseChapterDraft({
      ...ctx,
      artifactId: draft.artifactId,
      reportId: report.reportId,
      selectedIssueIds: ["w1"],
    });
    const revisePrompt = seen.find((text) => text.includes("按选中意见"));
    expect(revisePrompt).toContain("MARK-PROP-R7");
    expect(revisePrompt).toContain("MARK-BOUND-R7");
    expect(revisePrompt).toContain("MARK-SETTING-R7");
    expect(revisePrompt).toContain("MARK-OUTLINE-R7");
    expect(seen.filter((text) => text.includes("按选中意见"))).toHaveLength(1);
    expect(roles.filter((id) => id === "write.review")).toHaveLength(1);
  });
});
