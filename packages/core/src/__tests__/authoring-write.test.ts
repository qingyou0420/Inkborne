import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import { assembleAuthoringContext } from "../authoring/context.js";
import { persistAdoptedChapter } from "../authoring/chapter-index.js";
import { pickSettingsByMention } from "../authoring/serial-ledger.js";
import { loadManifest, loadReport, saveManifest } from "../authoring/store.js";
import type { AuthoringLlmFn } from "../authoring/types.js";
import { BookWriteLockError, StateManager } from "../state/manager.js";

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
      },
    });
    await mkdir(join(created.bookDir, "story", "settings"), { recursive: true });
    await writeFile(join(created.bookDir, "story", "settings", "index.json"), JSON.stringify({
      categories: ["规则"],
      entries: [{ id: "rule", category: "规则", name: "铁律", file: "story/settings/rule.md", adoptedArtifactId: "g1" }],
    }), "utf-8");
    await writeFile(join(created.bookDir, "story", "settings", "rule.md"), "MARK-SETTING-R7 魔法有代价。\n", "utf-8");
    await mkdir(join(created.bookDir, "story", "outline"), { recursive: true });
    await writeFile(join(created.bookDir, "story", "outline", "volume_map.md"), "## 第 1 章 雨\n\nMARK-OUTLINE-R7 港口开场。\n", "utf-8");
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

  it("keeps the book locked, writes the chapter set together, and records review status", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-lock-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "锁",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
      },
    });
    const ctx = {
      root: { projectRoot: root, bookId: created.bookId },
      project: project(),
      llm: (async () => "# 第1章\n短。") as AuthoringLlmFn,
    };
    const draft = await generateChapterDraft({ ...ctx, chapterNumber: 1, title: "锁" });
    expect(draft.lengthNote).toContain("3000");
    const release = await new StateManager(root).acquireBookLock(created.bookId, { stage: "测试", taskId: "hold" }, { waitMs: 0 });
    await expect(adoptChapterDraft({ ...ctx, artifactId: draft.artifactId })).rejects.toBeInstanceOf(BookWriteLockError);
    await expect(adoptChapterDraft({ ...ctx, artifactId: draft.artifactId })).rejects.toMatchObject({ code: "BOOK_BUSY" });
    await release();
    const blocked = await reviewChapterDraft({
      ...ctx,
      artifactId: draft.artifactId,
      llm: async () => JSON.stringify({
        summary: "必须改",
        coverage: "chapter:1",
        issues: [{ issueId: "p1", title: "人设崩了", severity: "priority", suggestion: "改回原来的脾气" }],
      }),
    });
    const adopted = await adoptChapterDraft({
      ...ctx,
      artifactId: draft.artifactId,
      llm: async (call) => {
        const text = call.messages.map((message) => message.content).join("\n");
        if (text.includes("整理人物状态")) {
          return JSON.stringify({
            summary: "他仍拿着残页。",
            characters: [{ name: "沈砚", status: "拿着残页" }],
            openHooks: [],
            advanceHooks: [],
            resolveHooks: [],
          });
        }
        return "# 第1章\n短。";
      },
    });
    expect(adopted.settled).toBe(true);
    expect(adopted.lengthNote).toContain("3000");
    const index = JSON.parse(await readFile(join(created.bookDir, "chapters", "index.json"), "utf-8")) as Array<{
      status: string;
      auditIssues: string[];
    }>;
    expect(index[0]?.status).toBe("ready-for-review");
    expect(index[0]?.auditIssues.some((line) => line.startsWith("[critical] 审稿:"))).toBe(true);
    expect(blocked.reportId).toBeTruthy();
    const ledger = await readFile(join(created.bookDir, "story", "state", "serial-ledger.json"), "utf-8");
    expect(ledger).toContain("拿着残页");
    const manifest = await loadManifest(ctx.root);
    expect(manifest.adopted.write["1"]).toBe(draft.artifactId);

    await mkdir(join(created.bookDir, "chapters"), { recursive: true });
    const before = await readFile(join(created.bookDir, "chapters", "0001_锁.md"), "utf-8");
    await expect(persistAdoptedChapter({
      bookDir: created.bookDir,
      chapterNumber: 1,
      title: "锁",
      body: "NEW_BODY_SHOULD_NOT_LAND",
      renameFile: async (from, to) => {
        const normalized = from.replace(/\\/g, "/");
        const staged = normalized.includes("/staged/") && to.replace(/\\/g, "/").endsWith("chapters/index.json");
        if (staged) throw new Error("disk full");
        await rename(from, to);
      },
    })).rejects.toThrow(/disk full/);
    expect(await readFile(join(created.bookDir, "chapters", "0001_锁.md"), "utf-8")).toBe(before);
    const restored = JSON.parse(await readFile(join(created.bookDir, "chapters", "index.json"), "utf-8")) as Array<{ status: string }>;
    expect(restored[0]?.status).toBe("ready-for-review");
  });

  it("carries hooks and summaries forward, and prefers a mentioned setting over the front of a long catalog", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-memory-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "夜港",
        oneLine: "会计",
        proposition: "MARK-ONCE",
        protagonist: "沈砚",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
      },
    });
    const filler = Array.from({ length: 12 }, (_, index) => `### 条目${index}\n${"设定".repeat(400)}`).join("\n\n");
    const settings = `${filler}\n\n### 夜港铁律\n魔法有代价。`;
    expect(settings.length).toBeGreaterThan(8000);
    expect(pickSettingsByMention(settings, { texts: ["这一章要写到夜港铁律"] })).toMatch(/^### 夜港铁律/);
    await mkdir(join(created.bookDir, "story", "settings"), { recursive: true });
    await writeFile(join(created.bookDir, "story", "settings", "index.json"), JSON.stringify({
      categories: ["规则"],
      entries: [{ id: "rule", category: "规则", name: "夜港铁律", file: "story/settings/rule.md", adoptedArtifactId: "g1" }],
    }), "utf-8");
    await writeFile(join(created.bookDir, "story", "settings", "rule.md"), settings, "utf-8");
    await mkdir(join(created.bookDir, "story", "outline"), { recursive: true });
    await writeFile(join(created.bookDir, "story", "outline", "volume_map.md"), "## 第 2 章 铁律\n\n写到夜港铁律。\n", "utf-8");
    const prompts: string[] = [];
    const llm: AuthoringLlmFn = async (call) => {
      const text = call.messages.map((message) => message.content).join("\n");
      prompts.push(text);
      if (text.includes("整理人物状态")) {
        return JSON.stringify({
          summary: "沈砚把玉佩藏进账本。",
          characters: [{ name: "沈砚", status: "藏着玉佩" }],
          openHooks: [{ id: "jade", label: "没有署名的玉佩", note: "第1章埋下" }],
          advanceHooks: [],
          resolveHooks: [],
        });
      }
      if (text.includes("撰写第 2 章")) return "# 第2章\n铁律应验。";
      return `# 第1章\nPREV_TAIL_UNIQUE 雨停了。`;
    };
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm };
    const first = await generateChapterDraft({ ...ctx, chapterNumber: 1, title: "雨" });
    await adoptChapterDraft({ ...ctx, artifactId: first.artifactId });
    await generateChapterDraft({ ...ctx, chapterNumber: 2, title: "铁律" });
    const prompt = prompts.find((text) => text.includes("撰写第 2 章"));
    expect(prompt).toBeTruthy();
    expect(prompt!.match(/MARK-ONCE/g)).toHaveLength(1);
    expect(prompt!.match(/【上一章结尾】/g)).toHaveLength(1);
    expect(prompt!.match(/PREV_TAIL_UNIQUE/g)).toHaveLength(1);
    expect(prompt).toContain("本章目标约 3000 字");
    expect(prompt).toContain("夜港铁律");
    expect(prompt).toContain("没有署名的玉佩");
    expect(prompt).toContain("第 1 章埋下");

    const chapters = Array.from({ length: 29 }, (_, index) => {
      const chapter = index + 1;
      return {
        chapter,
        artifactId: `art-${chapter}`,
        title: `题${chapter}`,
        summary: chapter === 5 ? "第五章埋下了没有署名的玉佩。" : `第${chapter}章平常。`,
        characters: [],
        openHooks: chapter === 5 ? [{ id: "jade-5", label: "没有署名的玉佩", note: "第5章埋下" }] : [],
        advanceHookIds: [],
        resolveHookIds: [],
      };
    });
    await mkdir(join(created.bookDir, "story", "state"), { recursive: true });
    await writeFile(join(created.bookDir, "story", "state", "serial-ledger.json"), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      chapters,
    }), "utf-8");
    const manifest = await loadManifest(ctx.root);
    await saveManifest(ctx.root, {
      ...manifest,
      adopted: {
        ...manifest.adopted,
        write: Object.fromEntries(chapters.map((chapter) => [String(chapter.chapter), chapter.artifactId])),
      },
    });
    const chapter30 = await assembleAuthoringContext(ctx.root, { stage: "write", chapterNumber: 30 });
    expect(chapter30.text).toContain("没有署名的玉佩（第 5 章埋下）");
    expect(chapter30.text).toContain("第 25 章");
    expect(chapter30.text).not.toContain("第1章平常");

    await saveManifest(ctx.root, {
      ...manifest,
      adopted: { ...manifest.adopted, write: { "5": "someone-else" } },
    });
    await writeFile(join(created.bookDir, "story", "current_state.md"), "LEGACY_MARK 旧状态\n", "utf-8");
    const stale = await assembleAuthoringContext(ctx.root, { stage: "write", chapterNumber: 30 });
    expect(stale.text).not.toContain("没有署名的玉佩");
    expect(stale.text).not.toContain("LEGACY_MARK");
  });

  it("reads the old state files when a book has no rolling ledger yet", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-legacy-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "旧书",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
      },
    });
    await mkdir(join(created.bookDir, "story", "state"), { recursive: true });
    await writeFile(join(created.bookDir, "story", "current_state.md"), "LEGACY_MARK 他在书院。\n", "utf-8");
    await writeFile(join(created.bookDir, "story", "state", "hooks.json"), JSON.stringify({
      hooks: [{
        hookId: "旧玉佩",
        startChapter: 5,
        type: "伏笔",
        status: "open",
        lastAdvancedChapter: 5,
        expectedPayoff: "没有署名的玉佩",
        notes: "",
      }],
    }), "utf-8");
    await writeFile(join(created.bookDir, "story", "state", "chapter_summaries.json"), JSON.stringify({
      rows: [{
        chapter: 5,
        title: "书院",
        characters: "",
        events: "第五章埋下玉佩",
        stateChanges: "",
        hookActivity: "",
        mood: "",
        chapterType: "",
      }],
    }), "utf-8");
    const text = await assembleAuthoringContext(
      { projectRoot: root, bookId: created.bookId },
      { stage: "write", chapterNumber: 30 },
    );
    expect(text.text).toContain("LEGACY_MARK");
    expect(text.text).toContain("没有署名的玉佩");
    expect(text.text).toContain("第五章埋下玉佩");
  });
});
