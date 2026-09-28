import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import { createLightweightBook } from "../authoring/book-create.js";
import { diffLines } from "../authoring/line-diff.js";
import { completeRole, shouldAttemptJsonResponseFormat } from "../authoring/llm.js";
import { fillMissingAuthoringRoles, resolveAuthoringRole } from "../authoring/model-config.js";
import { normalizeReviewDimension } from "../authoring/review-checks.js";
import { parseReviewPayload, reviewPrompt } from "../authoring/review.js";
import { generateChapterDraft, reviewChapterDraft } from "../authoring/stages/write.js";
import { loadReport } from "../authoring/store.js";
import { payloadWithJsonObjectFormat } from "../llm/provider.js";
import type { AuthoringLlmFn, ResolvedAuthoringRole } from "../authoring/types.js";

const chatCompletionMock = vi.hoisted(() => vi.fn());

vi.mock("../llm/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/provider.js")>();
  return { ...actual, chatCompletion: chatCompletionMock };
});

function project(model = "deepseek-chat", provider: "custom" | "anthropic" | "openai" = "custom") {
  return ProjectConfigSchema.parse({
    name: "test",
    version: "0.1.0",
    llm: {
      provider,
      service: "custom",
      configSource: "studio",
      baseUrl: provider === "anthropic" ? "https://api.anthropic.com" : "https://api.deepseek.com/v1",
      model,
      apiKey: "sk",
      temperature: 0.2,
      thinkingBudget: 0,
      apiFormat: "chat",
      stream: false,
    },
    authoringRoles: {
      "write.main": { modelId: model, serviceRef: "custom" },
      "write.review": { modelId: model, serviceRef: "custom" },
    },
  });
}

function role(model = "deepseek-chat", provider: "custom" | "anthropic" | "openai" = "custom"): ResolvedAuthoringRole {
  const parsed = project(model, provider);
  return resolveAuthoringRole({
    roleId: "write.review",
    baseLlm: parsed.llm,
    roles: fillMissingAuthoringRoles(parsed),
  });
}

