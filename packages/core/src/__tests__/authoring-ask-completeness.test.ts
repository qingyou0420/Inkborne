// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import { parseCanon } from "../authoring/canon.js";
import { generateAskCanon, reviewAskCanon, reviseAskCanon } from "../authoring/stages/ask.js";
import { listArtifacts, listRuns, loadArtifact, loadManifest } from "../authoring/store.js";
import type { AuthoringLlmFn, CanonDocument } from "../authoring/types.js";

const original: CanonDocument = {
  title: "渡河记",
  genre: "古风",
  targetChapters: 120,
  chapterWordCount: 3000,
  oneLine: "渡船女寻找失散的家人。",
  proposition: "自由与承诺能否两全。",
  protagonist: "阿渡希望重聚，同时保住渡船。",
  conflict: "官府封河与渡人的承诺相撞。",
  voice: "第三人称限知，克制的白描。",
  boundaries: "无人拥有死而复生的能力。结局由作者保留。",
  direction: "从渡口被封的那天开始。",
  openQuestions: ["阿渡最终是否留在渡口？由作者待定。"],
};

const issues = [
  {
    issueId: "selected",
    title: "补足封河代价",
    severity: "priority",
    target: "主要冲突",
    evidence: "EVIDENCE_作者说封河将断绝两岸药材往来",
    reason: "REASON_当前稿遗漏了人命代价",
    suggestion: "SUGGESTION_补回药材断供，保留结局待定",
    sources: ["SOURCE_问心最后一轮对话"],
  },
  { issueId: "unselected", title: "UNSELECTED_不应执行的改写", severity: "style", suggestion: "改变结局" },
];

function project() {
  return ProjectConfigSchema.parse({
    name: "ask-completeness-test",
    version: "0.1.0",
    llm: { provider: "custom", model: "stub-main", baseUrl: "https://unused.invalid/v1", apiKey: "stub" },
    authoringRoles: {
      "ask.main": { modelId: "stub-main" },
      "ask.review": { modelId: "stub-review" },
    },
  });
}

