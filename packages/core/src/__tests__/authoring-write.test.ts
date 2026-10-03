import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import { createLightweightBook } from "../authoring/book-create.js";
import {
  adoptChapterDraft,
  bindRestoredChapterUnlocked,
  generateChapterDraft as generateChapterDraftCore,
  requestWriteRunCancel,
  SavedPartialDraftError,
  reviewChapterDraft,
  reviseChapterDraft,
  settleAdoptedChapter,
  settleBodySegments,
  settleCoverageComplete,
} from "../authoring/stages/write.js";
import { assembleAuthoringContext, listChapterStateRefs, loadOutlineText, serializeCanonBrief } from "../authoring/context.js";
import { adoptWeave, generateWeaveRange, generateWeaveStructure, resolveWeaveTargetChapters } from "../authoring/stages/weave.js";
import { findChapterNode, parseVolumeMapTree } from "../utils/volume-map-tree.js";
import { persistAdoptedChapter } from "../authoring/chapter-index.js";
import { foldSerialLedger, loadSerialLedger, loadWriteMemory, pickSettingsByMention } from "../authoring/serial-ledger.js";
import { AuthoringRunCancelledError, listRuns, loadArtifact, loadManifest, loadReport, loadRun, newRunId, saveHandEditedArtifact, saveManifest, saveReport, saveRunControl } from "../authoring/store.js";
import { listChapterVersions, readChapterVersion } from "../state/chapter-workspace.js";
import { withBookWriteLock } from "../authoring/book-lock.js";
import { autosaveChapterBody } from "../authoring/chapter-index.js";
import type { AuthoringLlmFn } from "../authoring/types.js";
import {
  ageInProcessBookLockForTest,
  BookWriteLockError,
  resetProcessBookLocksForTest,
  setBookLockLivenessCheck,
  StateManager,
} from "../state/manager.js";

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

async function ensureAdoptedChapterPlan(
  root: { projectRoot: string; bookId?: string },
  project: ReturnType<typeof project>,
  chapterNumber: number,
) {
  if (!root.bookId) return;
  const manifest = await loadManifest(root);
  if (!manifest.adopted.weave) {
    const structured = await generateWeaveStructure({
      root,
      project,
      llm: async () => JSON.stringify({
        bookOutline: "测试结构",
        volumes: [{ volumeNumber: 1, title: "测试卷", startChapter: 1, endChapter: await resolveWeaveTargetChapters(root), body: "测试卷目标" }],
      }),
    });
    await adoptWeave({ root, project, artifactId: structured.artifactId });
  }
  const outline = await loadOutlineText(root);
  const node = findChapterNode(parseVolumeMapTree(outline), chapterNumber);
  if (node?.summary?.trim() && node.summary.trim() !== "（待补概要）") return;
  const planned = await generateWeaveRange({
    root,
    project,
    startChapter: chapterNumber,
    endChapter: chapterNumber,
    llm: async () => JSON.stringify({
      chapters: [{ chapterNumber, title: `第${chapterNumber}章`, summary: "测试章概要，含视角地点冲突转折。" }],
    }),
  });
  await adoptWeave({ root, project, artifactId: planned.artifactId });
}

