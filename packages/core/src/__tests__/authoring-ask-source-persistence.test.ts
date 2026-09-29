// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAskCanon, reviewAskCanon, reviseAskCanon, adoptAskCanon } from "../authoring/stages/ask.js";
import { authoringRootDir, saveArtifact } from "../authoring/store.js";
import { serializeCanon } from "../authoring/canon.js";
import { ProjectConfigSchema } from "../models/project.js";
import type { AuthoringLlmCall, AuthoringLlmFn, CanonDocument } from "../authoring/types.js";

const canon: CanonDocument = {
  title: "渡口旧约", genre: "古风", targetChapters: 80, chapterWordCount: 3000,
  oneLine: "船女寻找失散的亲人。", proposition: "守约与自由能否两全。",
  protagonist: "阿渡想找回弟弟并保住渡船。", conflict: "封河令与渡人承诺相撞。",
  voice: "以阿渡的观察为主。", boundaries: "结局保留开放。",
  direction: "从封河令传到渡口开始。", openQuestions: [],
};
const original = `AUTHOR_BEGIN_渡船女的弟弟不能被擅自改成丈夫。\n${"作者讨论已定人物关系与渡口事件。".repeat(900)}\nAUTHOR_END_必须保留封河、寻人、还船三段顺序。`;

describe("Ask operations retain their author's persistent source", () => {
  let projectRoot: string;
  let calls: AuthoringLlmCall[];
  const project = ProjectConfigSchema.parse({
    name: "source-test", version: "0.1.0",
    llm: { provider: "custom", model: "synthetic-main", baseUrl: "https://unused.invalid/v1", apiKey: "synthetic" },
    authoringRoles: { "ask.main": { modelId: "synthetic-main" }, "ask.review": { modelId: "synthetic-review" } },
  });
  const llm: AuthoringLlmFn = async (call) => {
    calls.push(call);
    if (call.roleId === "ask.review") return JSON.stringify({
      summary: "补充既定事件的因果。",
      issues: [{ issueId: "cause", title: "明确封河对渡人的影响", severity: "improve", suggestion: "依据原文补回渡人承诺，不改人物关系。" }],
    });
    return JSON.stringify(canon);
  };
  const prompt = (call: AuthoringLlmCall) => call.messages.map((message) => message.content).join("\n");
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "ask-source-"));
    calls = [];
  });
  afterEach(async () => { await rm(projectRoot, { recursive: true, force: true }); });

  it("carries the first complete draft conversation into empty-chat review and revision without persisting task instructions", async () => {
    const root = { projectRoot, draftId: "first-draft" };
    const ctx = { root, project, llm };
    const generated = await generateAskCanon({ ...ctx, conversation: original, requirements: "SYSTEM_ONLY_输出格式约束不属于小说边界" });
    const report = await reviewAskCanon({ ...ctx, artifactId: generated.artifactId, conversation: "" });
    await reviseAskCanon({ ...ctx, artifactId: generated.artifactId, reportId: report.reportId, selectedIssueIds: ["cause"] });
    expect(calls.map((call) => call.roleId)).toEqual(["ask.main", "ask.review", "ask.main"]);
    for (const call of calls) {
      expect(prompt(call)).toContain(original);
      expect(prompt(call)).toContain("较新对话中作者明确作出的修改优先于旧约定");
      expect(prompt(call)).toContain("助手建议和审查意见不等于作者定案");
      expect(prompt(call)).toContain("不能自动变成小说的故事边界");
    }
    const saved = await readFile(join(authoringRootDir(root), "source-conversation.md"), "utf-8");
    expect(saved).toBe(original);
    expect(saved).not.toContain("SYSTEM_ONLY_");
    expect(report.inputRefs).toContainEqual({ kind: "author-source", id: "source-conversation.md" });
  });

  it("includes short follow-ups beside the original source and never replaces that original", async () => {
    const root = { projectRoot, draftId: "followups" };
    const ctx = { root, project, llm };
    const first = await generateAskCanon({ ...ctx, conversation: original });
    const correction = "AUTHOR_CORRECTION_船女姓名由阿渡改成阿澜，其他已定内容不变。";
    const second = await generateAskCanon({ ...ctx, conversation: correction });
    const report = await reviewAskCanon({ ...ctx, artifactId: second.artifactId, conversation: correction });
    await reviseAskCanon({ ...ctx, artifactId: second.artifactId, reportId: report.reportId, selectedIssueIds: ["cause"], conversation: correction });
    expect(first.artifactId).not.toBe(second.artifactId);
    for (const call of calls.slice(1)) {
      expect(prompt(call)).toContain(original);
      expect(prompt(call)).toContain(correction);
    }
    expect(await readFile(join(authoringRootDir(root), "source-conversation.md"), "utf-8")).toBe(original);
    const emptyChatReport = await reviewAskCanon({ ...ctx, artifactId: second.artifactId, conversation: "" });
    await reviseAskCanon({ ...ctx, artifactId: second.artifactId, reportId: emptyChatReport.reportId, selectedIssueIds: ["cause"], conversation: "" });
    for (const call of calls.slice(-2)) {
      expect(prompt(call)).toContain(original);
      expect(prompt(call)).toContain(correction);
    }
    expect(await readdir(join(authoringRootDir(root), "source-conversations"))).toHaveLength(1);
  });

  it.each(["author_intent.md", "brief.md"] as const)(
    "reads the entire book %s for generation, review, and revision even after moving to an empty or short conversation",
    async (sourceName) => {
      const root = { projectRoot, bookId: "existing-book" };
      const story = join(projectRoot, "books", root.bookId, "story");
      await mkdir(story, { recursive: true });
      await writeFile(join(story, sourceName), original, "utf-8");
      const ctx = { root, project, llm };
      const generated = await generateAskCanon({ ...ctx, conversation: "" });
      const report = await reviewAskCanon({ ...ctx, artifactId: generated.artifactId });
      const correction = "AUTHOR_NEW_SESSION_保留角色关系，只补封河之后的行动。";
      await reviseAskCanon({ ...ctx, artifactId: generated.artifactId, reportId: report.reportId, selectedIssueIds: ["cause"], conversation: correction });
      for (const call of calls) expect(prompt(call)).toContain(original);
      expect(prompt(calls[2]!)).toContain(correction);
      expect(report.inputRefs).toContainEqual({ kind: "author-source", id: `story/${sourceName}` });
      expect(await readFile(join(story, sourceName), "utf-8")).toBe(original);
      const laterReport = await reviewAskCanon({ ...ctx, artifactId: generated.artifactId, conversation: "" });
      await reviseAskCanon({ ...ctx, artifactId: generated.artifactId, reportId: laterReport.reportId, selectedIssueIds: ["cause"] });
      for (const call of calls.slice(-2)) {
        expect(prompt(call)).toContain(original);
        expect(prompt(call)).toContain(correction);
      }
    },
  );

  it("deduplicates identical book source documents but retains distinct material", async () => {
    const root = { projectRoot, bookId: "duplicates" };
    const story = join(projectRoot, "books", root.bookId, "story");
    await mkdir(story, { recursive: true });
    await writeFile(join(story, "author_intent.md"), original, "utf-8");
    await writeFile(join(story, "brief.md"), original, "utf-8");
    await generateAskCanon({ root, project, llm, conversation: original });
    expect(prompt(calls[0]!).split("AUTHOR_BEGIN_")).toHaveLength(2);
    const supplement = "BRIEF_ONLY_还船之前必须先解除渡口封锁。";
    await writeFile(join(story, "brief.md"), supplement, "utf-8");
    await generateAskCanon({ root, project, llm, conversation: "" });
    expect(prompt(calls[1]!)).toContain(original);
    expect(prompt(calls[1]!)).toContain(supplement);
  });

  it("recovers the linked draft's original text after lightweight adoption into a book", async () => {
    const root = { projectRoot, draftId: "linked-draft" };
    await generateAskCanon({ root, project, llm, conversation: original });
    const priorCorrection = "DRAFT_CORRECTION_弟弟改叫阿舟，其余关系不改。";
    const generated = await generateAskCanon({ root, project, llm, conversation: priorCorrection });
    const adopted = await adoptAskCanon({ root, project, artifactId: generated.artifactId });
    const bookRoot = { projectRoot, bookId: adopted.bookId };
    const report = await reviewAskCanon({ root: bookRoot, project, llm, artifactId: generated.artifactId, conversation: "" });
    expect(prompt(calls[2]!)).toContain(original);
    expect(prompt(calls[2]!)).toContain(priorCorrection);
    expect(report.inputRefs).toContainEqual({ kind: "author-source", id: "draft:linked-draft/source-conversation.md" });
    const bookCorrection = "BOOK_CORRECTION_阿舟改为阿川，这是作者最新决定。";
    await reviseAskCanon({ root: bookRoot, project, llm, artifactId: generated.artifactId, reportId: report.reportId, selectedIssueIds: ["cause"], conversation: bookCorrection });
    await reviewAskCanon({ root: bookRoot, project, llm, artifactId: generated.artifactId, conversation: "" });
    const restoredPrompt = prompt(calls.at(-1)!);
    expect(restoredPrompt).toContain(original);
    expect(restoredPrompt.indexOf(priorCorrection)).toBeGreaterThan(restoredPrompt.indexOf(original));
    expect(restoredPrompt.indexOf(bookCorrection)).toBeGreaterThan(restoredPrompt.indexOf(priorCorrection));
  });

  it("retains an explicit A to B to A reversal and skips only consecutive duplicate snapshots", async () => {
    const root = { projectRoot, draftId: "return-to-original" };
    const ctx = { root, project, llm };
    const correction = "DECISION_B_结局由开放改为团聚。";
    await generateAskCanon({ ...ctx, conversation: original });
    await generateAskCanon({ ...ctx, conversation: correction });
    await generateAskCanon({ ...ctx, conversation: original });
    const latest = await generateAskCanon({ ...ctx, conversation: original });
    const report = await reviewAskCanon({ ...ctx, artifactId: latest.artifactId, conversation: "" });
    await reviseAskCanon({ ...ctx, artifactId: latest.artifactId, reportId: report.reportId, selectedIssueIds: ["cause"], conversation: "" });
    for (const call of calls.slice(-2)) {
      const text = prompt(call);
      expect(text.indexOf(original)).toBeLessThan(text.indexOf(correction));
      expect(text.lastIndexOf(original)).toBeGreaterThan(text.indexOf(correction));
    }
    expect(await readdir(join(authoringRootDir(root), "source-conversations"))).toHaveLength(2);
    expect(await readFile(join(authoringRootDir(root), "source-conversation.md"), "utf-8")).toBe(original);
  });

  it("retains explicit revision requirements when later review and revision have no conversation", async () => {
    const root = { projectRoot, draftId: "revision-requirements" };
    const ctx = { root, project, llm };
    const generated = await generateAskCanon({ ...ctx, conversation: original });
    const firstReport = await reviewAskCanon({ ...ctx, artifactId: generated.artifactId });
    const requirement = "EXPLICIT_REVISION_作者决定结尾新增一次渡口重逢，姓名与亲属关系不变。";
    await reviseAskCanon({ ...ctx, artifactId: generated.artifactId, reportId: firstReport.reportId, selectedIssueIds: ["cause"], conversation: original, extraRequirement: requirement });
    // Re-sending the unchanged complete chat must not move old decisions after
    // a newer explicit correction submitted in the revision form.
    await reviewAskCanon({ ...ctx, artifactId: generated.artifactId, conversation: original });
    const report = await reviewAskCanon({ ...ctx, artifactId: generated.artifactId, conversation: "" });
    await reviseAskCanon({ ...ctx, artifactId: generated.artifactId, reportId: report.reportId, selectedIssueIds: ["cause"], conversation: "" });
    for (const call of calls.slice(-3)) {
      const text = prompt(call);
      expect(text).toContain(requirement);
      expect(text.lastIndexOf(original)).toBeLessThan(text.indexOf(requirement));
    }
    expect(await readdir(join(authoringRootDir(root), "source-conversations"))).toHaveLength(1);
  });

  it("persists an explicit generation authorRequirement while keeping mixed system requirements transient", async () => {
    const root = { projectRoot, bookId: "explicit-generation" };
    const requirement = "EXPLICIT_GENERATION_作者决定以春汛作为最后一次渡河的时节。";
    const generated = await generateAskCanon({
      root, project, llm, conversation: original,
      authorRequirement: requirement,
      requirements: "SYSTEM_TRANSIENT_格式检查使用JSON，不是故事边界。",
    });
    await reviewAskCanon({ root, project, llm, artifactId: generated.artifactId, conversation: "" });
    expect(prompt(calls[1]!)).toContain(original);
    expect(prompt(calls[1]!)).toContain(requirement);
    expect(prompt(calls[1]!)).not.toContain("SYSTEM_TRANSIENT_");
    const records = await readdir(join(authoringRootDir(root), "source-conversations"));
    expect(records).toHaveLength(2);
    for (const file of records) {
      expect(await readFile(join(authoringRootDir(root), "source-conversations", file), "utf-8")).not.toContain("SYSTEM_TRANSIENT_");
    }
  });

  it("does not save an empty first conversation over a later real source", async () => {
    const root = { projectRoot, draftId: "empty-first" };
    await saveArtifact(root, {
      artifactId: "existing", stage: "ask", scope: "canon", version: 1,
      source: "hand", status: "candidate", bodyPath: "artifacts/existing/body.md",
      inputRefs: [], createdAt: new Date().toISOString(),
    }, serializeCanon(canon));
    await reviewAskCanon({ root, project, llm, artifactId: "existing", conversation: "   " });
    await expect(readFile(join(authoringRootDir(root), "source-conversation.md"), "utf-8")).rejects.toThrow();
    await generateAskCanon({ root, project, llm, conversation: original });
    expect(await readFile(join(authoringRootDir(root), "source-conversation.md"), "utf-8")).toBe(original);
  });
});
