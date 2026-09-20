import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import { createLightweightBook } from "../authoring/book-create.js";
import { adoptAskCanon, generateAskCanon, reviewAskCanon, reviseAskCanon } from "../authoring/stages/ask.js";
import { loadArtifact, saveHandEditedArtifact } from "../authoring/store.js";
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
      model: "ask-main",
      apiKey: "sk",
      temperature: 0.7,
      thinkingBudget: 0,
      apiFormat: "chat",
      stream: true,
    },
    authoringRoles: {
      "ask.main": { modelId: "ask-main", serviceRef: "zenmux" },
      "ask.review": { modelId: "ask-review", serviceRef: "zenmux" },
    },
  });
}

describe("ask stage", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("generates, reviews, revises, and adopts a canon into one book", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-ask-"));
    const seen: string[] = [];
    const llm: AuthoringLlmFn = async (call) => {
      seen.push(call.roleId);
      if (call.roleId === "ask.review") {
        return JSON.stringify({
          summary: "冲突还可以更清楚",
          coverage: "全文",
          issues: [{
            issueId: "i1",
            title: "冲突需收束",
            severity: "priority",
            suggestion: "写明救人与自保的不可兼得",
          }],
        });
      }
      if (call.messages.some((message) => message.content.includes("按选中的审查意见"))) {
        return JSON.stringify({
          title: "夜港账本",
          oneLine: "会计找回账本",
          proposition: "记忆有代价",
          protagonist: "沈砚",
          conflict: "救人与自保不可兼得",
          voice: "限制视角",
          boundaries: "开放结局",
          direction: "港口",
          openQuestions: [],
          targetChapters: 12,
          chapterWordCount: 2000,
        });
      }
      return JSON.stringify({
        title: "夜港账本",
        oneLine: "会计找回账本",
        proposition: "记忆有代价",
        protagonist: "沈砚",
        conflict: "救人还是自保",
        voice: "限制视角",
        boundaries: "开放结局",
        direction: "港口",
        openQuestions: ["结局"],
        targetChapters: 12,
        chapterWordCount: 2000,
      });
    };
    const ctx = { root: { projectRoot: root, draftId: "d1" }, project: project(), llm };
    const generated = await generateAskCanon({
      ...ctx,
      conversation: "我想写一个港口会计找回失踪账本的故事。",
    });
    const report = await reviewAskCanon({ ...ctx, artifactId: generated.artifactId });
    expect(report.actualReviewModel).toBe("ask-review");
    const revised = await reviseAskCanon({
      ...ctx,
      artifactId: generated.artifactId,
      reportId: report.reportId,
      selectedIssueIds: ["i1"],
    });
    const adopted = await adoptAskCanon({ ...ctx, artifactId: revised.artifactId });
    expect(adopted.created).toBe(true);
    const again = await adoptAskCanon({
      ...ctx,
      root: { projectRoot: root, draftId: "d1" },
      artifactId: revised.artifactId,
    });
    // second adopt without bookId still hits the same title and does not duplicate
    expect(again.bookId).toBe(adopted.bookId);
    const canon = await readFile(join(root, "books", adopted.bookId, "story", "canon.md"), "utf-8");
    expect(canon).toContain("不可兼得");
    expect(seen.filter((id) => id === "ask.review")).toHaveLength(1);
    expect(seen.some((id) => id === "ground.main")).toBe(false);
  });

  it("sends the saved candidate as the update base and versions from the parent (R7-05)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r7-05-"));
    const seen: string[] = [];
    let round = 0;
    const llm: AuthoringLlmFn = async (call) => {
      seen.push(call.messages.map((message) => message.content).join("\n"));
      round += 1;
      return JSON.stringify({
        title: "夜港账本",
        oneLine: "会计找回账本",
        proposition: "记忆有代价",
        protagonist: round === 1 ? "沈砚" : "沈砚有妹妹",
        conflict: "救人还是自保",
        voice: "限制视角",
        boundaries: round === 1 ? "开放结局" : "HAND_BOUNDARY_R7_所有角色都不能复活",
        direction: "港口",
        openQuestions: [],
      });
    };
    const ctx = { root: { projectRoot: root, draftId: "d-update" }, project: project(), llm };
    const generated = await generateAskCanon({
      ...ctx,
      conversation: "港口会计找回账本",
    });
    const loaded = await loadArtifact(ctx.root, generated.artifactId);
    const edited = `${loaded!.body.replace("开放结局", "HAND_BOUNDARY_R7_所有角色都不能复活")}\n`;
    const saved = await saveHandEditedArtifact(ctx.root, generated.artifactId, edited);
    const updated = await generateAskCanon({
      ...ctx,
      conversation: "主角有妹妹",
    });
    expect(updated.version).toBe(saved.version + 1);
    const meta = await loadArtifact(ctx.root, updated.artifactId);
    expect(meta?.meta.parentArtifactId).toBe(saved.artifactId);
    expect(seen.at(-1)).toContain("HAND_BOUNDARY_R7_所有角色都不能复活");
    expect(seen.at(-1)).toContain("主角有妹妹");
    expect(seen.at(-1)).toContain("保留作者已手改的字段");
  });

  it("syncs book.json when adopting canon on an existing book (R7-06)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r7-06-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "旧名",
        genre: "现实",
        targetChapters: 8,
        chapterWordCount: 2000,
        oneLine: "旧一句",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
      },
    });
    const llm: AuthoringLlmFn = async () => JSON.stringify({
      title: "新名",
      genre: "悬疑",
      targetChapters: 12,
      chapterWordCount: 3000,
      oneLine: "新一句",
      proposition: "",
      protagonist: "",
      conflict: "",
      voice: "",
      boundaries: "",
      direction: "",
      openQuestions: [],
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm };
    const generated = await generateAskCanon({ ...ctx, conversation: "改设定" });
    const adopted = await adoptAskCanon({ ...ctx, artifactId: generated.artifactId });
    expect(adopted.created).toBe(false);
    const book = JSON.parse(await readFile(join(created.bookDir, "book.json"), "utf-8")) as {
      title: string;
      genre: string;
      targetChapters: number;
      chapterWordCount: number;
    };
    expect(book.title).toBe("新名");
    expect(book.genre).toBe("悬疑");
    expect(book.targetChapters).toBe(12);
    expect(book.chapterWordCount).toBe(3000);
    const canon = await readFile(join(created.bookDir, "story", "canon.md"), "utf-8");
    expect(canon).toContain("新名");
  });
});
