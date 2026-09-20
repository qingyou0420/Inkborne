import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectConfigSchema, type ProjectConfig } from "../models/project.js";
import { createLightweightBook as createLightweightBookCore } from "../authoring/book-create.js";
import { ensureAuthoringDraft } from "../authoring/drafts.js";
import { findChapterRelativePath, persistAdoptedChapter } from "../authoring/chapter-index.js";
import { listChapterVersions, readChapterVersion } from "../state/chapter-workspace.js";
import { assembleAuthoringContext, isLightweightAuthoringBook, loadOutlineText } from "../authoring/context.js";
import { parseCanon, serializeCanon } from "../authoring/canon.js";
import { findChapterNode, parseVolumeMapTree } from "../utils/volume-map-tree.js";
import { parseReviewPayload } from "../authoring/review.js";
import { generateAskCanon, adoptAskCanon } from "../authoring/stages/ask.js";
import { generateGroundEntries, proposeSettingsCatalog, reviseGroundEntry } from "../authoring/stages/ground.js";
import { adoptWeave, generateWeaveRange as generateWeaveRangeCore, generateWeaveStructure, resolveWeaveTargetChapters, reviseWeave, volumesFromOutline } from "../authoring/stages/weave.js";
import { adoptChapterDraft, bindRestoredChapter, generateChapterDraft as generateChapterDraftCore, reviewChapterDraft, reviseChapterDraft, saveWriteBody, selectWriteCandidate } from "../authoring/stages/write.js";
import { loadArtifact, loadManifest, loadRun, newRunId, saveHandEditedArtifact, saveReport, saveRunControl } from "../authoring/store.js";
import type { AuthoringLlmFn } from "../authoring/types.js";

async function createLightweightBook(input: Parameters<typeof createLightweightBookCore>[0]) {
  return createLightweightBookCore({
    ...input,
    canon: {
      ...input.canon,
      targetChapters: input.canon.targetChapters ?? 8,
    },
  });
}

async function createLegacyBook(input: {
  readonly projectRoot: string;
  readonly title: string;
  readonly targetChapters?: number;
  readonly bookId?: string;
}) {
  const bookId = input.bookId ?? "legacy";
  const bookDir = join(input.projectRoot, "books", bookId);
  await mkdir(join(bookDir, "story", "outline"), { recursive: true });
  await mkdir(join(bookDir, "story", "roles", "主要角色"), { recursive: true });
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await writeFile(join(bookDir, "book.json"), `${JSON.stringify({
    id: bookId,
    title: input.title,
    targetChapters: input.targetChapters ?? 8,
    language: "zh",
  }, null, 2)}\n`, "utf-8");
  await writeFile(join(bookDir, "chapters", "index.json"), "[]\n", "utf-8");
  return { bookId, bookDir };
}

async function setBookTarget(root: { projectRoot: string; bookId?: string }, target: number) {
  if (!root.bookId) return;
  const bookDir = join(root.projectRoot, "books", root.bookId);
  const bookPath = join(bookDir, "book.json");
  const book = JSON.parse(await readFile(bookPath, "utf-8")) as Record<string, unknown>;
  book.targetChapters = target;
  await writeFile(bookPath, `${JSON.stringify(book, null, 2)}\n`, "utf-8");
  const canonPath = join(bookDir, "story", "canon.md");
  try {
    const parsed = parseCanon(await readFile(canonPath, "utf-8"));
    await writeFile(canonPath, serializeCanon({ ...parsed, targetChapters: target }), "utf-8");
  } catch {
    /* old books have no canon.md */
  }
}

async function adoptPlannedStructure(
  ctx: { root: { projectRoot: string; bookId?: string }; project: ProjectConfig },
  volumes: Array<{ volumeNumber: number; title: string; startChapter: number; endChapter: number; body: string }>,
  bookOutline = "测试结构",
) {
  const structured = await generateWeaveStructure({
    ...ctx,
    llm: async () => JSON.stringify({ bookOutline, volumes }),
  });
  await adoptWeave({ ...ctx, artifactId: structured.artifactId });
  return structured;
}

async function generateWeaveRange(input: Parameters<typeof generateWeaveRangeCore>[0]) {
  const bookDir = input.root.bookId ? join(input.root.projectRoot, "books", input.root.bookId) : "";
  const lightweight = bookDir ? await isLightweightAuthoringBook(bookDir) : false;
  const manifest = await loadManifest(input.root);
  if (!input.resumeRunId && !manifest.adopted.weave && lightweight && input.root.bookId) {
    const target = await resolveWeaveTargetChapters(input.root);
    await adoptPlannedStructure(
      { root: input.root, project: input.project },
      [{ volumeNumber: 1, title: "测试卷", startChapter: 1, endChapter: target, body: "测试卷目标" }],
    );
  }
  return generateWeaveRangeCore(input);
}