async function generateChapterDraft(input: Parameters<typeof generateChapterDraftCore>[0]) {
  await ensureAdoptedChapterPlan(input.root, input.project, input.chapterNumber);
  return generateChapterDraftCore(input);
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
        targetChapters: 12,
        chapterWordCount: 3000,
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
    expect(serializeCanonBrief({
      title: "夜港", oneLine: "会计", proposition: "", protagonist: "沈砚", conflict: "",
      voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 4, chapterWordCount: 3000,
    })).toContain("每章字数：3000");
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
        targetChapters: 12,
        chapterWordCount: 3000,
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
        targetChapters: 12,
        chapterWordCount: 3000,
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
        targetChapters: 12,
        chapterWordCount: 3000,
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
    expect(prompt).toContain("命题：MARK-ONCE");
    expect(prompt).toContain("## 核心命题");
    expect(prompt!.match(/MARK-ONCE/g)).toHaveLength(2);
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
    expect(stale.text).toContain("LEGACY_MARK");
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
        targetChapters: 12,
        chapterWordCount: 3000,
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

  it("merges old-book memory by chapter number and skips a stale ledger chapter", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-merge-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "醉词",
        oneLine: "旧书",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 12,
        chapterWordCount: 3000,
      },
    });
    await mkdir(join(created.bookDir, "story", "state"), { recursive: true });
    await writeFile(join(created.bookDir, "story", "current_state.md"), "OLD_CAST 他还在书院。\n", "utf-8");
    await writeFile(join(created.bookDir, "story", "state", "hooks.json"), JSON.stringify({
      hooks: [{
        hookId: "old-jade",
        startChapter: 12,
        type: "伏笔",
        status: "open",
        lastAdvancedChapter: 12,
        expectedPayoff: "旧书伏笔玉佩",
        notes: "",
      }],
    }), "utf-8");
    await writeFile(join(created.bookDir, "story", "state", "serial-ledger.json"), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      chapters: [
        {
          chapter: 10,
          artifactId: "stale-alive",
          title: "错章",
          summary: "ALIVE_GONE 不该出现",
          characters: [{ name: "错人", status: "ALIVE_GONE" }],
          openHooks: [],
          advanceHookIds: [],
          resolveHookIds: [],
        },
        {
          chapter: 260,
          artifactId: "art-260",
          title: "新章",
          summary: "LEDGER_260 刚采用的一段。",
          characters: [{ name: "沈砚", status: "刚出书院" }],
          openHooks: [],
          advanceHookIds: [],
          resolveHookIds: [],
        },
      ],
    }), "utf-8");
    await saveManifest({ projectRoot: root, bookId: created.bookId }, {
      ...(await loadManifest({ projectRoot: root, bookId: created.bookId })),
      adopted: { ground: [], write: { "10": "someone-else", "260": "art-260" } },
    });
    const text = await assembleAuthoringContext(
      { projectRoot: root, bookId: created.bookId },
      { stage: "write", chapterNumber: 261 },
    );
    expect(text.text).toContain("OLD_CAST");
    expect(text.text).toContain("旧书伏笔玉佩");
    expect(text.text).toContain("LEDGER_260");
    expect(text.text).toContain("刚出书院");
    expect(text.text).not.toContain("ALIVE_GONE");
  });

  it("holds the authoring lock past 8 seconds when Studio liveness does not know the stage", async () => {
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
        targetChapters: 12,
        chapterWordCount: 3000,
      },
    });
    const store = { projectRoot: root, bookId: created.bookId };
    setBookLockLivenessCheck(() => false);
    try {
      let entered = false;
      await withBookWriteLock(store, "落笔", async () => {
        expect(ageInProcessBookLockForTest(root, created.bookId, 9_000)).toBe(true);
        await expect(withBookWriteLock(store, "审查本章", async () => {
          entered = true;
        })).rejects.toBeInstanceOf(BookWriteLockError);
      });
      expect(entered).toBe(false);
    } finally {
      resetProcessBookLocksForTest();
    }
  });

  it("lets another save run while review is still waiting on the model", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-review-lock-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "审",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 12,
        chapterWordCount: 3000,
      },
    });
    const store = { projectRoot: root, bookId: created.bookId };
    const ctx = { root: store, project: project() };
    const draft = await generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      title: "雨",
      llm: async () => "正文",
    });
    let releaseModel: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    let entered = false;
    const llm: AuthoringLlmFn = async (call) => {
      if (call.roleId !== "write.review") return "正文";
      await withBookWriteLock(store, "保存手改", async () => {
        entered = true;
      });
      await gate;
      return JSON.stringify({
        summary: "可以",
        coverage: "chapter:1",
        issues: [],
      });
    };
    const pending = reviewChapterDraft({ ...ctx, artifactId: draft.artifactId, llm });
    for (let attempt = 0; attempt < 50 && !entered; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(entered).toBe(true);
    releaseModel();
    await pending;
  });

  it("overwrites the same hand-edited candidate instead of minting a new version", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-hand-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "手改",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 12,
        chapterWordCount: 3000,
      },
    });
    const store = { projectRoot: root, bookId: created.bookId };
    const draft = await generateChapterDraft({
      root: store,
      project: project(),
      chapterNumber: 4,
      title: "夜",
      llm: async () => "原稿",
    });
    const hand = await saveHandEditedArtifact(store, draft.artifactId, "手改一");
    const again = await saveHandEditedArtifact(store, hand.artifactId, "手改二");
    expect(again.artifactId).toBe(hand.artifactId);
    expect(again.version).toBe(hand.version);
    expect(hand.artifactId).not.toBe(draft.artifactId);
    const loaded = await loadArtifact(store, hand.artifactId);
    expect(loaded?.body).toContain("手改二");
  });

  it("stops adopt when an index entry cannot be parsed and leaves index.json untouched", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-index-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "目录",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 12,
        chapterWordCount: 3000,
      },
    });
    const indexPath = join(created.bookDir, "chapters", "index.json");
    await mkdir(join(created.bookDir, "chapters"), { recursive: true });
    const broken = "[{\"number\":12,\"title\":\"坏条目\"}]\n";
    await writeFile(indexPath, broken, "utf-8");
    await expect(persistAdoptedChapter({
      bookDir: created.bookDir,
      chapterNumber: 12,
      title: "坏条目",
      body: "新正文",
    })).rejects.toThrow(/没有改写 index.json/);
    expect(await readFile(indexPath, "utf-8")).toBe(broken);
  });

  it("matches a parenthetical setting name instead of the first 8000 characters", () => {
    const picked = pickSettingsByMention(
      `### 铁律（代价）\n${"甲".repeat(80)}\n\n### 无关长文\n${"乙".repeat(9000)}`,
      { texts: ["本章写到铁律"] },
      400,
    );
    expect(picked).toContain("铁律（代价）");
    expect(picked.includes("乙乙乙")).toBe(false);
  });

  it("keeps the original chapter recoverable after autosave and rolls later pauses into one file", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-autosave-"));
    const bookDir = join(root, "books", "old");
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await mkdir(join(bookDir, "story", "runtime"), { recursive: true });
    await writeFile(join(bookDir, "story", "runtime", "chapter-0008.plan.md"), "不要清掉\n", "utf-8");
    await writeFile(join(bookDir, "chapters", "0008_雨.md"), "旧正文\n", "utf-8");
    await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([{
      number: 8,
      title: "雨",
      status: "approved",
      wordCount: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }], null, 2), "utf-8");
    const started = new Date("2026-03-01T00:00:00.000Z");
    await autosaveChapterBody({
      bookDir,
      chapterNumber: 8,
      content: "第一次停笔",
      fresh: true,
      now: started,
    });
    await autosaveChapterBody({
      bookDir,
      chapterNumber: 8,
      content: "第二次停笔",
      now: new Date(started.getTime() + 5 * 60 * 1000),
    });
    const index = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8")) as Array<{ status: string; auditIssues: string[] }>;
    expect(index[0]?.status).toBe("approved");
    expect(index[0]?.auditIssues ?? []).toEqual([]);
    expect(await readFile(join(bookDir, "chapters", "0008_雨.md"), "utf-8")).toContain("第二次停笔");
    expect(await readFile(join(bookDir, "story", "runtime", "chapter-0008.plan.md"), "utf-8")).toContain("不要清掉");
    const versions = await listChapterVersions(bookDir, 8);
    expect(versions.map((version) => version.source)).toEqual(["autosave", "manual"]);
    const baseline = versions.find((version) => version.source === "manual");
    expect(baseline).toBeTruthy();
    expect(await readChapterVersion(bookDir, 8, baseline!.id)).toBe("旧正文\n");
    const autosave = versions.find((version) => version.source === "autosave");
    expect(await readChapterVersion(bookDir, 8, autosave!.id)).toContain("第二次停笔");
    await autosaveChapterBody({
      bookDir,
      chapterNumber: 8,
      content: "隔了一阵再改",
      now: new Date(started.getTime() + 11 * 60 * 1000),
    });
    const later = await listChapterVersions(bookDir, 8);
    expect(later.filter((version) => version.source === "autosave")).toHaveLength(2);
    expect(await readChapterVersion(bookDir, 8, baseline!.id)).toBe("旧正文\n");
    await autosaveChapterBody({
      bookDir,
      chapterNumber: 8,
      content: "重新打开后再改",
      fresh: true,
      now: new Date(started.getTime() + 12 * 60 * 1000),
    });
    const reopened = await listChapterVersions(bookDir, 8);
    expect(reopened.filter((version) => version.source === "autosave").length).toBeGreaterThan(2);
    expect(await readChapterVersion(bookDir, 8, baseline!.id)).toBe("旧正文\n");
  });

  it("does not write the chapter when adopt is aborted", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-abort-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "中止",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 12,
        chapterWordCount: 3000,
      },
    });
    const store = { projectRoot: root, bookId: created.bookId };
    const draft = await generateChapterDraft({
      root: store,
      project: project(),
      chapterNumber: 1,
      title: "夜",
      llm: async () => "不该落盘的正文",
    });
    await expect(adoptChapterDraft({
      root: store,
      project: project(),
      artifactId: draft.artifactId,
      llm: async () => {
        await new StateManager(root).forceReleaseBookLock(created.bookId, { graceMs: 0 });
        throw new Error("aborted");
      },
    })).rejects.toThrow("采用已中止，正文没有写入");
    const files = await readdir(join(created.bookDir, "chapters")).catch(() => [] as string[]);
    expect(files.some((file) => file.startsWith("0001") && file.endsWith(".md"))).toBe(false);
  });

  it("starts a new hand version after adopt and stale-marks the overwritten candidate report", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-hand-stale-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "手改过期",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 12,
        chapterWordCount: 3000,
      },
    });
    const store = { projectRoot: root, bookId: created.bookId };
    const draft = await generateChapterDraft({
      root: store,
      project: project(),
      chapterNumber: 4,
      title: "夜",
      llm: async () => "原稿",
    });
    const hand = await saveHandEditedArtifact(store, draft.artifactId, "手改一");
    await saveReport(store, {
      reportId: "rep-hand",
      stage: "write",
      targetRefs: [hand.artifactId],
      coverage: "chapter:4",
      inputRefs: [],
      actualReviewModel: "review-model",
      createdAt: new Date().toISOString(),
      summary: "先这样",
      issues: [],
      stale: false,
    });
    const again = await saveHandEditedArtifact(store, hand.artifactId, "手改二");
    expect(again.artifactId).toBe(hand.artifactId);
    expect((await loadReport(store, "rep-hand"))?.stale).toBe(true);
    await adoptChapterDraft({
      root: store,
      project: project(),
      artifactId: hand.artifactId,
      llm: async () => JSON.stringify({ summary: "采用了", characters: [], openHooks: [], advanceHooks: [], resolveHooks: [] }),
    });
    const afterAdopt = await saveHandEditedArtifact(store, hand.artifactId, "采用后再改");
    expect(afterAdopt.artifactId).not.toBe(hand.artifactId);
    expect(afterAdopt.status).toBe("candidate");
  });

  it("picks a role file by its name when there is no settings catalog", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-roles-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "角色",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 12,
        chapterWordCount: 3000,
      },
    });
    await mkdir(join(created.bookDir, "story", "roles", "主要角色"), { recursive: true });
    await mkdir(join(created.bookDir, "story", "outline"), { recursive: true });
    await writeFile(join(created.bookDir, "story", "roles", "主要角色", "路人.md"), `${"乙".repeat(9000)}\n`, "utf-8");
    await writeFile(join(created.bookDir, "story", "roles", "主要角色", "沈砚.md"), "MARK_ROLE 他带着玉佩。\n", "utf-8");
    await writeFile(join(created.bookDir, "story", "outline", "volume_map.md"), "第 1 章写沈砚。\n", "utf-8");
    const prompts: string[] = [];
    await generateChapterDraft({
      root: { projectRoot: root, bookId: created.bookId },
      project: project(),
      chapterNumber: 1,
      title: "夜",
      llm: async (call) => {
        prompts.push(call.messages.map((message) => message.content).join("\n"));
        return "正文";
      },
    });
    expect(prompts.join("\n")).toContain("MARK_ROLE");
  });

  it("keeps one chapter heading from generate through revise and adopt, and records token usage", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-heading-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "夜雨",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 12,
        chapterWordCount: 3000,
      },
    });
    const prompts: string[] = [];
    const duplicated = [
      "# 第八章 夜雨",
      "第八章 夜雨",
      "雨下了一夜。",
      "第一章就出事了，他没来得及撑伞。",
      "他后来提起「第八章 夜雨」四个字。",
    ].join("\n");
    const ctx = {
      root: { projectRoot: root, bookId: created.bookId },
      project: project(),
      llm: (async (call) => {
        const text = call.messages.map((message) => message.content).join("\n");
        prompts.push(text);
        if (call.roleId === "write.review") {
          return JSON.stringify({
            summary: "开头重复了标题",
            coverage: "chapter:8",
            issues: [{ issueId: "h1", title: "标题写了两遍", severity: "improve", suggestion: "只留一行标题" }],
          });
        }
        if (text.includes("整理人物状态")) {
          return JSON.stringify({ summary: "雨停了", characters: [], openHooks: [], advanceHooks: [], resolveHooks: [] });
        }
        if (text.includes("按选中意见")) return duplicated;
        return {
          content: duplicated,
          usage: { promptTokens: 1200, completionTokens: 340, totalTokens: 1540 },
        };
      }) as AuthoringLlmFn,
    };
    const draft = await generateChapterDraft({ ...ctx, chapterNumber: 8, title: "夜雨" });
    expect(prompts.some((text) => text.includes("撰写第 8 章") && text.includes("不要写章节标题"))).toBe(true);
    expect(countExactHeading(draft.body, "第八章 夜雨")).toBe(1);
    expect(draft.body).toContain("第一章就出事了");
    expect(draft.body).toContain("他后来提起「第八章 夜雨」四个字。");
    expect(draft.usage).toEqual({ promptTokens: 1200, completionTokens: 340, totalTokens: 1540 });
    const run = await loadRun(ctx.root, draft.runId);
    expect(run?.usage).toEqual({ promptTokens: 1200, completionTokens: 340, totalTokens: 1540 });
    const stored = await loadArtifact(ctx.root, draft.artifactId);
    expect(countExactHeading(stored?.body ?? "", "第八章 夜雨")).toBe(1);

    const report = await reviewChapterDraft({ ...ctx, artifactId: draft.artifactId });
    const revised = await reviseChapterDraft({
      ...ctx,
      artifactId: draft.artifactId,
      reportId: report.reportId,
      selectedIssueIds: ["h1"],
    });
    expect(countExactHeading(revised.body, "第八章 夜雨")).toBe(1);
    expect(revised.body).toContain("第一章就出事了");

    await writeFile(
      join(created.bookDir, "story", "workflow", "artifacts", revised.artifactId, "body.md"),
      `${duplicated}\n`,
      "utf-8",
    );
    await adoptChapterDraft({ ...ctx, artifactId: revised.artifactId });
    const chapterFile = (await readdir(join(created.bookDir, "chapters"))).find((name) => name.endsWith(".md"));
    expect(chapterFile).toBeTruthy();
    const chapter = await readFile(join(created.bookDir, "chapters", chapterFile!), "utf-8");
    expect(countExactHeading(chapter, "第八章 夜雨")).toBe(1);
    expect(chapter).toContain("第一章就出事了");
    expect(chapter).toContain("他后来提起「第八章 夜雨」四个字。");
    const adoptedBody = await loadArtifact(ctx.root, revised.artifactId);
    expect(countExactHeading(adoptedBody?.body ?? "", "第八章 夜雨")).toBe(1);
  });

  it("keeps a stopped draft in one piece and releases the book", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-stop-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "停",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 12,
        chapterWordCount: 3000,
      },
    });
    let runId = "";
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const draft = await generateChapterDraft({
      ...ctx,
      chapterNumber: 3,
      title: "停笔",
      onRunStart: (id) => {
        runId = id;
      },
      llm: async (call) => {
        await call.onTextDelta?.("# 第三章 停笔\n第三章 停笔\n他放下笔。");
        expect(requestWriteRunCancel(runId)).toBe(true);
        throw abortError();
      },
    });
    expect(draft.status).toBe("cancelled");
    expect(draft.artifactId).not.toBe("");
    expect(countExactHeading(draft.body, "第三章 停笔")).toBe(1);
    expect(draft.body).toContain("他放下笔。");
    const run = await loadRun(ctx.root, draft.runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.producedArtifactIds).toEqual([draft.artifactId]);
    const release = await new StateManager(root).acquireBookLock(created.bookId, { stage: "测试", taskId: "after-stop" }, { waitMs: 0 });
    await release();
  });

  it("drops an empty stop without an artifact or a leftover lock", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-empty-stop-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "空",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 12,
        chapterWordCount: 3000,
      },
    });
    let runId = "";
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const draft = await generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      title: "空",
      onRunStart: (id) => {
        runId = id;
      },
      llm: async () => {
        expect(requestWriteRunCancel(runId)).toBe(true);
        throw abortError();
      },
    });
    expect(draft.status).toBe("cancelled");
    expect(draft.artifactId).toBe("");
    expect(draft.body).toBe("");
    const names = await readdir(join(created.bookDir, "story", "workflow", "artifacts")).catch(() => [] as string[]);
    expect(names.filter((name) => name.startsWith("write-"))).toEqual([]);
    const release = await new StateManager(root).acquireBookLock(created.bookId, { stage: "测试", taskId: "after-empty" }, { waitMs: 0 });
    await release();
  });

  it("keeps a partial chapter when the upstream call fails after text", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-fail-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "断",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 12,
        chapterWordCount: 3000,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const error = await generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      title: "断",
      llm: async (call) => {
        await call.onTextDelta?.("半截要留下");
        throw new Error("模型断了 sk-supersecretkey123456");
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SavedPartialDraftError);
    expect((error as Error).message).toMatch(/模型断了/);
    expect((error as Error).message).toMatch(/已隐藏/);
    expect((error as SavedPartialDraftError).artifactId).toBeTruthy();
    const manifest = await loadManifest(ctx.root);
    const artifactId = manifest.candidates.write["1"];
    expect(artifactId).toBeTruthy();
    const stored = await loadArtifact(ctx.root, artifactId!);
    expect(stored?.body).toContain("半截要留下");
    const runs = await loadRun(ctx.root, stored?.meta.runId ?? "");
    expect(runs?.status).toBe("failed");
    expect(runs?.producedArtifactIds).toEqual([artifactId]);
    expect(runs?.error).toContain("已隐藏");
    expect(runs?.error).not.toContain("sk-supersecretkey123456");
    const release = await new StateManager(root).acquireBookLock(created.bookId, { stage: "测试", taskId: "after-fail" }, { waitMs: 0 });
    await release();
  });

  it("records usage when a stop arrives with token counts", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-stop-usage-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "停",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 12,
        chapterWordCount: 3000,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const draft = await generateChapterDraft({
      ...ctx,
      chapterNumber: 2,
      title: "停",
      llm: async (call) => {
        await call.onTextDelta?.("留下这句");
        const error = abortError() as Error & { usage?: { promptTokens: number; completionTokens: number; totalTokens: number } };
        error.usage = { promptTokens: 4, completionTokens: 6, totalTokens: 0 };
        throw error;
      },
    });
    expect(draft.status).toBe("cancelled");
    expect(draft.body).toContain("留下这句");
    const run = await loadRun(ctx.root, draft.runId);
    expect(run?.usage).toEqual({ promptTokens: 4, completionTokens: 6, totalTokens: 10 });
  });

  it("can cancel a write before the run file exists", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-early-cancel-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "早",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 12,
        chapterWordCount: 3000,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    let sawFile = true;
    let calledModel = false;
    const draft = await generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      title: "早",
      onRunStart: async (id) => {
        sawFile = Boolean(await loadRun(ctx.root, id));
        expect(requestWriteRunCancel(id)).toBe(true);
      },
      llm: async () => {
        calledModel = true;
        return "不该写";
      },
    });
    expect(sawFile).toBe(false);
    expect(calledModel).toBe(false);
    expect(draft.status).toBe("cancelled");
    expect(draft.artifactId).toBe("");
  });

  it("records a running run immediately and a failed run when generation throws", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-run-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "夜港", oneLine: "会计", proposition: "", protagonist: "沈砚", conflict: "",
        voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 4, chapterWordCount: 2800,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
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

    let release!: (text: string) => void;
    const blocked = new Promise<string>((resolve) => { release = resolve; });
    const pending = generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      title: "雨",
      llm: async () => blocked,
    });
    await vi.waitFor(async () => {
      const runs = await listRuns(ctx.root);
      expect(runs[0]?.status).toBe("running");
      expect(runs[0]?.operation).toBe("generate");
    });
    release("# 第1章\n雨停了。");
    const draft = await pending;
    expect((await loadRun(ctx.root, draft.runId))?.status).toBe("completed");

    await expect(generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      title: "雨",
      llm: async () => { throw new Error("模型中断"); },
    })).rejects.toThrow("模型中断");
    const failed = (await listRuns(ctx.root)).find((run) => run.status === "failed");
    expect(failed?.error).toContain("模型中断");
  });

  it("can adopt without settling and retry settle later", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-settle-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "夜港", oneLine: "会计", proposition: "", protagonist: "沈砚", conflict: "",
        voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 4, chapterWordCount: 3000,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
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
    const draft = await generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      title: "雨",
      llm: async () => "# 第1章\n沈砚走在街上。",
    });
    const adopted = await adoptChapterDraft({
      ...ctx,
      artifactId: draft.artifactId,
      deferSettle: true,
      llm: async () => { throw new Error("settle should not run"); },
    });
    expect(adopted).toMatchObject({ adopted: true, settled: false });
    const settled = await settleAdoptedChapter({
      ...ctx,
      artifactId: draft.artifactId,
      llm: async (call) => {
        expect(call.messages.some((message) => message.content.includes("整理人物状态"))).toBe(true);
        return "沈砚已到港口。";
      },
    });
    expect(settled.settled).toBe(true);
    expect((await loadRun(ctx.root, settled.runId))?.operation).toBe("settle");
  });

  it("cancels an active chapter generate without saving a candidate", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-cancel-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "夜港", oneLine: "会计", proposition: "", protagonist: "沈砚", conflict: "",
        voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 4, chapterWordCount: 3000,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
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
    const runId = newRunId();
    let release!: (text: string) => void;
    const blocked = new Promise<string>((resolve) => { release = resolve; });
    let entered = false;
    const pending = generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      title: "雨",
      runId,
      llm: async () => {
        entered = true;
        return blocked;
      },
    });
    await vi.waitFor(async () => {
      expect((await loadRun(ctx.root, runId))?.status).toBe("running");
      expect(entered).toBe(true);
    });
    await saveRunControl(ctx.root, runId, "cancel");
    release("# 第1章\n雨停了。");
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect((await loadRun(ctx.root, runId))?.status).toBe("cancelled");
    expect((await loadManifest(ctx.root)).candidates.write?.["1"]).toBeDefined();
  });

  it("holds chapter N+1 generate until previous settle finishes and keeps previous state in the prompt", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-settle-hold-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "夜港", oneLine: "会计", proposition: "", protagonist: "沈砚", conflict: "",
        voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 4, chapterWordCount: 3000,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
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
      endChapter: 2,
      llm: async () => JSON.stringify({
        chapters: [
          { chapterNumber: 1, title: "雨", summary: "港口开场。" },
          { chapterNumber: 2, title: "账", summary: "找回账本。" },
        ],
      }),
    });
    await adoptWeave({ root: ctx.root, project: ctx.project, artifactId: planned.artifactId });
    const draft = await generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      title: "雨",
      llm: async () => "# 第1章\n沈砚走在街上。",
    });
    await adoptChapterDraft({
      ...ctx,
      artifactId: draft.artifactId,
      deferSettle: true,
      llm: async () => { throw new Error("settle should not run"); },
    });
    let releaseSettle!: (text: string) => void;
    const blockedSettle = new Promise<string>((resolve) => { releaseSettle = resolve; });
    const settling = settleAdoptedChapter({
      ...ctx,
      artifactId: draft.artifactId,
      llm: async () => blockedSettle,
    });
    await vi.waitFor(async () => {
      expect((await listRuns(ctx.root)).some((run) => run.operation === "settle" && run.status === "running")).toBe(true);
    });
    await expect(generateChapterDraft({
      ...ctx,
      chapterNumber: 2,
      title: "账",
      llm: async () => { throw new Error("chapter 2 should not start"); },
    })).rejects.toThrow("正在整理第 1 章状态，完成后可写下一章。");
    releaseSettle("沈砚已到港口。MARK-STATE-CH1");
    expect((await settling).settled).toBe(true);
    expect(await listChapterStateRefs(ctx.root)).toEqual({ "1": draft.artifactId });
    const prompts: string[] = [];
    await generateChapterDraft({
      ...ctx,
      chapterNumber: 2,
      title: "账",
      llm: async (call) => {
        prompts.push(call.messages.map((message) => message.content).join("\n"));
        return "# 第2章\n账本在雨里。";
      },
    });
    expect(prompts[0]).toContain("【上一章状态】");
    expect(prompts[0]).toContain("MARK-STATE-CH1");
  });

  it("clears chapter state on settle failure so a later 整理状态 can retry", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-settle-fail-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "夜港", oneLine: "会计", proposition: "", protagonist: "沈砚", conflict: "",
        voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 4, chapterWordCount: 3000,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
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
    const draft = await generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      title: "雨",
      llm: async () => "# 第1章\n沈砚走在街上。",
    });
    await adoptChapterDraft({
      ...ctx,
      artifactId: draft.artifactId,
      deferSettle: true,
    });
    const failed = await settleAdoptedChapter({
      ...ctx,
      artifactId: draft.artifactId,
      llm: async () => { throw new Error("状态模型中断"); },
    });
    expect(failed.settled).toBe(false);
    expect(failed.settleError).toContain("状态模型中断");
    expect((await loadRun(ctx.root, failed.runId))?.status).toBe("failed");
    expect(await listChapterStateRefs(ctx.root)).toEqual({});
    const retried = await settleAdoptedChapter({
      ...ctx,
      artifactId: draft.artifactId,
      llm: async () => "沈砚已到港口。",
    });
    expect(retried.settled).toBe(true);
    expect(await listChapterStateRefs(ctx.root)).toEqual({ "1": draft.artifactId });
  });

  it("binds a reader save to a new artifact and drops the old settle from the next chapter", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-reader-save-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "夜港", oneLine: "会计", proposition: "", protagonist: "林", conflict: "",
        voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 4, chapterWordCount: 3000,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await ensureAdoptedChapterPlan(ctx.root, ctx.project, 1);
    const draft = await generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      title: "信封",
      llm: async () => "# 第1章 信封\n林带着信封离开。",
    });
    await adoptChapterDraft({
      ...ctx,
      artifactId: draft.artifactId,
      llm: async () => JSON.stringify({
        summary: "林带着信封离开。",
        characters: [{ name: "林", status: "带着信封离开" }],
        openHooks: [{ id: "hook-letter", label: "信封去向", note: "旧状态" }],
        advanceHooks: [],
        resolveHooks: [],
      }),
    });
    expect(await loadWriteMemory(ctx.root, 2)).toContain("带着信封离开");
    const edited = "# 第1章 信封\n林烧掉信封并留在原地。";
    await persistAdoptedChapter({
      bookDir: created.bookDir,
      chapterNumber: 1,
      title: "信封",
      body: edited,
    });
    const bound = await bindRestoredChapterUnlocked({
      root: ctx.root,
      chapterNumber: 1,
      title: "信封",
      relativePath: "chapters/0001_信封.md",
      body: edited,
    });
    const manifest = await loadManifest(ctx.root);
    expect(manifest.adopted.write["1"]).toBe(bound.artifactId);
    expect(await loadArtifact(ctx.root, bound.artifactId)).toMatchObject({ body: expect.stringContaining("林烧掉信封并留在原地") });
    expect(await listChapterStateRefs(ctx.root)).toEqual({});
    expect(await loadWriteMemory(ctx.root, 2)).not.toContain("带着信封离开");
    const nextPrompt = await assembleAuthoringContext(ctx.root, { stage: "write", chapterNumber: 2 });
    expect(nextPrompt.text).toContain("林烧掉信封并留在原地");
    expect(nextPrompt.text).not.toContain("带着信封离开");
    await persistAdoptedChapter({
      bookDir: created.bookDir,
      chapterNumber: 1,
      title: "信封",
      body: edited,
    });
    await adoptChapterDraft({
      ...ctx,
      artifactId: bound.artifactId,
      llm: async () => JSON.stringify({
        summary: "林烧掉信封并留在原地。",
        characters: [{ name: "林", status: "留在原地" }],
        openHooks: [],
        advanceHooks: [],
        resolveHooks: ["hook-letter"],
      }),
    });
    expect(await loadWriteMemory(ctx.root, 2)).toContain("留在原地");
    expect(await loadWriteMemory(ctx.root, 2)).not.toContain("带着信封离开");
  });

  it("feeds old hook ids and the chapter ending into settle", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-settle-memory-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "夜港", oneLine: "会计", proposition: "", protagonist: "林", conflict: "",
        voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 4, chapterWordCount: 3000,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await ensureAdoptedChapterPlan(ctx.root, ctx.project, 1);
    const first = await generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      title: "埋线",
      llm: async () => "# 第1章\n林把铜牌藏进抽屉。HOOK_PLANT",
    });
    await adoptChapterDraft({
      ...ctx,
      artifactId: first.artifactId,
      llm: async () => JSON.stringify({
        summary: "藏铜牌",
        characters: [{ name: "林", status: "藏了铜牌" }],
        openHooks: [{ id: "hook-badge", label: "抽屉里的铜牌", note: "尚未收回" }],
        advanceHooks: [],
        resolveHooks: [],
      }),
    });
    const middle = "MIDDLE_ONLY_STATE 林把铜牌熔掉。";
    const tail = "ENDING_TWIST 林当众打开抽屉，铜牌已经不在。";
    const longBody = `# 第1章\n${"H".repeat(8200)}${middle}${"T".repeat(8200)}${tail}`;
    expect(longBody.length).toBeGreaterThan(16_244);
    const middleAt = longBody.indexOf("MIDDLE_ONLY_STATE");
    expect(middleAt).toBeGreaterThan(6000);
    expect(longBody.length - middleAt).toBeGreaterThan(6000);
    expect(settleCoverageComplete({
      totalChars: 16244,
      segments: [{ start: 1, end: 6000 }, { start: 10245, end: 16244 }],
    })).toBe(false);
    const segmented = settleBodySegments(longBody);
    expect(settleCoverageComplete(segmented.coverage)).toBe(true);
    expect(segmented.texts.some((text) => text.includes("MIDDLE_ONLY_STATE"))).toBe(true);
    const prompts: string[] = [];
    const draft = await generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      title: "埋线",
      llm: async () => longBody,
    });
    await adoptChapterDraft({
      ...ctx,
      artifactId: draft.artifactId,
      llm: async (call) => {
        prompts.push(call.messages.map((message) => message.content).join("\n"));
        return JSON.stringify({
          summary: "铜牌消失",
          characters: [{ name: "林", status: "当众打开空抽屉" }],
          openHooks: [],
          advanceHooks: [],
          resolveHooks: ["hook-badge"],
        });
      },
    });
    expect(prompts.some((prompt) => prompt.includes("hook-badge"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("抽屉里的铜牌"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("ENDING_TWIST"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("MIDDLE_ONLY_STATE"))).toBe(true);
    const ledger = await loadSerialLedger(created.bookDir);
    expect(ledger?.chapters[0]?.resolveHookIds).toEqual(["hook-badge"]);
    const ref = JSON.parse(await readFile(join(created.bookDir, "story", "state", "chapter-1.ref.json"), "utf-8")) as { coverage?: { totalChars: number; segments?: Array<{ start: number; end: number }> } };
    expect(ref.coverage?.totalChars).toBeGreaterThan(16_000);
    expect(ref.coverage && settleCoverageComplete(ref.coverage)).toBe(true);
    expect(ref.coverage?.segments?.some((segment) => segment.end === ref.coverage?.totalChars)).toBe(true);
  });

  it("keeps origin hook ids after a reader typo fix and drops a hook the rewrite removed", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-hook-identity-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "夜港", oneLine: "会计", proposition: "", protagonist: "林", conflict: "",
        voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 4, chapterWordCount: 3000,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const plant = JSON.stringify({
      summary: "藏铜牌",
      characters: [{ name: "林", status: "藏了铜牌" }],
      openHooks: [{ id: "hook-badge", label: "抽屉里的铜牌", note: "尚未收回" }],
      advanceHooks: [],
      resolveHooks: [],
    });
    const first = await generateChapterDraft({
      ...ctx, chapterNumber: 1, title: "埋线",
      llm: async () => "# 第1章\n林把铜牌藏进抽屉。",
    });
    await adoptChapterDraft({ ...ctx, artifactId: first.artifactId, llm: async () => plant });
    const second = await generateChapterDraft({
      ...ctx, chapterNumber: 2, title: "推进",
      llm: async () => "# 第2章\n林又摸到抽屉里的铜牌。",
    });
    await adoptChapterDraft({
      ...ctx, artifactId: second.artifactId,
      llm: async () => JSON.stringify({
        summary: "又摸到铜牌",
        characters: [{ name: "林", status: "仍握着铜牌" }],
        openHooks: [],
        advanceHooks: ["hook-badge"],
        resolveHooks: [],
      }),
    });
    const third = await generateChapterDraft({
      ...ctx, chapterNumber: 3, title: "收回",
      llm: async () => "# 第3章\n林把铜牌交了出去。",
    });
    await adoptChapterDraft({
      ...ctx, artifactId: third.artifactId,
      llm: async () => JSON.stringify({
        summary: "交还铜牌",
        characters: [{ name: "林", status: "交还铜牌" }],
        openHooks: [],
        advanceHooks: [],
        resolveHooks: ["hook-badge"],
      }),
    });
    const foldedBefore = foldSerialLedger(await loadSerialLedger(created.bookDir), (await loadManifest(ctx.root)).adopted.write);
    expect(foldedBefore.hooks.find((hook) => hook.id === "hook-badge")?.status).toBe("resolved");

    const edited = "# 第1章\n林把铜牌藏进抽屉。灯花轻轻一跳。";
    await persistAdoptedChapter({
      bookDir: created.bookDir,
      chapterNumber: 1,
      title: "埋线",
      body: edited,
    });
    const bound = await bindRestoredChapterUnlocked({
      root: ctx.root,
      chapterNumber: 1,
      title: "埋线",
      relativePath: "chapters/0001_埋线.md",
      body: edited,
    });
    const settlePrompts: string[] = [];
    const settled = await settleAdoptedChapter({
      ...ctx,
      artifactId: bound.artifactId,
      llm: async (call) => {
        settlePrompts.push(call.messages.map((message) => message.content).join("\n"));
        return JSON.stringify({
          summary: "仍把铜牌藏进抽屉。",
          characters: [{ name: "林", status: "刚改了一个错字" }],
          openHooks: [{ id: "hook-badge-new", label: "抽屉里的铜牌", note: "仍未收回" }],
          advanceHooks: [],
          resolveHooks: [],
        });
      },
    });
    expect(settled.settled).toBe(true);
    expect(settlePrompts.join("\n")).toContain("hook-badge");
    expect(settlePrompts.join("\n")).toContain("本章上次伏笔身份");
    expect(settlePrompts.join("\n")).not.toContain("藏了铜牌");
    const afterTypo = foldSerialLedger(await loadSerialLedger(created.bookDir), (await loadManifest(ctx.root)).adopted.write);
    expect(afterTypo.hooks.find((hook) => hook.id === "hook-badge")?.status).toBe("resolved");
    expect(afterTypo.hooks.some((hook) => hook.id === "hook-badge-new")).toBe(false);

    const stripped = "# 第1章\n林只是坐在桌边改了一个错字。";
    await persistAdoptedChapter({
      bookDir: created.bookDir,
      chapterNumber: 1,
      title: "埋线",
      body: stripped,
    });
    const rebound = await bindRestoredChapterUnlocked({
      root: ctx.root,
      chapterNumber: 1,
      title: "埋线",
      relativePath: "chapters/0001_埋线.md",
      body: stripped,
    });
    const removed = await settleAdoptedChapter({
      ...ctx,
      artifactId: rebound.artifactId,
      llm: async () => JSON.stringify({
        summary: "这一章不再埋铜牌。",
        characters: [{ name: "林", status: "坐在桌边" }],
        openHooks: [],
        advanceHooks: [],
        resolveHooks: [],
      }),
    });
    expect(removed.settled).toBe(true);
    const origin = (await loadSerialLedger(created.bookDir))?.chapters.find((entry) => entry.chapter === 1);
    expect(origin?.openHooks).toEqual([]);
    expect(await loadWriteMemory(ctx.root, 2)).not.toContain("抽屉里的铜牌");
  });
});

function countExactHeading(body: string, heading: string): number {
  return body.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim().replace(/^#{1,6}\s*/, "") === heading).length;
}

function abortError(): Error {
  const error = new Error("stopped");
  error.name = "AbortError";
  return error;
}