describe("ask canon completeness", () => {
  let projectRoot = "";
  afterEach(async () => {
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
    projectRoot = "";
  });

  async function fixture() {
    projectRoot = await mkdtemp(join(tmpdir(), "ask-completeness-"));
    return { root: { projectRoot, draftId: "draft" }, project: project() };
  }

  async function reviewedFixture() {
    const ctx = await fixture();
    const generated = await generateAskCanon({ ...ctx, conversation: "测试对话", llm: async () => JSON.stringify(original) });
    const report = await reviewAskCanon({
      ...ctx,
      artifactId: generated.artifactId,
      llm: async () => JSON.stringify({ summary: "只补回有依据的遗漏", issues }),
    });
    return { ctx, generated, report };
  }

  it("sends the entire conversation to generation and review, including corrections beyond both former limits", async () => {
    const ctx = await fixture();
    const conversation = `BEGIN_作者最初的边界\n${"讨论内容".repeat(3300)}\nEND_最新决定采用第三人称限知`;
    const calls: { role: string; prompt: string }[] = [];
    const llm: AuthoringLlmFn = async (call) => {
      calls.push({ role: call.roleId, prompt: call.messages.map((message) => message.content).join("\n") });
      return JSON.stringify(call.roleId === "ask.review" ? { summary: "无遗漏", issues: [] } : original);
    };
    const generated = await generateAskCanon({ ...ctx, conversation, llm });
    await reviewAskCanon({ ...ctx, artifactId: generated.artifactId, conversation, llm });
    expect(conversation.length).toBeGreaterThan(12000);
    expect(calls.map((call) => call.role)).toEqual(["ask.main", "ask.review"]);
    for (const call of calls) expect(call.prompt).toContain(conversation);
    expect(calls[0]!.prompt).toContain("简体中文");
    expect(calls[0]!.prompt).toContain("JSON 字段名严格使用上述英文名称");
    expect(calls[0]!.prompt).toContain("不要杜撰事实或替作者自动决定");
  });

  it("accepts full Chinese section names without losing the four formerly unrecognized sections", async () => {
    const ctx = await fixture();
    const result = await generateAskCanon({
      ...ctx,
      conversation: "已明确各项意图",
      llm: async () => JSON.stringify({
        书名: original.title,
        题材: original.genre,
        目标章数: original.targetChapters,
        每章字数: original.chapterWordCount,
        一句话故事: original.oneLine,
        核心命题: original.proposition,
        主角与核心欲望: original.protagonist,
        主要冲突: original.conflict,
        叙事视角与文风: original.voice,
        故事边界: original.boundaries,
        初始方向: original.direction,
        待定项: original.openQuestions,
      }),
    });
    expect(result.canon).toEqual(original);
    const saved = await loadArtifact(ctx.root, result.artifactId);
    expect(parseCanon(saved!.body)).toEqual(original);
    expect(saved!.body).not.toContain("（待补）");
    expect((await loadManifest(ctx.root)).adopted.ask).toBeUndefined();
  });

  it("keeps all unreturned fields and numeric metadata when a regeneration returns only a correction", async () => {
    const ctx = await fixture();
    await generateAskCanon({ ...ctx, conversation: "原对话", llm: async () => JSON.stringify(original) });
    const result = await generateAskCanon({
      ...ctx,
      conversation: "封河还导致药材断供",
      llm: async () => JSON.stringify({ conflict: "封河断药，渡人与自保难以两全。" }),
    });
    expect(result.canon).toEqual({ ...original, conflict: "封河断药，渡人与自保难以两全。" });
    expect(result.version).toBe(2);
  });

  it("revises from an explicit schema, complete selected evidence, and full conversation while preserving omitted fields", async () => {
    const { ctx, generated, report } = await reviewedFixture();
    const conversation = `作者开头的约定\n${"背景".repeat(6500)}\nLATEST_结局保持待定，不可复活`;
    let prompt = "";
    const revised = await reviseAskCanon({
      ...ctx,
      artifactId: generated.artifactId,
      reportId: report.reportId,
      selectedIssueIds: ["selected"],
      extraRequirement: "保持白描",
      conversation,
      llm: async (call) => {
        prompt = call.messages.map((message) => message.content).join("\n");
        return JSON.stringify({ 主要冲突: "封河导致药材断供。" });
      },
    });
    expect(revised.canon).toEqual({ ...original, conflict: "封河导致药材断供。" });
    for (const name of ["title", "genre", "oneLine", "proposition", "protagonist", "conflict", "voice", "boundaries", "direction"]) {
      expect(prompt).toContain(`${name}: string`);
    }
    expect(prompt).toContain("targetChapters: 正整数或 null");
    expect(prompt).toContain("chapterWordCount: 不小于 100 的整数或 null");
    expect(prompt).toContain("openQuestions: string[]");
    expect(prompt).toContain(conversation);
    for (const key of ["evidence", "reason", "suggestion", "target"] as const) expect(prompt).toContain(issues[0]![key]!);
    expect(prompt).toContain("SOURCE_问心最后一轮对话");
    expect(prompt).toContain("保持白描");
    expect(prompt).not.toContain("UNSELECTED_");
    expect(prompt).not.toContain("字段同生成正典");
    expect(prompt).toContain("简体中文");
    const saved = await loadArtifact(ctx.root, revised.artifactId);
    expect(parseCanon(saved!.body)).toEqual(revised.canon);
    expect(saved!.meta.parentArtifactId).toBe(generated.artifactId);
    expect((await loadManifest(ctx.root)).adopted.ask).toBeUndefined();
  });

  it("honors explicit cleared questions and undecided length without resetting omitted content", async () => {
    const { ctx, generated, report } = await reviewedFixture();
    const revised = await reviseAskCanon({
      ...ctx, artifactId: generated.artifactId, reportId: report.reportId, selectedIssueIds: ["selected"],
      llm: async () => JSON.stringify({ openQuestions: [], targetChapters: null, chapterWordCount: null }),
    });
    expect(revised.canon).toEqual({ ...original, openQuestions: [], targetChapters: undefined, chapterWordCount: undefined });
  });

  const invalidOutputs = [
    ["invalid JSON", "模型没能输出 JSON"],
    ["empty object", "{}"],
    ["unknown fields", JSON.stringify({ summary: "已经完成" })],
    ["empty story", JSON.stringify({ title: "空稿", protagonist: "", openQuestions: [] })],
    ["object text", JSON.stringify({ ...original, protagonist: { desire: "渡人" } })],
    ["array text", JSON.stringify({ ...original, voice: ["白描"] })],
    ["object question", JSON.stringify({ ...original, openQuestions: [{ question: "结局？" }] })],
  ];

  it.each(invalidOutputs)("does not save a successful new candidate for %s", async (_label, output) => {
    const ctx = await fixture();
    await expect(generateAskCanon({ ...ctx, conversation: "已知意图", llm: async () => output! })).rejects.toThrow();
    expect((await loadManifest(ctx.root)).candidates.ask).toBeUndefined();
    expect(await listArtifacts(ctx.root, "ask")).toHaveLength(0);
    expect(await listRuns(ctx.root)).toMatchObject([{ status: "failed", producedArtifactIds: [] }]);
  });

  it.each([
    ["invalid JSON", "不是 JSON"],
    ["empty object", "{}"],
    ["unknown fields", JSON.stringify({ result: "完成" })],
    ["wrong text type", JSON.stringify({ 主角与核心欲望: { 欲望: "渡人" } })],
  ])("leaves the current candidate untouched after a revision with %s", async (_label, output) => {
    const { ctx, generated, report } = await reviewedFixture();
    await expect(reviseAskCanon({
      ...ctx, artifactId: generated.artifactId, reportId: report.reportId, selectedIssueIds: ["selected"],
      llm: async () => output!,
    })).rejects.toThrow();
    expect((await loadManifest(ctx.root)).candidates.ask).toBe(generated.artifactId);
    expect(await listArtifacts(ctx.root, "ask")).toHaveLength(1);
    expect(parseCanon((await loadArtifact(ctx.root, generated.artifactId))!.body)).toEqual(original);
  });
});