describe("review upgrade", () => {
  let root = "";
  afterEach(async () => {
    chatCompletionMock.mockReset();
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("keeps an inserted opening as an addition and the rest unchanged", () => {
    expect(diffLines("甲\n乙\n丙", "开场\n甲\n乙\n丙")).toEqual([
      { kind: "add", text: "开场" },
      { kind: "same", text: "甲" },
      { kind: "same", text: "乙" },
      { kind: "same", text: "丙" },
    ]);
    expect(diffLines("甲\n乙\n丙", "甲\n改\n丙")).toEqual([
      { kind: "same", text: "甲" },
      { kind: "del", text: "乙" },
      { kind: "add", text: "改" },
      { kind: "same", text: "丙" },
    ]);
    expect(diffLines("甲\r\n乙", "甲\n乙").every((row) => row.kind === "same")).toBe(true);
  });

  it("does not put response_format on Claude or Anthropic calls", () => {
    expect(shouldAttemptJsonResponseFormat(role("deepseek-chat"))).toBe(true);
    expect(shouldAttemptJsonResponseFormat(role("claude-3-5-sonnet"))).toBe(false);
    expect(shouldAttemptJsonResponseFormat(role("claude-relay", "anthropic"))).toBe(false);
    expect(payloadWithJsonObjectFormat({ model: "x" }, { type: "json_object" })).toMatchObject({
      response_format: { type: "json_object" },
    });
    expect(payloadWithJsonObjectFormat({ model: "x" }, { type: "text" })).toBeUndefined();
  });

  it("sends response_format and retries without it when the relay rejects it", async () => {
    chatCompletionMock
      .mockRejectedValueOnce(new Error("API 返回 400。上游详情：response_format is not supported"))
      .mockResolvedValueOnce({ content: "{\"summary\":\"可以\",\"issues\":[]}" });
    const text = await completeRole(role(), "请审查", undefined, undefined, { responseFormat: "json_object" });
    expect(text).toContain("可以");
    expect(chatCompletionMock).toHaveBeenCalledTimes(2);
    expect(chatCompletionMock.mock.calls[0]?.[3]?.extra?.response_format).toEqual({ type: "json_object" });
    expect(chatCompletionMock.mock.calls[1]?.[3]?.extra?.response_format).toBeUndefined();
  });

  it("folds deterministic checks into a dimensioned report and keeps raw text when JSON fails", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-review-upgrade-"));
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
      },
    });
    await mkdir(join(created.bookDir, "story"), { recursive: true });
    await writeFile(join(created.bookDir, "story", "book_rules.md"), [
      "---",
      "version: \"1.0\"",
      "prohibitions:",
      "  - 系统面板",
      "fatigueWordsOverride:",
      "  - 宛如",
      "---",
      "",
      "本书不写系统面板。",
      "",
    ].join("\n"), "utf-8");
    await writeFile(join(created.bookDir, "chapters", "index.json"), JSON.stringify([
      { number: 1, title: "雨" },
    ]), "utf-8");
    const seen: string[] = [];
    let calls = 0;
    const llm: AuthoringLlmFn = async (call) => {
      calls += 1;
      seen.push(call.messages.map((message) => message.content).join("\n"));
      if (calls === 1) return "这次没按格式来";
      return JSON.stringify({
        summary: "人物还在，线有点断",
        coverage: "chapter:3",
        issues: [{
          issueId: "m1",
          dimension: "人设走样",
          title: "沈砚忽然不怕雨了",
          severity: "improve",
          suggestion: "让他先把衣领竖起来，再说话。",
        }, {
          issueId: "m2",
          dimension: "伏笔",
          title: "铜钱没再出现",
          severity: "priority",
          suggestion: "结尾让铜钱在口袋里碰一下。",
        }],
      });
    };
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm };
    const draft = await generateChapterDraft({
      ...ctx,
      chapterNumber: 3,
      title: "雾",
      llm: async () => "# 第9章\n空气仿佛凝固。宛如风。宛如雨。系统面板亮了。他想起第2章的事。",
    });
    const report = await reviewChapterDraft({ ...ctx, artifactId: draft.artifactId });
    expect(calls).toBe(2);
    expect(seen[0]).toContain("情节推进");
    expect(seen[0]).toContain("人物一致");
    expect(seen[0]).toContain("程序已经先查到");
    expect(report.incomplete).toBe(false);
    expect(report.stale).toBe(false);
    expect(report.rawExcerpt).toBeUndefined();
    expect(report.issues.find((issue) => issue.issueId === "m1")?.dimension).toBe("人物一致");
    expect(report.issues.find((issue) => issue.issueId === "m2")?.dimension).toBe("伏笔");
    expect(report.issues.some((issue) => issue.issueId === "check-length" && issue.dimension === "节奏")).toBe(true);
    expect(report.issues.some((issue) => issue.issueId === "check-chapter-gap" && issue.suggestion?.includes("第 2 章"))).toBe(true);
    expect(report.issues.some((issue) => issue.issueId === "check-heading")).toBe(true);
    expect(report.issues.some((issue) => issue.issueId === "check-chapter-ref" && issue.evidence?.includes("第2章"))).toBe(true);
    expect(report.issues.some((issue) => issue.issueId === "check-craft-as-if-frozen")).toBe(true);
    expect(report.issues.some((issue) => issue.issueId === "check-prohibitions" && issue.evidence?.includes("系统面板"))).toBe(true);
    expect(report.issues.some((issue) => issue.issueId === "check-fatigue" && issue.evidence?.includes("宛如"))).toBe(true);
    expect(report.summary).toContain("自动检查");
    const saved = await loadReport(ctx.root, report.reportId);
    expect(saved?.issues.some((issue) => issue.dimension === "文笔")).toBe(true);
    expect(reviewPrompt("ask", "全文", "正文")).not.toContain("情节推进");
    expect(normalizeReviewDimension("文风")).toBe("文笔");
  });

  it("keeps the model text when a second try still is not JSON", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-review-raw-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "夜港",
        oneLine: "会计",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
      },
    });
    let calls = 0;
    const llm: AuthoringLlmFn = async () => {
      calls += 1;
      return "完全不是报告";
    };
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm };
    const draft = await generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      title: "雨",
      llm: async () => "很短的一段。",
    });
    const report = await reviewChapterDraft({ ...ctx, artifactId: draft.artifactId });
    expect(calls).toBe(2);
    expect(report.incomplete).toBe(true);
    expect(report.rawExcerpt).toContain("完全不是报告");
    expect(report.issues.some((issue) => issue.issueId === "check-length")).toBe(true);
    expect(report.summary).toContain("原文附在下面");
    const parsed = parseReviewPayload("{}", {
      stage: "write",
      targetRefs: ["a"],
      coverage: "chapter:1",
      model: "m",
    });
    expect(parsed.incomplete).toBe(true);
    expect(parsed.summary).toContain("不完整");
  });
});