async function ensureAdoptedChapterPlan(
  root: { projectRoot: string; bookId?: string },
  project: ProjectConfig,
  chapterNumber: number,
) {
  if (!root.bookId) return;
  const bookDir = join(root.projectRoot, "books", root.bookId);
  if (!(await isLightweightAuthoringBook(bookDir))) return;
  const manifest = await loadManifest(root);
  if (!manifest.adopted.weave) {
    const target = await resolveWeaveTargetChapters(root);
    const structured = await generateWeaveStructure({
      root,
      project,
      llm: async () => JSON.stringify({
        bookOutline: "测试结构",
        volumes: [{ volumeNumber: 1, title: "测试卷", startChapter: 1, endChapter: target, body: "测试卷目标" }],
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

function project() {
  return ProjectConfigSchema.parse({
    name: "test",
    version: "0.1.0",
    llm: {
      provider: "custom",
      service: "zenmux",
      configSource: "studio",
      baseUrl: "https://zenmux.ai/api/v1",
      model: "main",
      apiKey: "sk",
      temperature: 0.5,
      thinkingBudget: 0,
      apiFormat: "chat",
      stream: true,
    },
  });
}

describe("authoring rework R01-R12", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("isolates drafts and binds one book per draft even after a title change (R11)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r11-"));
    const a = await ensureAuthoringDraft({ projectRoot: root, sessionId: "s-a" });
    const b = await ensureAuthoringDraft({ projectRoot: root, sessionId: "s-b" });
    expect(a.draftId).not.toBe(b.draftId);
    const llm: AuthoringLlmFn = async () => JSON.stringify({
      title: "版本甲",
      oneLine: "甲",
      proposition: "甲命题",
      protagonist: "甲主角",
      conflict: "甲冲突",
      voice: "甲文风",
      boundaries: "甲边界",
      direction: "甲方向",
      openQuestions: [],
      targetChapters: 12,
      chapterWordCount: 2000,
    });
    const first = await generateAskCanon({
      root: { projectRoot: root, draftId: a.draftId },
      project: project(),
      llm,
      conversation: "甲",
    });
    const adopted = await adoptAskCanon({
      root: { projectRoot: root, draftId: a.draftId },
      project: project(),
      artifactId: first.artifactId,
    });
    const llmB: AuthoringLlmFn = async () => JSON.stringify({
      title: "版本甲",
      oneLine: "乙",
      proposition: "",
      protagonist: "",
      conflict: "",
      voice: "",
      boundaries: "",
      direction: "",
      openQuestions: [],
      targetChapters: 12,
      chapterWordCount: 2000,
    });
    const second = await generateAskCanon({
      root: { projectRoot: root, draftId: b.draftId },
      project: project(),
      llm: llmB,
      conversation: "乙",
    });
    const adoptedB = await adoptAskCanon({
      root: { projectRoot: root, draftId: b.draftId },
      project: project(),
      artifactId: second.artifactId,
    });
    expect(adoptedB.bookId).not.toBe(adopted.bookId);
    const renamed = await generateAskCanon({
      root: { projectRoot: root, draftId: a.draftId },
      project: project(),
      llm: async () => JSON.stringify({
        title: "版本乙",
        oneLine: "改名",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
      }),
      conversation: "改名",
    });
    const again = await adoptAskCanon({
      root: { projectRoot: root, draftId: a.draftId },
      project: project(),
      artifactId: renamed.artifactId,
    });
    expect(again.bookId).toBe(adopted.bookId);
    expect(again.created).toBe(false);
  });

  it("keeps weave checkpoints on later-batch failure and merges a partial range (R07/R08)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r07-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "八章",
        oneLine: "测试",
        proposition: "MARK-PROP",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "MARK-BOUND",
        direction: "",
        openQuestions: [],
        targetChapters: 8,
      },
    });
    await mkdir(join(created.bookDir, "story", "settings"), { recursive: true });
    await writeFile(join(created.bookDir, "story", "settings", "rule.md"), "MARK-SETTING 不可飞升。\n", "utf-8");
    await writeFile(join(created.bookDir, "story", "settings", "index.json"), JSON.stringify({
      categories: ["规则"],
      entries: [{ id: "rule", category: "规则", name: "铁律", file: "story/settings/rule.md", adoptedArtifactId: "g1" }],
    }), "utf-8");
    let batch = 0;
    const seen: string[] = [];
    const llm: AuthoringLlmFn = async (call) => {
      const text = call.messages.map((message) => message.content).join("\n");
      seen.push(text);
      if (call.roleId === "weave.review") return JSON.stringify({ summary: "ok", coverage: "1-8", issues: [] });
      batch += 1;
      if (batch === 2) throw new Error("模拟网络错误");
      const match = /第 (\d+)-(\d+) 章/.exec(text);
      const start = Number(match?.[1] ?? 1);
      const end = Number(match?.[2] ?? 4);
      return JSON.stringify({
        bookOutline: "全书从港口到对质。",
        volumes: [
          { volumeNumber: 1, title: "夜港", startChapter: 1, endChapter: 4, body: "上半" },
          { volumeNumber: 2, title: "对质", startChapter: 5, endChapter: 8, body: "下半" },
        ],
        chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
          chapterNumber: start + index,
          title: `章${start + index}`,
          summary: `第${start + index}章真实概要。`,
        })),
      });
    };
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm };
    const first = await generateWeaveRange({ ...ctx, startChapter: 1, endChapter: 8, targetChapters: 8 });
    expect(first.status).toBe("partial");
    expect(first.beats.filter((beat) => beat.summary.includes("真实概要")).map((beat) => beat.chapterNumber)).toEqual([1, 2, 3, 4]);
    const run = await loadRun(ctx.root, first.runId);
    expect(run?.status).toBe("partial");
    expect(run?.producedArtifactIds.length).toBeGreaterThan(0);
    const saved = await loadArtifact(ctx.root, first.artifactId);
    expect(saved?.body).toContain("真实概要");
    expect(saved?.body).not.toMatch(/第 5 章[\s\S]*真实概要/);
    expect(seen[0]).toContain("MARK-SETTING");
    expect(seen[0]).toContain("MARK-BOUND");
    expect(seen[0]).toContain("MARK-PROP");

    const resumeLlm: AuthoringLlmFn = async (call) => {
      const text = call.messages.map((message) => message.content).join("\n");
      expect(text).toContain("第1章");
      const match = /第 (\d+)-(\d+) 章/.exec(text);
      const start = Number(match?.[1] ?? 5);
      const end = Number(match?.[2] ?? 8);
      return JSON.stringify({
        chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
          chapterNumber: start + index,
          title: `章${start + index}`,
          summary: `第${start + index}章续写概要。`,
        })),
      });
    };
    const resumed = await generateWeaveRange({
      ...ctx,
      llm: resumeLlm,
      startChapter: 1,
      endChapter: 8,
      targetChapters: 8,
      resumeRunId: first.runId,
    });
    expect(resumed.beats.find((beat) => beat.chapterNumber === 1)?.summary).toContain("真实概要");
    expect(resumed.beats.find((beat) => beat.chapterNumber === 5)?.summary).toContain("续写概要");

    const partial = await generateWeaveRange({
      ...ctx,
      llm: async (call) => {
        const text = call.messages.map((message) => message.content).join("\n");
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        const start = Number(match?.[1] ?? 5);
        const end = Number(match?.[2] ?? 8);
        return JSON.stringify({
          chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
            chapterNumber: start + index,
            title: `新${start + index}`,
            summary: `重排${start + index}`,
          })),
        });
      },
      startChapter: 5,
      endChapter: 8,
      targetChapters: 8,
    });
    expect(partial.beats.find((beat) => beat.chapterNumber === 1)?.summary).toContain("真实概要");
    expect(partial.beats.find((beat) => beat.chapterNumber === 5)?.summary).toContain("重排5");
    expect(partial.beats.find((beat) => beat.chapterNumber === 1)?.title).not.toBe("第1章");
  });

  it("adopts a second chapter into a nonempty index (R09)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r09-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "旧书",
        oneLine: "续写",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 12,
      },
    });
    await persistAdoptedChapter({
      bookDir: created.bookDir,
      chapterNumber: 1,
      title: "开篇",
      body: "第一章已在。",
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm: (async () => "# 第2章\n新的一夜。") as AuthoringLlmFn };
    const draft = await generateChapterDraft({ ...ctx, chapterNumber: 2, title: "夜谈" });
    await adoptChapterDraft({ ...ctx, artifactId: draft.artifactId });
    const index = JSON.parse(await readFile(join(created.bookDir, "chapters", "index.json"), "utf-8")) as Array<{ number: number }>;
    expect(index.map((item) => item.number).sort()).toEqual([1, 2]);
    const files = await readFile(join(created.bookDir, "chapters", "0002_夜谈.md"), "utf-8");
    expect(files).toContain("新的一夜");
  });

  it("revises only the targeted ground entry (R10) and keeps write review refs (R05/R06)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r10-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "港口",
        oneLine: "找账本",
        proposition: "MARK-PROP",
        protagonist: "沈砚",
        conflict: "",
        voice: "MARK-VOICE",
        boundaries: "MARK-BOUND",
        direction: "MARK-DIR",
        openQuestions: [],
        targetChapters: 12,
      },
    });
    const llm: AuthoringLlmFn = async (call) => {
      const text = call.messages.map((message) => message.content).join("\n");
      if (text.includes("拟定本书设定目录")) {
        return JSON.stringify({
          categories: ["人物"],
          entries: [
            { id: "shen", category: "人物", name: "沈砚" },
            { id: "lin", category: "人物", name: "林潮" },
          ],
        });
      }
      if (call.roleId === "ground.review") {
        return JSON.stringify({
          summary: "林潮动机不足",
          issues: [{ issueId: "b1", title: "补动机", severity: "priority", target: "lin", suggestion: "写明她要账本的原因" }],
        });
      }
      if (text.includes("按意见修改设定")) {
        expect(text).toContain("林潮");
        expect(text).not.toContain("只输出该条目 Markdown。不要改其他条目。\n沈砚原文");
        return "林潮要赎回哥哥。";
      }
      if (text.includes("沈砚")) return "沈砚原文";
      return "林潮原文";
    };
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm };
    await proposeSettingsCatalog(ctx);
    await generateGroundEntries(ctx);
    const catalog = JSON.parse(await readFile(join(created.bookDir, "story", "settings", "index.json"), "utf-8")) as {
      entries: Array<{ id: string; candidateArtifactId?: string }>;
    };
    const lin = catalog.entries.find((entry) => entry.id === "lin");
    const shen = catalog.entries.find((entry) => entry.id === "shen");
    const parsed = parseReviewPayload(JSON.stringify({
      summary: "林潮动机不足",
      issues: [{ issueId: "b1", title: "补动机", severity: "priority", target: "lin", suggestion: "写明她要账本的原因" }],
    }), {
      stage: "ground",
      targetRefs: [lin?.candidateArtifactId, shen?.candidateArtifactId].filter(Boolean) as string[],
      coverage: "两项",
      model: "ground-review",
    });
    await saveReport(ctx.root, parsed);
    const shenBefore = shen?.candidateArtifactId;
    const revised = await reviseGroundEntry({
      ...ctx,
      reportId: parsed.reportId,
      selectedIssueIds: ["b1"],
    });
    expect(revised.entryIds).toEqual(["lin"]);
    const catalogAfter = JSON.parse(await readFile(join(created.bookDir, "story", "settings", "index.json"), "utf-8")) as {
      entries: Array<{ id: string; candidateArtifactId?: string }>;
    };
    expect(catalogAfter.entries.find((entry) => entry.id === "shen")?.candidateArtifactId).toBe(shenBefore);
    const ctxWrite = {
      ...ctx,
      llm: (async (call) => {
        const text = call.messages.map((message) => message.content).join("\n");
        if (call.roleId === "write.review") {
          expect(text).toContain("MARK-VOICE");
          expect(text).toContain("MARK-BOUND");
          return JSON.stringify({ summary: "可", coverage: "chapter:1", issues: [] });
        }
        return "# 第1章\n雨。";
      }) as AuthoringLlmFn,
    };
    const assembled = await assembleAuthoringContext(ctx.root, { stage: "write", chapterNumber: 1 });
    expect(assembled.text).toContain("MARK-VOICE");
    expect(assembled.text).toContain("MARK-BOUND");
    expect(assembled.text).toContain("MARK-DIR");
    const draft = await generateChapterDraft({ ...ctxWrite, chapterNumber: 1, title: "雨" });
    const report = await reviewChapterDraft({ ...ctxWrite, artifactId: draft.artifactId });
    expect(report.inputRefs.length).toBeGreaterThan(0);
    expect(report.incomplete).toBe(false);
  });

  it("treats an empty review object as incomplete (R12)", () => {
    const report = parseReviewPayload("{}", {
      stage: "ask",
      targetRefs: ["a1"],
      coverage: "全文",
      model: "ask-review",
    });
    expect(report.incomplete).toBe(true);
    expect(report.summary).toContain("不完整");
    expect(report.issues).toEqual([]);
  });

  it("resumes only the missing odd-even holes without rewriting chapter 1 (R2-04)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r2-04-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "漏章", oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 8 },
    });
    const llm: AuthoringLlmFn = async (call) => {
      const text = call.messages.map((message) => message.content).join("\n");
      const match = /第 (\d+)-(\d+) 章/.exec(text);
      const start = Number(match?.[1] ?? 1);
      const end = Number(match?.[2] ?? 4);
      return JSON.stringify({
        chapters: Array.from({ length: end - start + 1 }, (_, index) => start + index)
          .filter((n) => n % 2 === 1)
          .map((n) => ({ chapterNumber: n, title: `奇${n}`, summary: `KEEP_${n}` })),
      });
    };
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm };
    const first = await generateWeaveRange({ ...ctx, startChapter: 1, endChapter: 8, targetChapters: 8 });
    expect(first.status).toBe("partial");
    const run = await loadRun(ctx.root, first.runId);
    expect(run?.checkpoint?.missingChapters).toEqual([2, 4, 6, 8]);
    const original1 = first.beats.find((beat) => beat.chapterNumber === 1)?.summary;
    const resumeLlm: AuthoringLlmFn = async (call) => {
      const text = call.messages.map((message) => message.content).join("\n");
      expect(text).toMatch(/2、4、6、8|2, 4, 6, 8/);
      expect(text).not.toContain("规划第 1-1 章");
      return JSON.stringify({
        chapters: [2, 4, 6, 8].map((n) => ({ chapterNumber: n, title: `偶${n}`, summary: `FILL_${n}` })),
      });
    };
    const resumed = await generateWeaveRange({
      ...ctx,
      llm: resumeLlm,
      startChapter: run?.checkpoint?.requestedStart ?? 1,
      endChapter: run?.checkpoint?.requestedEnd ?? 8,
      resumeRunId: first.runId,
      missingChapters: run?.checkpoint?.missingChapters,
    });
    expect(resumed.beats.find((beat) => beat.chapterNumber === 1)?.summary).toBe(original1);
    expect(resumed.beats.find((beat) => beat.chapterNumber === 2)?.summary).toContain("FILL_2");
    expect(resumed.status).toBe("completed");
  });

  it("does not mark 9-12 complete just because 1-8 already exist (R2-05)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r2-05-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "跨范围", oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const fill = async (start: number, end: number) => JSON.stringify({
      chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
        chapterNumber: start + index,
        title: `章${start + index}`,
        summary: `FULL_${start + index}`,
      })),
    });
    const ctx = {
      root: { projectRoot: root, bookId: created.bookId },
      project: project(),
      llm: (async (call) => {
        const text = call.messages.map((message) => message.content).join("\n");
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        return fill(Number(match?.[1] ?? 1), Number(match?.[2] ?? 4));
      }) as AuthoringLlmFn,
    };
    await generateWeaveRange({ ...ctx, startChapter: 1, endChapter: 8, targetChapters: 12 });
    const emptyNine = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({ chapters: [] }),
      startChapter: 9,
      endChapter: 12,
      targetChapters: 12,
    });
    expect(emptyNine.status).toBe("partial");
    expect(emptyNine.beats.filter((beat) => beat.chapterNumber >= 9).every((beat) => beat.summary === "（待补概要）")).toBe(true);
    expect(emptyNine.beats.find((beat) => beat.chapterNumber === 1)?.summary).toContain("FULL_1");
    const run = await loadRun(ctx.root, emptyNine.runId);
    expect(run?.checkpoint?.missingChapters).toEqual([9, 10, 11, 12]);
  });

  it("keeps weave/write associations when a bound draft re-adopts canon (R2-06)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r2-06-"));
    const draft = await ensureAuthoringDraft({ projectRoot: root, sessionId: "s-bound" });
    const llm: AuthoringLlmFn = async () => JSON.stringify({
      title: "绑定书",
      oneLine: "一",
      proposition: "",
      protagonist: "",
      conflict: "",
      voice: "",
      boundaries: "",
      direction: "",
      openQuestions: [],
      targetChapters: 12,
      chapterWordCount: 2000,
    });
    const generated = await generateAskCanon({
      root: { projectRoot: root, draftId: draft.draftId },
      project: project(),
      llm,
      conversation: "建书",
    });
    const adopted = await adoptAskCanon({
      root: { projectRoot: root, draftId: draft.draftId },
      project: project(),
      artifactId: generated.artifactId,
    });
    const bookRoot = { projectRoot: root, bookId: adopted.bookId, draftId: draft.draftId };
    const weave = await generateWeaveRange({
      root: bookRoot,
      project: project(),
      llm: async () => JSON.stringify({
        chapters: [1, 2, 3, 4].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `W${n}` })),
      }),
      startChapter: 1,
      endChapter: 4,
      targetChapters: 4,
    });
    await adoptWeave({ root: bookRoot, project: project(), artifactId: weave.artifactId });
    const chapter = await generateChapterDraft({
      root: bookRoot,
      project: project(),
      llm: async () => "# 第1章\n正文。",
      chapterNumber: 1,
      title: "开篇",
    });
    await adoptChapterDraft({ root: bookRoot, project: project(), llm: async () => "状态", artifactId: chapter.artifactId });
    const before = await loadManifest(bookRoot);
    const renamed = await generateAskCanon({
      root: { projectRoot: root, draftId: draft.draftId },
      project: project(),
      llm: async () => JSON.stringify({
        title: "改名后",
        oneLine: "二",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
      }),
      conversation: "改名",
    });
    await adoptAskCanon({
      root: { projectRoot: root, draftId: draft.draftId },
      project: project(),
      artifactId: renamed.artifactId,
    });
    const after = await loadManifest(bookRoot);
    expect(after.adopted.weave).toBe(before.adopted.weave);
    expect(after.adopted.write).toEqual(before.adopted.write);
    expect(after.coverage.chaptersAdopted).toBe(before.coverage.chaptersAdopted);
    expect(after.adopted.ask).toBe(renamed.artifactId);
    const book = JSON.parse(await readFile(join(root, "books", adopted.bookId, "book.json"), "utf-8")) as { title: string };
    expect(book.title).toBe("改名后");
  });

  it("rebuilds an empty chapter index before adopting chapter 2 (R2-07)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r2-07-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "空索引", oneLine: "旧", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    await mkdir(join(created.bookDir, "chapters"), { recursive: true });
    await writeFile(join(created.bookDir, "chapters", "0001_旧稿.md"), "第一章旧正文。\n", "utf-8");
    await writeFile(join(created.bookDir, "chapters", "index.json"), "[]\n", "utf-8");
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm: (async () => "# 第2章\n新章。") as AuthoringLlmFn };
    const draft = await generateChapterDraft({ ...ctx, chapterNumber: 2, title: "新章" });
    await adoptChapterDraft({ ...ctx, artifactId: draft.artifactId });
    const index = JSON.parse(await readFile(join(created.bookDir, "chapters", "index.json"), "utf-8")) as Array<{ number: number }>;
    expect(index.map((item) => item.number).sort()).toEqual([1, 2]);
  });

  it("passes the first batch beats into the second batch of a fresh 1-8 run (R2-08)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r2-08-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "前批", oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 8 },
    });
    const seen: string[] = [];
    const llm: AuthoringLlmFn = async (call) => {
      const text = call.messages.map((message) => message.content).join("\n");
      seen.push(text);
      const match = /第 (\d+)-(\d+) 章/.exec(text);
      const start = Number(match?.[1] ?? 1);
      const end = Number(match?.[2] ?? 4);
      return JSON.stringify({
        chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
          chapterNumber: start + index,
          title: `章${start + index}`,
          summary: `KEEP_${start + index} 关键事件`,
        })),
      });
    };
    await generateWeaveRange({
      root: { projectRoot: root, bookId: created.bookId },
      project: project(),
      llm,
      startChapter: 1,
      endChapter: 8,
      targetChapters: 8,
    });
    expect(seen[1]).toContain("KEEP_1");
    expect(seen[1]).toContain("KEEP_4");
  });

  it("adopts the hand-edited artifact rather than the pre-save candidate (R3-01)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r3-01-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "手改采用", oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm: (async () => "CANDIDATE_V1") as AuthoringLlmFn };
    const draft = await generateChapterDraft({ ...ctx, chapterNumber: 1, title: "开篇" });
    const saved = await saveHandEditedArtifact(ctx.root, draft.artifactId, "R3_DIRTY_ADOPT\n");
    expect(saved.artifactId).not.toBe(draft.artifactId);
    await adoptChapterDraft({ ...ctx, artifactId: saved.artifactId });
    const body = await readFile(join(created.bookDir, "chapters", "0001_开篇.md"), "utf-8");
    expect(body).toContain("R3_DIRTY_ADOPT");
    expect(body).not.toContain("CANDIDATE_V1");
    const manifest = await loadManifest(ctx.root);
    expect(manifest.adopted.write["1"]).toBe(saved.artifactId);
    expect(manifest.candidates.write["1"]).toBe(saved.artifactId);
  });

  it("archives the previous chapter file before overwrite so it can be restored (R3-02)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r3-02-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "旧稿保护", oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    await mkdir(join(created.bookDir, "chapters"), { recursive: true });
    await writeFile(join(created.bookDir, "chapters", "0001_旧稿.md"), "R3_LEGACY_ONLY_8e7d\n", "utf-8");
    await persistAdoptedChapter({
      bookDir: created.bookDir,
      chapterNumber: 1,
      title: "新版标题",
      body: "新的正式正文。",
    });
    const versions = await listChapterVersions(created.bookDir, 1);
    expect(versions.length).toBeGreaterThan(0);
    const archived = await readChapterVersion(created.bookDir, 1, versions[versions.length - 1]!.id);
    expect(archived).toContain("R3_LEGACY_ONLY_8e7d");
    const current = await readFile(join(created.bookDir, "chapters", "0001_新版标题.md"), "utf-8");
    expect(current).toContain("新的正式正文");
  });

  it("stores every remaining hole when pausing after the first batch of 1-12 (R3-04)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r3-04-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "长暂停", oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const runId = newRunId();
    let calls = 0;
    const llm: AuthoringLlmFn = async (call) => {
      calls += 1;
      if (calls === 1) await saveRunControl({ projectRoot: root, bookId: created.bookId }, runId, "pause");
      const text = call.messages.map((message) => message.content).join("\n");
      const match = /第 (\d+)-(\d+) 章/.exec(text);
      const start = Number(match?.[1] ?? 1);
      const end = Number(match?.[2] ?? 4);
      return JSON.stringify({
        chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
          chapterNumber: start + index,
          title: `章${start + index}`,
          summary: `KEEP_${start + index}`,
        })),
      });
    };
    const paused = await generateWeaveRange({
      root: { projectRoot: root, bookId: created.bookId },
      project: project(),
      llm,
      startChapter: 1,
      endChapter: 12,
      targetChapters: 12,
      runId,
    });
    expect(paused.status).toBe("paused");
    const run = await loadRun({ projectRoot: root, bookId: created.bookId }, runId);
    expect(run?.checkpoint?.missingChapters).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    const seen: string[] = [];
    const resumed = await generateWeaveRange({
      root: { projectRoot: root, bookId: created.bookId },
      project: project(),
      llm: async (call) => {
        const text = call.messages.map((message) => message.content).join("\n");
        seen.push(text);
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        const start = Number(match?.[1] ?? 5);
        const end = Number(match?.[2] ?? 8);
        return JSON.stringify({
          chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
            chapterNumber: start + index,
            title: `章${start + index}`,
            summary: `FILL_${start + index}`,
          })),
        });
      },
      startChapter: 1,
      endChapter: 12,
      targetChapters: 12,
      resumeRunId: runId,
      missingChapters: run?.checkpoint?.missingChapters,
    });
    expect(resumed.beats.find((beat) => beat.chapterNumber === 1)?.summary).toContain("KEEP_1");
    expect(resumed.status).toBe("completed");
    expect(seen.some((text) => text.includes("第 9-12 章") || text.includes("第 9、10、11、12"))).toBe(true);
  });

  it("keeps v1 as the working candidate after selecting the original (R3-05)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r3-05-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "保留原稿", oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm: (async () => "R3_KEEP_ORIGINAL") as AuthoringLlmFn };
    const v1 = await generateChapterDraft({ ...ctx, chapterNumber: 3, title: "夜谈" });
    const v2 = await saveHandEditedArtifact(ctx.root, v1.artifactId, "MOCK_REVISION\n");
    await selectWriteCandidate({ ...ctx, chapterNumber: 3, artifactId: v1.artifactId });
    const manifest = await loadManifest(ctx.root);
    expect(manifest.candidates.write["3"]).toBe(v1.artifactId);
    expect(manifest.candidates.write["3"]).not.toBe(v2.artifactId);
    const kept = await loadArtifact(ctx.root, manifest.candidates.write["3"]!);
    expect(kept?.body).toContain("R3_KEEP_ORIGINAL");
    const later = await loadArtifact(ctx.root, v2.artifactId);
    expect(later?.body).toContain("MOCK_REVISION");
  });

  it("stops adopt when chapter archive cannot be created (R4-01)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r4-01-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "归档失败", oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    await mkdir(join(created.bookDir, "chapters"), { recursive: true });
    const originalPath = join(created.bookDir, "chapters", "0001_原章题.md");
    await writeFile(originalPath, "R4_ORIGINAL_MUST_SURVIVE\n", "utf-8");
    await writeFile(join(created.bookDir, "chapters", "index.json"), `${JSON.stringify([{
      number: 1,
      title: "原章题",
      status: "ready-for-review",
      wordCount: 8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      auditIssues: [],
      lengthWarnings: [],
    }], null, 2)}\n`, "utf-8");
    await writeFile(join(created.bookDir, "chapters", ".versions"), "BLOCK_ARCHIVE_DIRECTORY");
    await expect(persistAdoptedChapter({
      bookDir: created.bookDir,
      chapterNumber: 1,
      title: "原章题",
      body: "R4_REPLACED_AFTER_ARCHIVE_FAILED",
    })).rejects.toThrow(/归档/);
    expect(await readFile(originalPath, "utf-8")).toContain("R4_ORIGINAL_MUST_SURVIVE");
    const index = JSON.parse(await readFile(join(created.bookDir, "chapters", "index.json"), "utf-8")) as Array<{ title: string }>;
    expect(index[0]?.title).toBe("原章题");
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm: (async () => "R4_REPLACED_AFTER_ARCHIVE_FAILED") as AuthoringLlmFn };
    const draft = await generateChapterDraft({ ...ctx, chapterNumber: 1, title: "原章题" });
    await expect(adoptChapterDraft({ ...ctx, artifactId: draft.artifactId })).rejects.toThrow(/归档/);
    const manifest = await loadManifest(ctx.root);
    expect(manifest.adopted.write["1"]).toBeUndefined();
    expect(await readFile(originalPath, "utf-8")).toContain("R4_ORIGINAL_MUST_SURVIVE");
  });

  it("binds a restored chapter to its real title and path (R4-02)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r4-02-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "恢复章题", oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    await persistAdoptedChapter({
      bookDir: created.bookDir,
      chapterNumber: 1,
      title: "新版标题",
      body: "R4_RESTORED_BODY",
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm: (async () => "状态") as AuthoringLlmFn };
    const bound = await bindRestoredChapter({
      root: ctx.root,
      chapterNumber: 1,
      title: "新版标题",
      relativePath: "chapters/0001_新版标题.md",
      body: "R4_RESTORED_BODY",
    });
    const artifact = await loadArtifact(ctx.root, bound.artifactId);
    expect(artifact?.meta.bodyPath).toBe("chapters/0001_新版标题.md");
    expect(artifact?.meta.label).toContain("新版标题");
    expect(artifact?.meta.label).not.toMatch(/第1章恢复$/);
    await adoptChapterDraft({ ...ctx, artifactId: bound.artifactId });
    const index = JSON.parse(await readFile(join(created.bookDir, "chapters", "index.json"), "utf-8")) as Array<{ title: string; number: number }>;
    expect(index.find((item) => item.number === 1)?.title).toBe("新版标题");
    const files = await readFile(join(created.bookDir, "chapters", "0001_新版标题.md"), "utf-8");
    expect(files).toContain("R4_RESTORED_BODY");
    await expect(readFile(join(created.bookDir, "chapters", "0001_chapter.md"), "utf-8")).rejects.toThrow();
    const manifest = await loadManifest(ctx.root);
    expect(manifest.adopted.write["1"]).toBe(bound.artifactId);
    expect(manifest.candidates.write["1"]).toBe(bound.artifactId);
  });

  it("keeps full chapter titles with punctuation and length after restore, edit, and adopt (R5-01)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r5-01-"));
    const titles = [
      "夜谈",
      "雨夜：最后一封信",
      "那天晚上我们终于知道了这座城所有秘密的来龙去脉",
    ];
    for (const [offset, title] of titles.entries()) {
      const created = await createLightweightBook({
        projectRoot: root,
        canon: { title: `章题${offset}`, oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
        existingBookId: `title-book-${offset}`,
      });
      const chapterNumber = 1;
      await persistAdoptedChapter({
        bookDir: created.bookDir,
        chapterNumber,
        title,
        body: `ORIG_${title}`,
      });
      const located = await findChapterRelativePath(created.bookDir, chapterNumber);
      expect(located?.title).toBe(title);
      const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm: (async () => "状态") as AuthoringLlmFn };
      const restored = await bindRestoredChapter({
        root: ctx.root,
        chapterNumber,
        title,
        relativePath: located?.relativePath,
        body: `ORIG_${title}`,
      });
      const restoredMeta = await loadArtifact(ctx.root, restored.artifactId);
      expect(restoredMeta?.meta.title).toBe(title);
      const edited = await saveHandEditedArtifact(ctx.root, restored.artifactId, `EDIT_${title}\n`);
      expect(edited.title).toBe(title);
      await adoptChapterDraft({ ...ctx, artifactId: edited.artifactId });
      const index = JSON.parse(await readFile(join(created.bookDir, "chapters", "index.json"), "utf-8")) as Array<{ title: string; number: number }>;
      expect(index.find((item) => item.number === 1)?.title).toBe(title);
      expect(index.find((item) => item.number === 1)?.title).not.toBe("雨夜-最后一封信");
      expect(index.find((item) => item.number === 1)?.title?.endsWith("来龙去脉") || title !== titles[2]).toBeTruthy();
      const currentPath = (await findChapterRelativePath(created.bookDir, 1))!.relativePath;
      expect(currentPath).toBe(located?.relativePath);
      expect(await readFile(join(created.bookDir, currentPath), "utf-8")).toContain(`EDIT_${title}`);
      const after = await loadManifest(ctx.root);
      expect(after.adopted.write["1"]).toBe(edited.artifactId);
    }
  });

  it("keeps a punctuated title after generate, revise, and adopt (R5-01)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r5-01b-"));
    const title = "雨夜：最后一封信";
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "生成章题", oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const ctx = {
      root: { projectRoot: root, bookId: created.bookId },
      project: project(),
      llm: (async (call) => {
        if (call.roleId === "write.review") {
          return JSON.stringify({
            summary: "可",
            coverage: "chapter:1",
            issues: [{ issueId: "i1", title: "收束", severity: "improve", suggestion: "收一句" }],
          });
        }
        return `正文《${title}》`;
      }) as AuthoringLlmFn,
    };
    const generated = await generateChapterDraft({ ...ctx, chapterNumber: 1, title });
    const generatedMeta = await loadArtifact(ctx.root, generated.artifactId);
    expect(generatedMeta?.meta.title).toBe(title);
    const report = await reviewChapterDraft({ ...ctx, artifactId: generated.artifactId });
    const revised = await reviseChapterDraft({
      ...ctx,
      artifactId: generated.artifactId,
      reportId: report.reportId,
      selectedIssueIds: ["i1"],
    });
    await adoptChapterDraft({ ...ctx, artifactId: revised.artifactId });
    const index = JSON.parse(await readFile(join(created.bookDir, "chapters", "index.json"), "utf-8")) as Array<{ title: string }>;
    expect(index[0]?.title).toBe(title);
  });

  it("keeps saved weave hand-edits when resuming a paused run (R7-03)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r7-03-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "续跑手改", oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await adoptPlannedStructure(ctx, [
      { volumeNumber: 1, title: "原卷", startChapter: 1, endChapter: 8, body: "原卷纲" },
    ], "ORIGINAL_STRUCTURE");
    const runId = newRunId();
    let calls = 0;
    const paused = await generateWeaveRange({
      ...ctx,
      llm: async (call) => {
        calls += 1;
        if (calls === 1) await saveRunControl({ projectRoot: root, bookId: created.bookId }, runId, "pause");
        const text = call.messages.map((message) => message.content).join("\n");
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        const start = Number(match?.[1] ?? 1);
        const end = Number(match?.[2] ?? 4);
        return JSON.stringify({
          bookOutline: "ORIGINAL_STRUCTURE",
          volumes: [{ volumeNumber: 1, title: "原卷", startChapter: 1, endChapter: 8, body: "原卷纲" }],
          chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
            chapterNumber: start + index,
            title: `章${start + index}`,
            summary: `ORIGINAL_${start + index}`,
          })),
        });
      },
      startChapter: 1,
      endChapter: 8,
      targetChapters: 8,
      runId,
    });
    expect(paused.status).toBe("paused");
    const loaded = await loadArtifact({ projectRoot: root, bookId: created.bookId }, paused.artifactId);
    const edited = (loaded?.body ?? "")
      .replace("ORIGINAL_1", "SAVED_MANUAL_1")
      .replace("ORIGINAL_STRUCTURE", "SAVED_STRUCTURE")
      .replace("原卷纲", "SAVED_VOLUME");
    const saved = await saveHandEditedArtifact({ projectRoot: root, bookId: created.bookId }, paused.artifactId, edited);
    const resumed = await generateWeaveRange({
      root: { projectRoot: root, bookId: created.bookId },
      project: project(),
      llm: async (call) => {
        const text = call.messages.map((message) => message.content).join("\n");
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        const start = Number(match?.[1] ?? 5);
        const end = Number(match?.[2] ?? 8);
        return JSON.stringify({
          chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
            chapterNumber: start + index,
            title: `章${start + index}`,
            summary: `FILL_${start + index}`,
          })),
        });
      },
      startChapter: 1,
      endChapter: 8,
      targetChapters: 8,
      resumeRunId: runId,
    });
    expect(resumed.beats.find((beat) => beat.chapterNumber === 1)?.summary).toContain("SAVED_MANUAL_1");
    expect(resumed.beats.find((beat) => beat.chapterNumber === 5)?.summary).toContain("FILL_5");
    const next = await loadArtifact({ projectRoot: root, bookId: created.bookId }, resumed.artifactId);
    expect(next?.body).toContain("SAVED_MANUAL_1");
    expect(next?.body).toContain("SAVED_STRUCTURE");
    expect(next?.body).toContain("SAVED_VOLUME");
    expect(saved.artifactId).not.toBe(paused.artifactId);
  });

  it("keeps original beats when revise returns only the selected chapter (R7-04)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r7-04-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "修订漏章", oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const generated = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [1, 2, 3, 4].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `KEEP_${n} 完整概要` })),
      }),
      startChapter: 1,
      endChapter: 4,
      targetChapters: 4,
    });
    const report = parseReviewPayload(JSON.stringify({
      summary: "第二章可收",
      issues: [{ issueId: "w1", title: "收束", severity: "improve", suggestion: "改第2章" }],
    }), {
      stage: "weave",
      targetRefs: [generated.artifactId],
      coverage: "1-4",
      model: "weave-review",
    });
    await saveReport(ctx.root, report);
    const nextId = await reviseWeave({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [{ chapterNumber: 2, title: "章2改", summary: "REVISED_2 收束后的概要" }],
      }),
      artifactId: generated.artifactId,
      reportId: report.reportId,
      selectedIssueIds: ["w1"],
      startChapter: 1,
      endChapter: 4,
    });
    const revised = await loadArtifact(ctx.root, nextId);
    expect(revised?.body).toContain("KEEP_1");
    expect(revised?.body).toContain("REVISED_2");
    expect(revised?.body).toContain("KEEP_3");
    expect(revised?.body).toContain("KEEP_4");
    expect(revised?.body).not.toContain("（待补概要）");
  });

  it("uses the adopted outline title when generate is not given a title (R7-08)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r7-08-"));
    const created = await createLegacyBook({
      projectRoot: root,
      title: "规划章题",
      targetChapters: 8,
    });
    await mkdir(join(created.bookDir, "story", "outline"), { recursive: true });
    await writeFile(
      join(created.bookDir, "story", "outline", "volume_map.md"),
      "## 第 1 章 雨夜：最后一封信\n\n港口开场。\n",
      "utf-8",
    );
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm: (async () => "# 第1章\n信还在桌上。") as AuthoringLlmFn };
    const draft = await generateChapterDraft({ ...ctx, chapterNumber: 1 });
    const meta = await loadArtifact(ctx.root, draft.artifactId);
    expect(meta?.meta.title).toBe("雨夜：最后一封信");
    await adoptChapterDraft({ ...ctx, artifactId: draft.artifactId, llm: async () => "状态" });
    const index = JSON.parse(await readFile(join(created.bookDir, "chapters", "index.json"), "utf-8")) as Array<{ title: string }>;
    expect(index[0]?.title).toBe("雨夜：最后一封信");
  });

  it("does not inject stale chapter state after restore or failed settle (R7-09)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r7-09-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "状态版本", oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const alive = await generateChapterDraft({
      ...ctx,
      llm: async () => "ALIVE_BODY 生还",
      chapterNumber: 1,
      title: "生还",
    });
    await adoptChapterDraft({
      ...ctx,
      artifactId: alive.artifactId,
      llm: async () => "ALIVE_STATE 他活着",
    });
    const withAlive = await assembleAuthoringContext(ctx.root, { stage: "write", chapterNumber: 2 });
    expect(withAlive.text).toContain("ALIVE_STATE");
    await persistAdoptedChapter({
      bookDir: created.bookDir,
      chapterNumber: 1,
      title: "生还",
      body: "RESTORED_BODY 回到岸上",
    });
    await bindRestoredChapter({
      root: ctx.root,
      chapterNumber: 1,
      title: "生还",
      relativePath: "chapters/0001_生还.md",
      body: "RESTORED_BODY 回到岸上",
    });
    const afterRestore = await assembleAuthoringContext(ctx.root, { stage: "write", chapterNumber: 2 });
    expect(afterRestore.text).not.toContain("ALIVE_STATE");
    const death = await generateChapterDraft({
      ...ctx,
      llm: async () => "DEATH_BODY 他死了",
      chapterNumber: 1,
      title: "生还",
    });
    const failed = await adoptChapterDraft({
      ...ctx,
      artifactId: death.artifactId,
      llm: async (call) => {
        if (call.messages.some((message) => message.content.includes("整理人物状态"))) {
          throw new Error("settle timeout");
        }
        return "unused";
      },
    });
    expect(failed.adopted).toBe(true);
    expect(failed.settled).toBe(false);
    const afterFail = await assembleAuthoringContext(ctx.root, { stage: "write", chapterNumber: 2 });
    expect(afterFail.text).not.toContain("ALIVE_STATE");
    expect(afterFail.text).not.toContain("他活着");
  });

  it("keeps book outline and volume title from absorbing revised chapter summaries (R8-02)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r8-02-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "林一", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await adoptPlannedStructure(ctx, [
      { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 8, body: "唯一卷纲 VOLUME_OVERVIEW。" },
    ], "唯一全书纲 BOOK_OVERVIEW。");
    const generated = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "唯一全书纲 BOOK_OVERVIEW。",
        volumes: [{ volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 8, body: "唯一卷纲 VOLUME_OVERVIEW。" }],
        chapters: [
          { chapterNumber: 1, title: "信件1", summary: "REVOKED_V0 林一在第1章死亡。" },
          { chapterNumber: 2, title: "信件2", summary: "CHAPTER_2" },
          { chapterNumber: 3, title: "信件3", summary: "CHAPTER_3" },
          { chapterNumber: 4, title: "信件4", summary: "CHAPTER_4" },
        ],
      }),
      startChapter: 1,
      endChapter: 4,
      targetChapters: 8,
    });
    const report = parseReviewPayload(JSON.stringify({
      summary: "改第1章",
      issues: [{ issueId: "w1", title: "改结局", severity: "priority", suggestion: "不要死亡" }],
    }), {
      stage: "weave",
      targetRefs: [generated.artifactId],
      coverage: "1-4",
      model: "weave-review",
    });
    await saveReport(ctx.root, report);
    const v1 = await reviseWeave({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [
          { chapterNumber: 1, title: "信件1", summary: "REVOKED_V1 林一在第1章健康生还。" },
          { chapterNumber: 2, title: "信件2", summary: "CHAPTER_2" },
          { chapterNumber: 3, title: "信件3", summary: "CHAPTER_3" },
          { chapterNumber: 4, title: "信件4", summary: "CHAPTER_4" },
        ],
      }),
      artifactId: generated.artifactId,
      reportId: report.reportId,
      selectedIssueIds: ["w1"],
      startChapter: 1,
      endChapter: 4,
    });
    const v2 = await reviseWeave({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [
          { chapterNumber: 1, title: "信件1", summary: "CURRENT_V2 林一在第1章受伤生还，右臂无法抬起。" },
          { chapterNumber: 2, title: "信件2", summary: "CHAPTER_2" },
          { chapterNumber: 3, title: "信件3", summary: "CHAPTER_3" },
          { chapterNumber: 4, title: "信件4", summary: "CHAPTER_4" },
        ],
      }),
      artifactId: v1,
      reportId: report.reportId,
      selectedIssueIds: ["w1"],
      startChapter: 1,
      endChapter: 4,
      reuseStale: true,
    });
    const revised = await loadArtifact(ctx.root, v2);
    expect(revised?.body).toContain("CURRENT_V2");
    expect(revised?.body).not.toContain("REVOKED_V0");
    expect(revised?.body).not.toContain("REVOKED_V1");
    expect(revised?.body).toMatch(/第1卷 纸城/);
    expect(revised?.body).not.toMatch(/第1卷 第1卷/);
    await adoptWeave({ ...ctx, artifactId: v2 });
    const next = await generateWeaveRange({
      ...ctx,
      llm: async (call) => {
        const text = call.messages.map((message) => message.content).join("\n");
        expect(text).not.toContain("REVOKED_V0");
        expect(text).not.toContain("REVOKED_V1");
        expect(text).toContain("BOOK_OVERVIEW");
        expect(text).toContain("CURRENT_V2");
        return JSON.stringify({
          chapters: [5, 6, 7, 8].map((n) => ({ chapterNumber: n, title: `信件${n}`, summary: `CHAPTER_${n}` })),
        });
      },
      startChapter: 5,
      endChapter: 8,
      targetChapters: 8,
    });
    const stored = JSON.parse(await readFile(
      join(root, "books", created.bookId, "story", "workflow", "artifacts", next.artifactId, "beats.json"),
      "utf-8",
    )) as { bookOutline?: string; volumes?: Array<{ title: string }> };
    expect(stored.bookOutline).toContain("BOOK_OVERVIEW");
    expect(stored.bookOutline).not.toContain("REVOKED_V0");
    expect(stored.bookOutline).not.toContain("REVOKED_V1");
    expect(stored.bookOutline).not.toContain("CURRENT_V2");
    expect(stored.volumes?.[0]?.title).toBe("纸城");
  });

  it("uses the planned title when hand-writing a new chapter without an explicit title (R8-03)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r8-03-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "信件", oneLine: "测", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    await mkdir(join(created.bookDir, "story", "outline"), { recursive: true });
    await writeFile(
      join(created.bookDir, "story", "outline", "volume_map.md"),
      "## 第 1 章 信件1\n\n开场。\n\n## 第 2 章 信件2\n\n续写。\n",
      "utf-8",
    );
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm: (async () => "状态") as AuthoringLlmFn };
    const saved = await saveWriteBody({
      ...ctx,
      chapterNumber: 2,
      body: "手写第2章正文。",
    });
    const meta = await loadArtifact(ctx.root, saved.artifactId);
    expect(meta?.meta.title).toBe("信件2");
    expect(meta?.meta.label).not.toContain("手改");
    await adoptChapterDraft({ ...ctx, artifactId: saved.artifactId });
    const index = JSON.parse(await readFile(join(created.bookDir, "chapters", "index.json"), "utf-8")) as Array<{ number: number; title: string }>;
    expect(index.find((item) => item.number === 2)?.title).toBe("信件2");
    const explicit = await saveWriteBody({
      ...ctx,
      chapterNumber: 3,
      title: "雨夜：最后一封信",
      body: "显式标题。",
    });
    const explicitMeta = await loadArtifact(ctx.root, explicit.artifactId);
    expect(explicitMeta?.meta.title).toBe("雨夜：最后一封信");
  });

  it("keeps 2 volumes and 8 unique chapters after revising plain, bold, and mixed headings (R9-02)", async () => {
    const restyle = (body: string, style: "standard" | "plain" | "bold" | "mixed"): string => {
      if (style === "plain") {
        return body
          .replace(/^##\s+(第\d+卷[^\n]+)$/gm, "$1")
          .replace(/^##\s+(第\s+\d+\s+章[^\n]+)$/gm, "$1");
      }
      if (style === "bold") {
        return body
          .replace(/^##\s+第(\d+)卷\s+/gm, "## **第$1卷** ")
          .replace(/^##\s+第\s+(\d+)\s+章\s+/gm, "## **第 $1 章** ");
      }
      if (style === "mixed") {
        return `叙述里会提到第1章和第2卷，但那不是标题。\n\n${restyle(body, "plain")
          .replace(/^第 1 章 /m, "## **第 1 章** ")}`;
      }
      return body;
    };
    for (const style of ["standard", "plain", "bold", "mixed"] as const) {
      root = await mkdtemp(join(tmpdir(), `authoring-r9-02-${style}-`));
      const created = await createLightweightBook({
        projectRoot: root,
        canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "林一", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
      });
      const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
      await adoptPlannedStructure(ctx, [
        { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 4, body: "VOL1_ONLY。" },
        { volumeNumber: 2, title: "南岸", startChapter: 5, endChapter: 8, body: "VOL2_ONLY。" },
      ], "唯一全书纲 BOOK_OVERVIEW。");
      const generated = await generateWeaveRange({
        ...ctx,
        llm: async () => JSON.stringify({
          bookOutline: "唯一全书纲 BOOK_OVERVIEW。",
          volumes: [
            { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 4, body: "VOL1_ONLY。" },
            { volumeNumber: 2, title: "南岸", startChapter: 5, endChapter: 8, body: "VOL2_ONLY。" },
          ],
          chapters: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
            chapterNumber: n,
            title: `信件${n}`,
            summary: n === 1 ? "DEATH_BEAT 林一在第1章死亡。" : `KEEP_${n}`,
          })),
        }),
        startChapter: 1,
        endChapter: 8,
        targetChapters: 8,
      });
      const styled = restyle((await loadArtifact(ctx.root, generated.artifactId))?.body ?? "", style);
      const beforeTree = parseVolumeMapTree(styled);
      expect(beforeTree.volumeCount).toBe(2);
      expect(beforeTree.chapterCount).toBe(8);
      const saved = await saveHandEditedArtifact(ctx.root, generated.artifactId, styled);
      const report = parseReviewPayload(JSON.stringify({
        summary: "改第1章",
        issues: [{ issueId: "w1", title: "改结局", severity: "priority", suggestion: "改为生还" }],
      }), {
        stage: "weave",
        targetRefs: [saved.artifactId],
        coverage: "1-4",
        model: "weave-review",
      });
      await saveReport(ctx.root, report);
      const revisedId = await reviseWeave({
        ...ctx,
        llm: async () => JSON.stringify({
          chapters: [1, 2, 3, 4].map((n) => ({
            chapterNumber: n,
            title: `信件${n}`,
            summary: n === 1 ? "SURVIVE_BEAT 林一在第1章生还。" : `KEEP_${n}`,
          })),
        }),
        artifactId: saved.artifactId,
        reportId: report.reportId,
        selectedIssueIds: ["w1"],
        startChapter: 1,
        endChapter: 4,
      });
      const revised = await loadArtifact(ctx.root, revisedId);
      const tree = parseVolumeMapTree(revised?.body ?? "");
      expect(tree.volumeCount, style).toBe(2);
      expect(tree.chapterCount, style).toBe(8);
      const numbers = [...tree.volumes.flatMap((volume) => volume.chapters), ...tree.orphanChapters]
        .filter((chapter) => chapter.kind === "chapter")
        .map((chapter) => chapter.chapterNumber);
      expect(new Set(numbers).size, style).toBe(8);
      expect(revised?.body).not.toContain("DEATH_BEAT");
      expect(findChapterNode(tree, 1)?.summary).toContain("SURVIVE_BEAT");
      expect(findChapterNode(tree, 1)?.summary).not.toContain("DEATH_BEAT");
      expect(tree.volumes[0]?.body).toContain("VOL1_ONLY");
      expect(tree.volumes[0]?.body).not.toContain("VOL2_ONLY");
      await adoptWeave({ ...ctx, artifactId: revisedId });
      const seen: string[] = [];
      await generateChapterDraft({
        ...ctx,
        llm: async (call) => {
          seen.push(call.messages.map((message) => message.content).join("\n"));
          return "正文。";
        },
        chapterNumber: 1,
      });
      expect(seen.join("\n")).toContain("SURVIVE_BEAT");
      expect(seen.join("\n")).not.toContain("DEATH_BEAT");
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("keeps leading author notes when revising a single chapter (R10-01)", async () => {
    const notes = [
      ["## 第1卷·节点A", "NOTE_DOT 作者要求全书坚持限知视角，禁止提前泄露幕后身份。"],
      ["## 第一卷：人物弧线", "NOTE_COLON 作者要求配角不会背叛主角。"],
      ["## **第1卷**·节点A", "NOTE_BOLD 作者要求保留配角的生还线索。"],
    ] as const;
    for (const [heading, noteBody] of notes) {
      root = await mkdtemp(join(tmpdir(), "authoring-r10-01-"));
      const created = await createLightweightBook({
        projectRoot: root,
        canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "林一", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
      });
      const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
      await adoptPlannedStructure(ctx, [
        { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 4, body: "VOL1_ONLY。" },
        { volumeNumber: 2, title: "南岸", startChapter: 5, endChapter: 8, body: "VOL2_ONLY。" },
      ], "唯一全书纲 BOOK_OVERVIEW。");
      const generated = await generateWeaveRange({
        ...ctx,
        llm: async () => JSON.stringify({
          bookOutline: "唯一全书纲 BOOK_OVERVIEW。",
          volumes: [
            { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 4, body: "VOL1_ONLY。" },
            { volumeNumber: 2, title: "南岸", startChapter: 5, endChapter: 8, body: "VOL2_ONLY。" },
          ],
          chapters: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
            chapterNumber: n,
            title: `信件${n}`,
            summary: n === 1 ? "DEATH_BEAT 林一在第1章死亡。" : `KEEP_${n}`,
          })),
        }),
        startChapter: 1,
        endChapter: 8,
        targetChapters: 8,
      });
      const original = (await loadArtifact(ctx.root, generated.artifactId))?.body ?? "";
      const preamble = "唯一全书纲 BOOK_OVERVIEW。";
      const rest = original.slice(original.indexOf(preamble) + preamble.length).replace(/^\n+/, "");
      const withNote = `${preamble}\n\n${heading}\n${noteBody}\n\n${rest}`;
      expect(parseVolumeMapTree(withNote).orphanNotes.length).toBe(1);
      const saved = await saveHandEditedArtifact(ctx.root, generated.artifactId, withNote);
      const report = parseReviewPayload(JSON.stringify({
        summary: "改第1章",
        issues: [{ issueId: "w1", title: "改结局", severity: "priority", suggestion: "改为生还" }],
      }), {
        stage: "weave",
        targetRefs: [saved.artifactId],
        coverage: "1-1",
        model: "weave-review",
      });
      await saveReport(ctx.root, report);
      const reviseOnce = async (artifactId: string, summary: string) => reviseWeave({
        ...ctx,
        llm: async () => JSON.stringify({
          chapters: [{ chapterNumber: 1, title: "信件1", summary }],
        }),
        artifactId,
        reportId: report.reportId,
        selectedIssueIds: ["w1"],
        startChapter: 1,
        endChapter: 1,
        reuseStale: true,
      });
      const firstId = await reviseOnce(saved.artifactId, "SURVIVE_BEAT 林一在第1章生还。");
      const first = await loadArtifact(ctx.root, firstId);
      const secondId = await reviseOnce(firstId, "SURVIVE_BEAT 林一在第1章生还，右臂无法抬起。");
      const second = await loadArtifact(ctx.root, secondId);
      for (const body of [first?.body ?? "", second?.body ?? ""]) {
        const tree = parseVolumeMapTree(body);
        expect(tree.volumeCount).toBe(2);
        expect(tree.chapterCount).toBe(8);
        expect(tree.orphanNotes.length).toBe(1);
        expect(body).toContain(noteBody);
        expect(body.split(noteBody).length - 1).toBe(1);
        expect(body).toContain("KEEP_2");
        expect(body).toContain("KEEP_8");
        expect(body).not.toContain("DEATH_BEAT");
      }
      await adoptWeave({ ...ctx, artifactId: secondId });
      const adopted = await readFile(join(created.bookDir, "story", "outline", "volume_map.md"), "utf-8");
      expect(adopted).toContain(noteBody);
      const seen: string[] = [];
      await generateChapterDraft({
        ...ctx,
        llm: async (call) => {
          seen.push(call.messages.map((message) => message.content).join("\n"));
          return "正文。";
        },
        chapterNumber: 1,
      });
      expect(seen.join("\n")).toContain(noteBody);
      expect(seen.join("\n")).toContain("SURVIVE_BEAT");
      expect(seen.join("\n")).not.toContain("DEATH_BEAT");
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("keeps range nodes and in-volume notes when revising one chapter (R11-01)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r11-01-"));
    const created = await createLegacyBook({
      projectRoot: root,
      title: "纸城",
      targetChapters: 5,
    });
    const source = [
      "# 全书大纲",
      "BOOK_OVERVIEW",
      "",
      "## 第1卷·节点A",
      "LEADING_NOTE",
      "",
      "## 第1卷 纸城（1-4章）",
      "VOL1_BODY",
      "",
      "## 第1卷：人物弧线",
      "PRECHAPTER_NOTE",
      "",
      "## 第 1 章 初信",
      "CH1_SUMMARY",
      "",
      "## 第1卷·节点B",
      "BETWEEN_NOTE",
      "",
      "## 第2-3章 雨途",
      "RANGE_2_3_SUMMARY",
      "",
      "## 第 4 章 归港",
      "CH4_SUMMARY",
      "",
      "## 第1卷·节点C",
      "TRAILING_NOTE",
      "",
      "## 第2卷 南岸（5-5章）",
      "VOL2_BODY",
      "",
      "## 第 5 章 渡口",
      "CH5_SUMMARY",
      "",
    ].join("\n");
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const seeded = await saveHandEditedArtifact(ctx.root, (await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "BOOK_OVERVIEW",
        chapters: [{ chapterNumber: 1, title: "初信", summary: "CH1_SUMMARY" }],
      }),
      startChapter: 1,
      endChapter: 1,
      targetChapters: 5,
    })).artifactId, source);
    const report = parseReviewPayload(JSON.stringify({
      summary: "改第1章",
      issues: [{ issueId: "w1", title: "改结局", severity: "priority", suggestion: "改为生还" }],
    }), {
      stage: "weave",
      targetRefs: [seeded.artifactId],
      coverage: "1-1",
      model: "weave-review",
    });
    await saveReport(ctx.root, report);
    const reviseOnce = (artifactId: string, summary: string) => reviseWeave({
      ...ctx,
      llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "初信", summary }] }),
      artifactId,
      reportId: report.reportId,
      selectedIssueIds: ["w1"],
      startChapter: 1,
      endChapter: 1,
      reuseStale: true,
    });
    const firstId = await reviseOnce(seeded.artifactId, "CH1_UPDATED 生还");
    const secondId = await reviseOnce(firstId, "CH1_UPDATED 再次生还");
    const body = (await loadArtifact(ctx.root, secondId))?.body ?? "";
    const tree = parseVolumeMapTree(body);
    expect(tree.chapterCount).toBe(5);
    expect(body).toContain("CH1_UPDATED 再次生还");
    expect(body).not.toContain("CH1_SUMMARY");
    for (const marker of ["LEADING_NOTE", "PRECHAPTER_NOTE", "BETWEEN_NOTE", "RANGE_2_3_SUMMARY", "TRAILING_NOTE", "CH4_SUMMARY", "CH5_SUMMARY"]) {
      expect(body.split(marker).length - 1).toBe(1);
    }
    await adoptWeave({ ...ctx, artifactId: secondId });
    const adopted = await readFile(join(created.bookDir, "story", "outline", "volume_map.md"), "utf-8");
    expect(adopted).toContain("BETWEEN_NOTE");
    expect(adopted).toContain("RANGE_2_3_SUMMARY");
    expect(adopted).toContain("TRAILING_NOTE");
  });

  it("does not restore a deleted leading note on resume (R11-03)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r11-03-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const first = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "BOOK_OVERVIEW",
        volumes: [{ volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 8, body: "VOL" }],
        chapters: [1, 2, 3, 4].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `KEEP_${n}` })),
      }),
      startChapter: 1,
      endChapter: 4,
      targetChapters: 8,
    });
    const withNote = `${(await loadArtifact(ctx.root, first.artifactId))?.body ?? ""}\n`.replace(
      "BOOK_OVERVIEW",
      "BOOK_OVERVIEW\n\n## 第1卷·节点A\nWITHDRAWN_NOTE 限知视角。",
    );
    const noted = await saveHandEditedArtifact(ctx.root, first.artifactId, withNote);
    const partial = await generateWeaveRange({
      ...ctx,
      llm: async (call) => {
        const text = call.messages.map((message) => message.content).join("\n");
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        const start = Number(match?.[1] ?? 5);
        if (start !== 5) {
          return JSON.stringify({ chapters: [{ chapterNumber: start, title: `章${start}`, summary: `FILL_${start}` }] });
        }
        return JSON.stringify({
          chapters: [{ chapterNumber: 5, title: "章5", summary: "KEEP_5" }],
        });
      },
      startChapter: 5,
      endChapter: 8,
      targetChapters: 8,
    });
    expect(partial.status).toBe("partial");
    const stripped = ((await loadArtifact(ctx.root, partial.artifactId))?.body ?? "").replace(/## 第1卷·节点A\nWITHDRAWN_NOTE 限知视角。\n*/g, "");
    expect(stripped).not.toContain("WITHDRAWN_NOTE");
    const deleted = await saveHandEditedArtifact(ctx.root, partial.artifactId, stripped);
    await adoptWeave({ ...ctx, artifactId: deleted.artifactId });
    const seen: string[] = [];
    const resumed = await generateWeaveRange({
      ...ctx,
      llm: async (call) => {
        const text = call.messages.map((message) => message.content).join("\n");
        seen.push(text);
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        const start = Number(match?.[1] ?? 6);
        const end = Number(match?.[2] ?? 8);
        return JSON.stringify({
          chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
            chapterNumber: start + index,
            title: `章${start + index}`,
            summary: `FILL_${start + index}`,
          })),
        });
      },
      startChapter: 5,
      endChapter: 8,
      targetChapters: 8,
      resumeRunId: partial.runId,
    });
    expect(resumed.beats.find((beat) => beat.chapterNumber === 5)?.summary).toContain("KEEP_5");
    const next = await loadArtifact(ctx.root, resumed.artifactId);
    expect(next?.body).not.toContain("WITHDRAWN_NOTE");
    expect(seen.join("\n")).not.toContain("WITHDRAWN_NOTE");
    await adoptWeave({ ...ctx, artifactId: resumed.artifactId });
    const adopted = await readFile(join(created.bookDir, "story", "outline", "volume_map.md"), "utf-8");
    expect(adopted).not.toContain("WITHDRAWN_NOTE");
    const writeSeen: string[] = [];
    await generateChapterDraft({
      ...ctx,
      llm: async (call) => {
        writeSeen.push(call.messages.map((message) => message.content).join("\n"));
        return "正文。";
      },
      chapterNumber: 6,
    });
    expect(writeSeen.join("\n")).not.toContain("WITHDRAWN_NOTE");
  });

  it("sends the current saved notes on weave resume (R11-04)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r11-04-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const runId = newRunId();
    let calls = 0;
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const paused = await generateWeaveRange({
      ...ctx,
      llm: async (call) => {
        calls += 1;
        if (calls === 1) await saveRunControl(ctx.root, runId, "pause");
        const text = call.messages.map((message) => message.content).join("\n");
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        const start = Number(match?.[1] ?? 1);
        const end = Number(match?.[2] ?? 4);
        return JSON.stringify({
          bookOutline: "BOOK_OVERVIEW",
          volumes: [{ volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 8, body: "VOL" }],
          chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
            chapterNumber: start + index,
            title: `章${start + index}`,
            summary: `KEEP_${start + index}`,
          })),
        });
      },
      startChapter: 1,
      endChapter: 8,
      targetChapters: 8,
      runId,
    });
    expect(paused.status).toBe("paused");
    const insertLeadingNote = (body: string, heading: string, note: string) => {
      const marker = "BOOK_OVERVIEW";
      if (!body.includes(marker)) return `${heading}\n${note}\n\n${body}`;
      return body.replace(marker, `${marker}\n\n${heading}\n${note}`);
    };
    const added = await saveHandEditedArtifact(
      ctx.root,
      paused.artifactId,
      insertLeadingNote((await loadArtifact(ctx.root, paused.artifactId))?.body ?? "", "## 第1卷·节点A", "CURRENT_NOTE 限知视角，禁止揭露幕后身份。"),
    );
    const seen: string[] = [];
    await generateWeaveRange({
      ...ctx,
      llm: async (call) => {
        const text = call.messages.map((message) => message.content).join("\n");
        seen.push(text);
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        const start = Number(match?.[1] ?? 5);
        const end = Number(match?.[2] ?? 8);
        return JSON.stringify({
          chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
            chapterNumber: start + index,
            title: `章${start + index}`,
            summary: `FILL_${start + index}`,
          })),
        });
      },
      startChapter: 1,
      endChapter: 8,
      targetChapters: 8,
      resumeRunId: runId,
    });
    expect(seen.join("\n")).toContain("CURRENT_NOTE");
    expect(seen.join("\n")).toContain("限知视角");
    await adoptWeave({ ...ctx, artifactId: added.artifactId });
    await setBookTarget(ctx.root, 16);
    const nextRun = newRunId();
    let nextCalls = 0;
    const pausedAgain = await generateWeaveRange({
      ...ctx,
      llm: async (call) => {
        nextCalls += 1;
        if (nextCalls === 1) await saveRunControl(ctx.root, nextRun, "pause");
        const text = call.messages.map((message) => message.content).join("\n");
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        const start = Number(match?.[1] ?? 9);
        const end = Number(match?.[2] ?? 12);
        return JSON.stringify({
          chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
            chapterNumber: start + index,
            title: `章${start + index}`,
            summary: `KEEP_${start + index}`,
          })),
        });
      },
      startChapter: 9,
      endChapter: 16,
      targetChapters: 16,
      runId: nextRun,
    });
    expect(pausedAgain.status).toBe("paused");
    await saveHandEditedArtifact(
      ctx.root,
      pausedAgain.artifactId,
      ((await loadArtifact(ctx.root, pausedAgain.artifactId))?.body ?? "")
        .replace("CURRENT_NOTE 限知视角，禁止揭露幕后身份。", "REPLACED_NOTE 改为全知并揭露身份。")
        .replace("CURRENT_NOTE", "REPLACED_NOTE"),
    );
    const replaceSeen: string[] = [];
    await generateWeaveRange({
      ...ctx,
      llm: async (call) => {
        const text = call.messages.map((message) => message.content).join("\n");
        replaceSeen.push(text);
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        const start = Number(match?.[1] ?? 13);
        const end = Number(match?.[2] ?? 16);
        return JSON.stringify({
          chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
            chapterNumber: start + index,
            title: `章${start + index}`,
            summary: `FILL_${start + index}`,
          })),
        });
      },
      startChapter: 9,
      endChapter: 16,
      targetChapters: 16,
      resumeRunId: nextRun,
    });
    expect(replaceSeen.join("\n")).toContain("REPLACED_NOTE");
    expect(replaceSeen.join("\n")).not.toContain("CURRENT_NOTE 限知视角");
  });


  it("keeps the current chapter beat when leading notes exceed the outline budget (R11-05)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r11-05-"));
    const created = await createLegacyBook({
      projectRoot: root,
      title: "纸城",
      targetChapters: 4,
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    for (const size of [180, 7400, 8200]) {
      const longNote = `LONG_NOTE ${"备".repeat(size)}`;
      const outline = [
        "BOOK_OVERVIEW",
        "",
        "## 第1卷·节点A",
        longNote,
        "",
        "## 第1卷 纸城（1-4章）",
        "VOLUME_R11 本卷要找出寄信人。",
        "",
        "## 第 1 章 来信",
        "KEEP_1",
        "## 第 2 章 雨夜",
        "KEEP_2",
        "## 第 3 章 焚信",
        "CURRENT_CHAPTER_R11 雨夜烧掉伪造信件，救出南门守卫。主角不能死。",
        "## 第 4 章 归港",
        "KEEP_4",
        "",
      ].join("\n");
      await mkdir(join(created.bookDir, "story", "outline"), { recursive: true });
      await writeFile(join(created.bookDir, "story", "outline", "volume_map.md"), outline, "utf-8");
      const seen: string[] = [];
      await generateChapterDraft({
        ...ctx,
        llm: async (call) => {
          seen.push(call.messages.map((message) => message.content).join("\n"));
          return "正文。";
        },
        chapterNumber: 3,
      });
      const prompt = seen.join("\n");
      expect(prompt, `size ${size}`).toContain("CURRENT_CHAPTER_R11");
      expect(prompt, `size ${size}`).toContain("主角不能死。");
      if (size <= 7400) expect(prompt, `size ${size}`).toContain("VOLUME_R11");
    }
  });

  it("keeps in-volume notes and range nodes when appending later chapters (R12-02)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r12-02-"));
    const created = await createLegacyBook({
      projectRoot: root,
      title: "纸城",
      targetChapters: 8,
    });
    const source = [
      "BOOK_OVERVIEW",
      "",
      "## 第1卷 纸城（1-4章）",
      "VOL1_BODY",
      "## 第 1 章 初信",
      "CH1_UPDATED",
      "",
      "## 第1卷·节点B",
      "BETWEEN_NOTE",
      "",
      "## 第2-3章 雨途",
      "RANGE_2_3_SUMMARY",
      "",
      "## 第 4 章 归港",
      "CH4_SUMMARY",
      "",
      "## 第1卷·节点C",
      "TRAILING_NOTE",
      "",
      "## 第2卷 南岸（5-5章）",
      "VOL2_BODY",
      "## 第 5 章 渡口",
      "CH5_SUMMARY",
      "",
    ].join("\n");
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const seeded = await saveHandEditedArtifact(ctx.root, (await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "初信", summary: "CH1" }] }),
      startChapter: 1,
      endChapter: 1,
      targetChapters: 8,
    })).artifactId, source);
    await adoptWeave({ ...ctx, artifactId: seeded.artifactId });
    const appended = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [6, 7, 8].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `NEW_${n}` })),
      }),
      startChapter: 6,
      endChapter: 8,
      targetChapters: 8,
    });
    const body = (await loadArtifact(ctx.root, appended.artifactId))?.body ?? "";
    expect(parseVolumeMapTree(body).chapterCount).toBe(8);
    expect(body.split("BETWEEN_NOTE").length - 1).toBe(1);
    expect(body.split("TRAILING_NOTE").length - 1).toBe(1);
    expect(body).toContain("RANGE_2_3_SUMMARY");
    expect(body).toContain("CH1_UPDATED");
    expect(body).toContain("NEW_6");
    await adoptWeave({ ...ctx, artifactId: appended.artifactId });
    const adopted = await readFile(join(created.bookDir, "story", "outline", "volume_map.md"), "utf-8");
    expect(adopted).toContain("BETWEEN_NOTE");
    expect(adopted).toContain("RANGE_2_3_SUMMARY");
    expect(adopted).toContain("NEW_8");
  });

  it("does not restore a deleted book outline on resume (R12-03)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r12-03-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "OLD_BOOK 旧全书纲。",
        volumes: [{ volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 8, body: "VOL" }],
        chapters: [1, 2, 3, 4].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `KEEP_${n}` })),
      }),
      startChapter: 1,
      endChapter: 4,
      targetChapters: 8,
    });
    const partial = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [{ chapterNumber: 5, title: "章5", summary: "KEEP_5" }],
      }),
      startChapter: 5,
      endChapter: 8,
      targetChapters: 8,
    });
    expect(partial.status).toBe("partial");
    const stripped = ((await loadArtifact(ctx.root, partial.artifactId))?.body ?? "").replace(/OLD_BOOK 旧全书纲。\n*/g, "");
    expect(stripped).not.toContain("OLD_BOOK");
    const deleted = await saveHandEditedArtifact(ctx.root, partial.artifactId, stripped);
    const seen: string[] = [];
    const resumed = await generateWeaveRange({
      ...ctx,
      llm: async (call) => {
        seen.push(call.messages.map((message) => message.content).join("\n"));
        return JSON.stringify({
          chapters: [6, 7, 8].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `FILL_${n}` })),
        });
      },
      startChapter: 5,
      endChapter: 8,
      targetChapters: 8,
      resumeRunId: partial.runId,
    });
    expect(seen.join("\n")).not.toContain("OLD_BOOK");
    expect((await loadArtifact(ctx.root, resumed.artifactId))?.body).not.toContain("OLD_BOOK");
    await adoptWeave({ ...ctx, artifactId: deleted.artifactId });
    await adoptWeave({ ...ctx, artifactId: resumed.artifactId });
    const adopted = await readFile(join(created.bookDir, "story", "outline", "volume_map.md"), "utf-8");
    expect(adopted).not.toContain("OLD_BOOK");
  });

  it("updates an exact chapter that sits after a covering range (R12-04)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r12-04-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const source = [
      "## 第1卷 纸城（1-4章）",
      "VOL1",
      "## 第2-3章 雨途",
      "RANGE_OLD",
      "",
      "## 第 2 章 细纲",
      "EXACT_2_OLD",
      "",
      "## 第 4 章 归港",
      "CH4",
      "",
    ].join("\n");
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const seeded = await saveHandEditedArtifact(ctx.root, (await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "x", summary: "x" }] }),
      startChapter: 1,
      endChapter: 1,
      targetChapters: 4,
    })).artifactId, source);
    const report = parseReviewPayload(JSON.stringify({
      summary: "改第2章",
      issues: [{ issueId: "w1", title: "改", severity: "improve", suggestion: "更新细纲" }],
    }), { stage: "weave", targetRefs: [seeded.artifactId], coverage: "2-2", model: "weave-review" });
    await saveReport(ctx.root, report);
    const nextId = await reviseWeave({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [{ chapterNumber: 2, title: "细纲", summary: "RETURNED_EXACT_2_NEW" }],
      }),
      artifactId: seeded.artifactId,
      reportId: report.reportId,
      selectedIssueIds: ["w1"],
      startChapter: 2,
      endChapter: 2,
    });
    const body = (await loadArtifact(ctx.root, nextId))?.body ?? "";
    expect(body).toContain("RETURNED_EXACT_2_NEW");
    expect(body).not.toContain("EXACT_2_OLD");
    expect(body).toContain("RANGE_OLD");
    expect(body).toContain("CH4");
  });

  it("injects a covering range only once so a short note still fits (R12-05)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r12-05-"));
    const created = await createLegacyBook({
      projectRoot: root,
      title: "纸城",
      targetChapters: 5,
    });
    const rangeBody = `RANGE_TASK ${"任".repeat(3100)}`;
    const outline = [
      "BOOK_OVERVIEW",
      "",
      "## 第1卷·节点A",
      "SHORT_NOTE 限知视角。",
      "",
      "## 第1卷 纸城（1-5章）",
      "VOLUME_R12 找出寄信人。",
      "",
      "## 第2-4章 联合调查",
      rangeBody,
      "",
      "## 第 5 章 收网",
      "KEEP_5",
      "",
    ].join("\n");
    await mkdir(join(created.bookDir, "story", "outline"), { recursive: true });
    await writeFile(join(created.bookDir, "story", "outline", "volume_map.md"), outline, "utf-8");
    const seen: string[] = [];
    await generateChapterDraft({
      root: { projectRoot: root, bookId: created.bookId },
      project: project(),
      llm: async (call) => {
        seen.push(call.messages.map((message) => message.content).join("\n"));
        return "正文。";
      },
      chapterNumber: 3,
    });
    const prompt = seen.join("\n");
    expect(prompt.split("RANGE_TASK").length - 1).toBe(1);
    expect(prompt).toContain("SHORT_NOTE");
    expect(prompt).toContain("VOLUME_R12");
  });

  it("writes generated book and volume outlines when replanning from author notes (R13-01)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r13-01-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const first = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "OLD_BOOK",
        volumes: [
          { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 4, body: "旧卷1" },
          { volumeNumber: 2, title: "南岸", startChapter: 5, endChapter: 8, body: "旧卷2" },
        ],
        chapters: [1, 2, 3, 4].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `OLD_${n}` })),
      }),
      startChapter: 1,
      endChapter: 4,
      targetChapters: 8,
    });
    const idea = await saveHandEditedArtifact(ctx.root, first.artifactId, "作者想法：改从南门焚信写起，不要旧卷结构。\n");
    const planned = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "NEW_BOOK 南门焚信。",
        volumes: [
          { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 4, body: "NEW_VOL1 尚未渡海。" },
          { volumeNumber: 2, title: "南岸", startChapter: 5, endChapter: 8, body: "NEW_VOL2 已抵南岸。" },
        ],
        chapters: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `PLAN_${n}` })),
      }),
      startChapter: 1,
      endChapter: 8,
      targetChapters: 8,
    });
    const body = (await loadArtifact(ctx.root, planned.artifactId))?.body ?? "";
    expect(body).toContain("作者想法：改从南门焚信写起");
    expect(body).toContain("NEW_BOOK");
    expect(body).toContain("NEW_VOL1");
    expect(body).toContain("NEW_VOL2");
    expect(parseVolumeMapTree(body).volumeCount).toBe(2);
    expect(parseVolumeMapTree(body).chapterCount).toBe(8);
    const noteOnly = await saveHandEditedArtifact(ctx.root, idea.artifactId, "## 第1卷·节点A\nAUTHOR_NOTE 限知视角。\n");
    expect(noteOnly.artifactId).toBeTruthy();
    const fromNote = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "NOTE_BOOK 从备注重建。",
        volumes: [
          { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 4, body: "NOTE_VOL1" },
          { volumeNumber: 2, title: "南岸", startChapter: 5, endChapter: 8, body: "NOTE_VOL2" },
        ],
        chapters: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `NOTE_${n}` })),
      }),
      startChapter: 1,
      endChapter: 8,
      targetChapters: 8,
    });
    const noteBody = (await loadArtifact(ctx.root, fromNote.artifactId))?.body ?? "";
    expect(noteBody).toContain("AUTHOR_NOTE");
    expect(noteBody).toContain("NOTE_BOOK");
    expect(noteBody).toContain("NOTE_VOL1");
    expect(parseVolumeMapTree(noteBody).volumeCount).toBe(2);
  });

  it("appends chapters past the last volume range into the last volume (R13-02)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r13-02-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 8 },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await adoptPlannedStructure(ctx, [
      { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 4, body: "VOL1_PAST 尚未渡海。" },
      { volumeNumber: 2, title: "南岸", startChapter: 5, endChapter: 8, body: "VOL2_PRESENT 已抵南岸，应沿南岸线继续。" },
    ], "BOOK");
    const seeded = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "BOOK",
        volumes: [
          { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 4, body: "VOL1_PAST 尚未渡海。" },
          { volumeNumber: 2, title: "南岸", startChapter: 5, endChapter: 8, body: "VOL2_PRESENT 已抵南岸，应沿南岸线继续。" },
        ],
        chapters: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `KEEP_${n}` })),
      }),
      startChapter: 1,
      endChapter: 8,
      targetChapters: 8,
    });
    await setBookTarget(ctx.root, 16);
    const runId = newRunId();
    let calls = 0;
    const paused = await generateWeaveRange({
      ...ctx,
      llm: async (call) => {
        calls += 1;
        if (calls === 1) await saveRunControl(ctx.root, runId, "pause");
        const text = call.messages.map((message) => message.content).join("\n");
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        const start = Number(match?.[1] ?? 9);
        const end = Number(match?.[2] ?? 12);
        return JSON.stringify({
          chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
            chapterNumber: start + index,
            title: `章${start + index}`,
            summary: `NEW_${start + index}`,
          })),
        });
      },
      startChapter: 9,
      endChapter: 16,
      targetChapters: 16,
      runId,
    });
    expect(paused.status).toBe("paused");
    const resumed = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [13, 14, 15, 16].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `NEW_${n}` })),
      }),
      startChapter: 9,
      endChapter: 16,
      targetChapters: 16,
      resumeRunId: runId,
    });
    const body = (await loadArtifact(ctx.root, resumed.artifactId))?.body ?? "";
    const tree = parseVolumeMapTree(body);
    expect(tree.volumeCount).toBe(2);
    const volumeOf13 = tree.volumes.find((volume) => volume.chapters.some((chapter) => chapter.kind === "chapter" && chapter.chapterNumber === 13));
    expect(volumeOf13?.title).toContain("南岸");
    expect(volumeOf13?.body).toContain("VOL2_PRESENT");
    await adoptWeave({ ...ctx, artifactId: resumed.artifactId });
    const seen: string[] = [];
    await generateChapterDraft({
      ...ctx,
      llm: async (call) => {
        seen.push(call.messages.map((message) => message.content).join("\n"));
        return "正文。";
      },
      chapterNumber: 13,
    });
    expect(seen.join("\n")).toContain("VOL2_PRESENT");
    expect(seen.join("\n")).not.toContain("VOL1_PAST");
    expect(seeded.artifactId).toBeTruthy();
  });

  it("uses the parent volume of the selected exact chapter (R13-03)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r13-03-"));
    const created = await createLegacyBook({
      projectRoot: root,
      title: "纸城",
      targetChapters: 5,
    });
    const outline = [
      "BOOK_OVERVIEW",
      "",
      "## 第1卷 纸城（1-4章）",
      "VOL1_STREET 纸城街区调查。",
      "",
      "## 第2-4章 联合调查",
      "RANGE_2_4",
      "",
      "## 第2卷 山城（3-5章）",
      "VOL2_BORDER 山城边境救援。",
      "",
      "## 第 3 章 夜袭",
      "CURRENT_CH3 在山城救出守卫。主角不能死。",
      "",
      "## 第 5 章 收网",
      "KEEP_5",
      "",
    ].join("\n");
    await mkdir(join(created.bookDir, "story", "outline"), { recursive: true });
    await writeFile(join(created.bookDir, "story", "outline", "volume_map.md"), outline, "utf-8");
    const seen: string[] = [];
    await generateChapterDraft({
      root: { projectRoot: root, bookId: created.bookId },
      project: project(),
      llm: async (call) => {
        seen.push(call.messages.map((message) => message.content).join("\n"));
        return "正文。";
      },
      chapterNumber: 3,
    });
    const prompt = seen.join("\n");
    expect(prompt).toContain("VOL2_BORDER");
    expect(prompt).toContain("CURRENT_CH3");
    expect(prompt).toContain("主角不能死。");
    expect(prompt).not.toContain("VOL1_STREET");
  });

  it("keeps flat chapters, ranges, and notes when attaching volumes (R14-01)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r14-01-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const source = [
      "AUTHOR_INPUT 已写全书纲。",
      "",
      "## 第1卷·节点A",
      "LEADING_KEEP 作者要求限知视角。",
      "",
      "## 第 1 章 旧信",
      "KEEP_CH1",
      "",
      "## 第1卷·节点B",
      "BETWEEN_KEEP 此后出现的黑猫只是普通猫，不是密探。",
      "",
      "## 第2-3章 雨途",
      "RANGE_KEEP 两章期间主角卧病，不得出门。",
      "",
      "## 第 4 章 归港",
      "KEEP_CH4",
      "",
      "## 第1卷·节点C",
      "TRAILING_KEEP 调查结束后先找母亲。",
      "",
    ].join("\n");
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const seeded = await saveHandEditedArtifact(ctx.root, (await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "旧信", summary: "KEEP_CH1" }] }),
      startChapter: 1,
      endChapter: 1,
      targetChapters: 12,
    })).artifactId, source);
    expect(parseVolumeMapTree(source).volumeCount).toBe(0);
    const runId = newRunId();
    let calls = 0;
    const paused = await generateWeaveRange({
      ...ctx,
      llm: async (call) => {
        calls += 1;
        if (calls === 1) await saveRunControl(ctx.root, runId, "pause");
        const text = call.messages.map((message) => message.content).join("\n");
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        const start = Number(match?.[1] ?? 5);
        const end = Number(match?.[2] ?? 8);
        return JSON.stringify({
          bookOutline: "NEW_BOOK 继续调查。",
          volumes: [
            { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 4, body: "NEW_VOL1" },
            { volumeNumber: 2, title: "南岸", startChapter: 5, endChapter: 12, body: "NEW_VOL2" },
          ],
          chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
            chapterNumber: start + index,
            title: `章${start + index}`,
            summary: `NEW_${start + index}`,
          })),
        });
      },
      startChapter: 5,
      endChapter: 12,
      targetChapters: 12,
      runId,
    });
    expect(paused.status).toBe("paused");
    const pausedBody = (await loadArtifact(ctx.root, paused.artifactId))?.body ?? "";
    for (const marker of ["AUTHOR_INPUT", "LEADING_KEEP", "KEEP_CH1", "BETWEEN_KEEP", "RANGE_KEEP", "KEEP_CH4", "TRAILING_KEEP"]) {
      expect(pausedBody.split(marker).length - 1, marker).toBe(1);
    }
    const resumed = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [9, 10, 11, 12].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `NEW_${n}` })),
      }),
      startChapter: 5,
      endChapter: 12,
      targetChapters: 12,
      resumeRunId: runId,
    });
    const body = (await loadArtifact(ctx.root, resumed.artifactId))?.body ?? "";
    expect(parseVolumeMapTree(body).volumeCount).toBeGreaterThan(0);
    expect(parseVolumeMapTree(body).chapterCount).toBe(12);
    for (const marker of ["AUTHOR_INPUT", "LEADING_KEEP", "KEEP_CH1", "BETWEEN_KEEP", "RANGE_KEEP", "KEEP_CH4", "TRAILING_KEEP", "NEW_5", "NEW_12"]) {
      expect(body.split(marker).length - 1, marker).toBe(1);
    }
    await adoptWeave({ ...ctx, artifactId: resumed.artifactId });
    const seen: string[] = [];
    await generateChapterDraft({
      ...ctx,
      llm: async (call) => {
        seen.push(call.messages.map((message) => message.content).join("\n"));
        return "正文。";
      },
      chapterNumber: 2,
    });
    expect(seen.join("\n")).toContain("RANGE_KEEP");
    expect(seeded.artifactId).toBeTruthy();
  });

  it("updates bare volume ranges when appending chapters (R14-02)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r14-02-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 16 },
    });
    const cases = [
      {
        heading: "## 第2卷 南岸 第5-8章",
        body: "VOL2_PRESENT 已抵南岸。",
        expectRange: /第5-16章/,
      },
      {
        heading: "## Volume 2 South Chapters 5-8",
        body: "VOL2_PRESENT already ashore.",
        expectRange: /Chapters 5-16/,
      },
    ] as const;
    for (const sample of cases) {
      const source = [
        "BOOK",
        "",
        "## 第1卷 纸城（1-4章）",
        "VOL1_PAST 尚未渡海。",
        "## 第 1 章 章1",
        "KEEP_1",
        "## 第 4 章 章4",
        "KEEP_4",
        "",
        sample.heading,
        sample.body,
        "## 第 5 章 章5",
        "KEEP_5",
        "## 第 8 章 章8",
        "KEEP_8",
        "",
      ].join("\n");
      const ctx = { root: { projectRoot: root, bookId: `${created.bookId}-${sample.heading.length}` }, project: project() };
      const book = await createLightweightBook({
        projectRoot: root,
        existingBookId: `${created.bookId}-${sample.heading.length}`,
        canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 16 },
      });
      const bookCtx = { root: { projectRoot: root, bookId: book.bookId }, project: project() };
      const seeded = await saveHandEditedArtifact(bookCtx.root, (await generateWeaveRange({
        ...bookCtx,
        llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "章1", summary: "KEEP_1" }] }),
        startChapter: 1,
        endChapter: 1,
        targetChapters: 16,
      })).artifactId, source);
      const appended = await generateWeaveRange({
        ...bookCtx,
        llm: async () => JSON.stringify({
          chapters: [9, 10, 11, 12, 13, 14, 15, 16].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `NEW_${n}` })),
        }),
        startChapter: 9,
        endChapter: 16,
        targetChapters: 16,
      });
      const body = (await loadArtifact(bookCtx.root, appended.artifactId))?.body ?? "";
      expect(body).toMatch(sample.expectRange);
      const tree = parseVolumeMapTree(body);
      const home = tree.volumes.find((volume) => volume.chapters.some((chapter) => chapter.kind === "chapter" && chapter.chapterNumber === 13));
      expect(home?.body).toContain("VOL2_PRESENT");
      await adoptWeave({ ...bookCtx, artifactId: appended.artifactId });
      const seen: string[] = [];
      await generateChapterDraft({
        ...bookCtx,
        llm: async (call) => {
          seen.push(call.messages.map((message) => message.content).join("\n"));
          return "正文。";
        },
        chapterNumber: 13,
      });
      expect(seen.join("\n")).toContain("VOL2_PRESENT");
      expect(seen.join("\n")).not.toContain("VOL1_PAST");
      expect(seeded.artifactId).toBeTruthy();
    }
  });

  it("attaches planned volumes in order even when later volumes have no old chapters (R15-01)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r15-01-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const source = [
      "AUTHOR_BOOK 保留全书纲。",
      "",
      "## 第1卷·节点A",
      "NOTE_KEEP 作者备注。",
      "",
      "## 第 1 章 旧信",
      "OLD_CH1",
      "",
      "## 第2-3章 雨途",
      "RANGE_KEEP 主角卧病。",
      "",
      "## 第 4 章 归港",
      "OLD_CH4",
      "",
    ].join("\n");
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await saveHandEditedArtifact(ctx.root, (await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "旧信", summary: "OLD_CH1" }] }),
      startChapter: 1,
      endChapter: 1,
      targetChapters: 16,
    })).artifactId, source);
    const runId = newRunId();
    let calls = 0;
    const paused = await generateWeaveRange({
      ...ctx,
      llm: async (call) => {
        calls += 1;
        if (calls === 1) await saveRunControl(ctx.root, runId, "pause");
        const text = call.messages.map((message) => message.content).join("\n");
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        const start = Number(match?.[1] ?? 5);
        const end = Number(match?.[2] ?? 8);
        return JSON.stringify({
          bookOutline: "NEW_BOOK",
          volumes: [
            { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 4, body: "VOL1 尚未渡海。" },
            { volumeNumber: 2, title: "寻父", startChapter: 5, endChapter: 8, body: "VOL2 仍在寻找父亲。" },
            { volumeNumber: 3, title: "重逢", startChapter: 9, endChapter: 12, body: "VOL3 已经与父亲重逢。" },
          ],
          chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
            chapterNumber: start + index,
            title: `章${start + index}`,
            summary: `NEW_${start + index}`,
          })),
        });
      },
      startChapter: 5,
      endChapter: 12,
      targetChapters: 12,
      runId,
    });
    expect(paused.status).toBe("paused");
    const pausedTree = parseVolumeMapTree((await loadArtifact(ctx.root, paused.artifactId))?.body ?? "");
    expect(pausedTree.volumes.map((volume) => volume.volumeNumber)).toEqual([1, 2, 3]);
    const resumed = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [9, 10, 11, 12].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `NEW_${n}` })),
      }),
      startChapter: 5,
      endChapter: 12,
      targetChapters: 12,
      resumeRunId: runId,
    });
    await adoptWeave({ ...ctx, artifactId: resumed.artifactId });
    await setBookTarget(ctx.root, 16);
    const extended = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [13, 14, 15, 16].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `NEW_${n}` })),
      }),
      startChapter: 13,
      endChapter: 16,
      targetChapters: 16,
    });
    const body = (await loadArtifact(ctx.root, extended.artifactId))?.body ?? "";
    const tree = parseVolumeMapTree(body);
    expect(tree.volumes.map((volume) => volume.volumeNumber)).toEqual([1, 2, 3]);
    const home13 = tree.volumes.find((volume) => volume.chapters.some((chapter) => chapter.kind === "chapter" && chapter.chapterNumber === 13));
    expect(home13?.body).toContain("VOL3");
    expect(body).toContain("RANGE_KEEP");
    expect(body.split("NOTE_KEEP").length - 1).toBe(1);
    await adoptWeave({ ...ctx, artifactId: extended.artifactId });
    const seen: string[] = [];
    await generateChapterDraft({
      ...ctx,
      llm: async (call) => {
        seen.push(call.messages.map((message) => message.content).join("\n"));
        return "正文。";
      },
      chapterNumber: 13,
    });
    expect(seen.join("\n")).toContain("VOL3");
    expect(seen.join("\n")).toContain("已经与父亲重逢");
    expect(seen.join("\n")).not.toContain("仍在寻找父亲");
  });

  it("keeps author preface and new book outline intact when leading blank lines exist (R15-02)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r15-02-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    for (const blanks of [0, 2, 5]) {
      const source = `${"\n".repeat(blanks)}AUTHOR_INPUT 本书全程不能杀死配角。\n\n## 第 1 章 起行\nOLD_CH1 起行。\n\n## 第 5 章 渡海\nOLD_CH5 已经抵达南岸。\n`;
      const ctx = { root: { projectRoot: root, bookId: `${created.bookId}-b${blanks}` }, project: project() };
      await createLightweightBook({
        projectRoot: root,
        existingBookId: `${created.bookId}-b${blanks}`,
        canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
      });
      await saveHandEditedArtifact(ctx.root, (await generateWeaveRange({
        ...ctx,
        llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "起行", summary: "OLD_CH1 起行。" }] }),
        startChapter: 1,
        endChapter: 1,
        targetChapters: 8,
      })).artifactId, source);
      const planned = await generateWeaveRange({
        ...ctx,
        llm: async () => JSON.stringify({
          bookOutline: "MODEL_BOOK 众人护送配角平安返乡。",
          volumes: [
            { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 4, body: "VOL1" },
            { volumeNumber: 2, title: "南岸", startChapter: 5, endChapter: 8, body: "VOL2" },
          ],
          chapters: [1, 2, 3, 4].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `NEW_${n}` })),
        }),
        startChapter: 1,
        endChapter: 4,
        targetChapters: 8,
      });
      const body = (await loadArtifact(ctx.root, planned.artifactId))?.body ?? "";
      expect(body.split("AUTHOR_INPUT 本书全程不能杀死配角。").length - 1, `blanks ${blanks}`).toBe(1);
      expect(body.split("MODEL_BOOK 众人护送配角平安返乡。").length - 1, `blanks ${blanks}`).toBe(1);
      expect(body, `blanks ${blanks}`).not.toMatch(/平安返乡。杀死配角/);
      expect(body, `blanks ${blanks}`).not.toContain("乡。杀死");
    }
  });

  it("does not let an old spanning range steal new exact chapters from the planned volume (R15-03)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r15-03-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const source = [
      "AUTHOR_INPUT 本书全程不能杀死配角。",
      "",
      "## 第 1 章 起行",
      "OLD_CH1 起行。",
      "",
      "## 第2-6章 长途",
      "RANGE_KEEP 路途期间保持戒备。",
      "",
      "## 第 7 章 归途",
      "OLD_CH7 归途。",
      "",
    ].join("\n");
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await saveHandEditedArtifact(ctx.root, (await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "起行", summary: "OLD_CH1 起行。" }] }),
      startChapter: 1,
      endChapter: 1,
      targetChapters: 8,
    })).artifactId, source);
    const planned = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "NEW_BOOK",
        volumes: [
          { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 4, body: "VOL1_SEA 尚未渡海。" },
          { volumeNumber: 2, title: "南岸", startChapter: 5, endChapter: 8, body: "VOL2_SHORE 已经抵达南岸。" },
        ],
        chapters: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `PLAN_${n}` })),
      }),
      startChapter: 1,
      endChapter: 8,
      targetChapters: 8,
    });
    const body = (await loadArtifact(ctx.root, planned.artifactId))?.body ?? "";
    expect(body).toContain("RANGE_KEEP");
    const tree = parseVolumeMapTree(body);
    const home5 = tree.volumes.find((volume) => volume.chapters.some((chapter) => chapter.kind === "chapter" && chapter.chapterNumber === 5));
    expect(home5?.body).toContain("VOL2_SHORE");
    expect(home5?.startChapter).toBe(5);
    expect(tree.volumes[0]?.endChapter).toBe(4);
    await adoptWeave({ ...ctx, artifactId: planned.artifactId });
    const seen: string[] = [];
    await generateChapterDraft({
      ...ctx,
      llm: async (call) => {
        seen.push(call.messages.map((message) => message.content).join("\n"));
        return "正文。";
      },
      chapterNumber: 5,
    });
    expect(seen.join("\n")).toContain("VOL2_SHORE");
    expect(seen.join("\n")).not.toContain("VOL1_SEA");
  });

  it("keeps planned volume order when only the middle volume has no old chapters (R16-01)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r16-01-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: { title: "纸城", oneLine: "送信", proposition: "", protagonist: "", conflict: "", voice: "", boundaries: "", direction: "", openQuestions: [], targetChapters: 12 },
    });
    const source = [
      "AUTHOR_BOOK 保留全书纲。",
      "",
      "## 第1卷·节点A",
      "NOTE_KEEP 作者备注。",
      "",
      "## 第 1 章 旧信",
      "OLD_CH1",
      "",
      "## 第2-3章 雨途",
      "RANGE_KEEP 主角卧病。",
      "",
      "## 第 4 章 归港",
      "OLD_CH4",
      "",
      "## 第 9 章 见面",
      "OLD_CH9",
      "",
    ].join("\n");
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await saveHandEditedArtifact(ctx.root, (await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "旧信", summary: "OLD_CH1" }] }),
      startChapter: 1,
      endChapter: 1,
      targetChapters: 16,
    })).artifactId, source);
    const runId = newRunId();
    let calls = 0;
    const paused = await generateWeaveRange({
      ...ctx,
      llm: async (call) => {
        calls += 1;
        if (calls === 1) await saveRunControl(ctx.root, runId, "pause");
        const text = call.messages.map((message) => message.content).join("\n");
        const match = /第 (\d+)-(\d+) 章/.exec(text);
        const start = Number(match?.[1] ?? 5);
        const end = Number(match?.[2] ?? 8);
        return JSON.stringify({
          bookOutline: "NEW_BOOK",
          volumes: [
            { volumeNumber: 1, title: "纸城", startChapter: 1, endChapter: 4, body: "VOL1 尚未渡海。" },
            { volumeNumber: 2, title: "寻父", startChapter: 5, endChapter: 8, body: "VOL2 寻找父亲，仍未见面。" },
            { volumeNumber: 3, title: "重逢", startChapter: 9, endChapter: 12, body: "VOL3 已经找到父亲，应继续重逢后的故事。" },
          ],
          chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
            chapterNumber: start + index,
            title: `章${start + index}`,
            summary: `NEW_${start + index}`,
          })),
        });
      },
      startChapter: 5,
      endChapter: 12,
      targetChapters: 12,
      runId,
    });
    expect(paused.status).toBe("paused");
    const pausedBody = (await loadArtifact(ctx.root, paused.artifactId))?.body ?? "";
    expect(parseVolumeMapTree(pausedBody).volumes.map((volume) => volume.volumeNumber)).toEqual([1, 2, 3]);
    expect(pausedBody).toContain("OLD_CH9");
    expect(pausedBody).toContain("RANGE_KEEP");
    const resumed = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [9, 10, 11, 12].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: n === 9 ? "OLD_CH9" : `NEW_${n}` })),
      }),
      startChapter: 5,
      endChapter: 12,
      targetChapters: 12,
      resumeRunId: runId,
    });
    const resumedBody = (await loadArtifact(ctx.root, resumed.artifactId))?.body ?? "";
    expect(parseVolumeMapTree(resumedBody).volumes.map((volume) => volume.volumeNumber)).toEqual([1, 2, 3]);
    await adoptWeave({ ...ctx, artifactId: resumed.artifactId });
    await setBookTarget(ctx.root, 16);
    const extended = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [13, 14, 15, 16].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `NEW_${n}` })),
      }),
      startChapter: 13,
      endChapter: 16,
      targetChapters: 16,
    });
    const body = (await loadArtifact(ctx.root, extended.artifactId))?.body ?? "";
    const tree = parseVolumeMapTree(body);
    expect(tree.volumes.map((volume) => volume.volumeNumber)).toEqual([1, 2, 3]);
    const home13 = tree.volumes.find((volume) => volume.chapters.some((chapter) => chapter.kind === "chapter" && chapter.chapterNumber === 13));
    expect(home13?.volumeNumber).toBe(3);
    expect(home13?.body).toContain("VOL3");
    expect(body.split("OLD_CH9").length - 1).toBe(1);
    expect(body.split("RANGE_KEEP").length - 1).toBe(1);
    await adoptWeave({ ...ctx, artifactId: extended.artifactId });
    const seen: string[] = [];
    await generateChapterDraft({
      ...ctx,
      llm: async (call) => {
        seen.push(call.messages.map((message) => message.content).join("\n"));
        return "正文。";
      },
      chapterNumber: 13,
    });
    expect(seen.join("\n")).toContain("已经找到父亲");
    expect(seen.join("\n")).not.toContain("仍未见面");
  });

  it("puts overflow chapters in the highest volume for a historical 1-3-2 draft (R17-01)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r17-01-"));
    const created = await createLegacyBook({
      projectRoot: root,
      title: "纸城",
      targetChapters: 16,
    });
    const source = [
      "BOOK_HISTORY 按历史稿继续。",
      "",
      "## 第1卷·节点A",
      "HISTORICAL_NOTE 保留此备注",
      "",
      "## 第1卷 起岸（1-4章）",
      "VOL1_START 尚未出发。",
      "## 第 1 章 信件1",
      "KEEP_1",
      "## 第 4 章 信件4",
      "KEEP_4",
      "",
      "## 第3卷 高城（9-12章）",
      "VOL3_HIGHLAND 已抵高城，继续高城线。",
      "## 第 9 章 信件9",
      "KEEP_9",
      "## 第 12 章 信件12",
      "KEEP_12",
      "",
      "## 第2卷 中渡（5-8章）",
      "VOL2_MID 仍在中渡，尚未抵高城。",
      "## 第 5 章 信件5",
      "KEEP_5",
      "## 第 8 章 信件8",
      "KEEP_8",
      "",
    ].join("\n");
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await saveHandEditedArtifact(ctx.root, (await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "信件1", summary: "KEEP_1" }] }),
      startChapter: 1,
      endChapter: 1,
      targetChapters: 16,
    })).artifactId, source);
    const appended = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [13, 14, 15, 16].map((n) => ({ chapterNumber: n, title: `信件${n}`, summary: `NEW_${n}` })),
      }),
      startChapter: 13,
      endChapter: 16,
      targetChapters: 16,
    });
    const body = (await loadArtifact(ctx.root, appended.artifactId))?.body ?? "";
    const tree = parseVolumeMapTree(body);
    expect(tree.volumes.map((volume) => volume.volumeNumber)).toEqual([1, 3, 2]);
    const home13 = tree.volumes.find((volume) => volume.chapters.some((chapter) => chapter.kind === "chapter" && chapter.chapterNumber === 13));
    expect(home13?.volumeNumber).toBe(3);
    expect(home13?.endChapter).toBe(16);
    expect(tree.volumes.find((volume) => volume.volumeNumber === 2)?.endChapter).toBe(8);
    expect(body).toContain("HISTORICAL_NOTE");
    const stored = JSON.parse(await readFile(
      join(root, "books", created.bookId, "story", "workflow", "artifacts", appended.artifactId, "beats.json"),
      "utf-8",
    )) as { volumes?: Array<{ volumeNumber: number; startChapter: number; endChapter: number; chapters: Array<{ chapterNumber: number }> }> };
    const storedHome = stored.volumes?.find((volume) => volume.chapters.some((chapter) => chapter.chapterNumber === 13));
    expect(storedHome?.volumeNumber).toBe(3);
    expect(storedHome?.endChapter).toBe(16);
    expect(stored.volumes?.find((volume) => volume.volumeNumber === 2)?.endChapter).toBe(8);
    await adoptWeave({ ...ctx, artifactId: appended.artifactId });
    const seen: string[] = [];
    await generateChapterDraft({
      ...ctx,
      llm: async (call) => {
        seen.push(call.messages.map((message) => message.content).join("\n"));
        return "正文。";
      },
      chapterNumber: 13,
    });
    expect(seen.join("\n")).toContain("已抵高城");
    expect(seen.join("\n")).not.toContain("尚未出发");
    expect(seen.join("\n")).not.toContain("仍在中渡");
  });
});
