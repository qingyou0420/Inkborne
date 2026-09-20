import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import { createLightweightBook } from "../authoring/book-create.js";
import { extractJsonObject } from "../authoring/json.js";
import { assembleAuthoringContext, isLightweightAuthoringBook } from "../authoring/context.js";
import { adoptWeave, generateWeaveRange, generateWeaveStructure, inferredVolumeCount, reviewWeave, reviseWeave, validateVolumePlan, volumesFromOutline } from "../authoring/stages/weave.js";
import { generateChapterDraft, saveWriteBody } from "../authoring/stages/write.js";
import { authoringRootDir, listRuns, loadArtifact, saveHandEditedArtifact, saveReport } from "../authoring/store.js";
import { parseReviewPayload } from "../authoring/review.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadManifest, loadRun } from "../authoring/store.js";
import { findExactChapterNode, parseVolumeMapTree, volumeMapPreamble } from "../utils/volume-map-tree.js";
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
      model: "weave-main",
      apiKey: "sk",
      temperature: 0.5,
      thinkingBudget: 0,
      apiFormat: "chat",
      stream: true,
    },
    authoringRoles: {
      "weave.main": { modelId: "weave-main", serviceRef: "zenmux" },
      "weave.review": { modelId: "weave-review", serviceRef: "zenmux" },
    },
  });
}

async function adoptCoveringStructure(
  ctx: { root: { projectRoot: string; bookId: string }; project: ReturnType<typeof project> },
  target: number,
  volumes?: Array<{ volumeNumber: number; title: string; startChapter: number; endChapter: number; body: string }>,
) {
  const structured = await generateWeaveStructure({
    ...ctx,
    llm: async () => JSON.stringify({
      bookOutline: "覆盖结构",
      volumes: volumes ?? [{ volumeNumber: 1, title: "全", startChapter: 1, endChapter: target, body: "全书" }],
    }),
  });
  await adoptWeave({ ...ctx, artifactId: structured.artifactId });
  return structured;
}

async function chapterRevisionFixture(projectRoot: string, target: number, filled: number) {
  const created = await createLightweightBook({
    projectRoot,
    canon: {
      title: "分批修订合成书",
      oneLine: "离线修订验收",
      proposition: "",
      protagonist: "",
      conflict: "",
      voice: "",
      boundaries: "",
      direction: "",
      openQuestions: [],
      targetChapters: target,
    },
  });
  const ctx = { root: { projectRoot, bookId: created.bookId }, project: project() };
  const structured = await adoptCoveringStructure(ctx, target);
  const generated = await generateWeaveRange({
    ...ctx,
    startChapter: 1,
    endChapter: filled,
    llm: async (call) => {
      const prompt = call.messages.map((message) => message.content).join("\n");
      const range = /规划第 (\d+)-(\d+) 章/.exec(prompt);
      if (!range) throw new Error("缺少生成范围");
      const start = Number(range[1]);
      const end = Number(range[2]);
      return JSON.stringify({
        chapters: Array.from({ length: end - start + 1 }, (_, index) => {
          const number = start + index;
          return { chapterNumber: number, title: `原章${number}`, summary: `ORIGINAL_${number.toString().padStart(3, "0")} 保留原稿。` };
        }),
      });
    },
  });
  const report = parseReviewPayload(JSON.stringify({
    summary: "按两项意见调整",
    issues: [
      { issueId: "rhythm", title: "节奏", severity: "improve", suggestion: "REVIEW_RHYTHM 保留停顿。" },
      { issueId: "voice", title: "口吻", severity: "style", suggestion: "REVIEW_VOICE 保留人物口吻。" },
    ],
  }), { stage: "weave", targetRefs: [generated.artifactId], coverage: `前${filled}章`, model: "weave-review" });
  await saveReport(ctx.root, report);
  const candidate = await loadArtifact(ctx.root, generated.artifactId);
  if (!candidate) throw new Error("缺少生成候选");
  const formalPath = join(created.bookDir, "story", "outline", "volume_map.md");
  return {
    ctx,
    structured,
    generated,
    report,
    candidate,
    formalPath,
    formalBefore: await readFile(formalPath, "utf-8"),
  };
}

function requestedRevisionChapters(prompt: string): number[] {
  const range = /只改第 (\d+)-(\d+) 章概要/.exec(prompt);
  if (!range) throw new Error("缺少修订范围");
  const start = Number(range[1]);
  const end = Number(range[2]);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

describe("weave stage", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("covers every chapter in a 12-chapter book and reports actual review coverage", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "十二章",
        oneLine: "测试覆盖",
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
    const llm: AuthoringLlmFn = async (call) => {
      if (call.roleId === "weave.review") {
        return JSON.stringify({
          summary: "节奏可以",
          coverage: "全书 12 章",
          issues: [],
        });
      }
      const match = /第 (\d+)-(\d+) 章/.exec(call.messages.map((message) => message.content).join("\n"));
      const start = Number(match?.[1] ?? 1);
      const end = Number(match?.[2] ?? 4);
      return JSON.stringify({
        chapters: Array.from({ length: end - start + 1 }, (_, index) => ({
          chapterNumber: start + index,
          title: `章${start + index}`,
          summary: `第${start + index}章发生关键转折。`,
        })),
      });
    };
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm };
    await adoptCoveringStructure(ctx, 12);
    const generated = await generateWeaveRange({
      ...ctx,
      startChapter: 1,
      endChapter: 12,
      targetChapters: 12,
    });
    expect(generated.beats).toHaveLength(12);
    expect(generated.beats.every((beat) => beat.summary.includes("关键转折"))).toBe(true);
    const manifest = await loadManifest(ctx.root);
    expect(manifest.coverage.chaptersGenerated).toBe(12);
    expect(manifest.coverage.chaptersTarget).toBe(12);
    const run = await loadRun(ctx.root, generated.runId);
    expect(run?.status).toBe("completed");
    const report = await reviewWeave({
      ...ctx,
      artifactId: generated.artifactId,
      coverage: "全书 12 章",
    });
    expect(report.coverage).toContain("12");
    expect(report.actualReviewModel).toBe("weave-review");
  });

  it("keeps the canon book target when generating a 1-10 range of a 260-chapter book", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-260-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "醉词",
        oneLine: "测试全书目标",
        proposition: "",
        protagonist: "阿衡",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "七卷",
        openQuestions: [],
        targetChapters: 260,
      },
    });
    const seen: string[] = [];
    const llm: AuthoringLlmFn = async (call) => {
      seen.push(call.messages.map((message) => message.content).join("\n"));
      return JSON.stringify({
        chapters: [1, 2, 3, 4].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `概要${n}` })),
      });
    };
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await adoptCoveringStructure(ctx, 260);
    await generateWeaveRange({
      ...ctx,
      llm,
      startChapter: 1,
      endChapter: 10,
      targetChapters: 10,
    });
    expect(seen.join("\n")).toContain("全书目标 260 章");
    expect(seen.join("\n")).not.toContain("全书目标 10 章");
  });

  it("generates volume structure without treating the request range as the book length", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-structure-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "三卷书",
        oneLine: "结构",
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
    const llm: AuthoringLlmFn = async () => JSON.stringify({
      bookOutline: "三卷结构。",
      volumes: [
        { volumeNumber: 1, title: "上", startChapter: 1, endChapter: 4, body: "上卷目标" },
        { volumeNumber: 2, title: "中", startChapter: 5, endChapter: 8, body: "中卷目标" },
        { volumeNumber: 3, title: "下", startChapter: 9, endChapter: 12, body: "下卷目标" },
      ],
    });
    const result = await generateWeaveStructure({
      root: { projectRoot: root, bookId: created.bookId },
      project: project(),
      llm,
    });
    expect(result.volumes).toHaveLength(3);
    expect(result.volumes[2]?.endChapter).toBe(12);
  });

  it("repairs illegal JSON escapes once without inventing chapters", () => {
    const parsed = extractJsonObject('{ "bookOutline": "ok", "note": "hello\\qworld" }');
    expect(parsed.bookOutline).toBe("ok");
    expect(parsed.note).toBe("hello\\qworld");
    expect(() => extractJsonObject("not json")).toThrow(/JSON/);
  });

  it("repairs paired prose quotes only when the caller opts in", () => {
    const raw = '{"chapters":[{"chapterNumber":21,"title":"议价","summary":"她不再是"以理取胜"。转折：核对旧册。"}]}';
    expect(() => extractJsonObject(raw)).toThrow(/JSON/);
    const parsed = extractJsonObject(raw, { repairTextFields: ["title", "summary"] });
    expect(parsed.chapters).toEqual([{ chapterNumber: 21, title: "议价", summary: '她不再是"以理取胜"。转折：核对旧册。' }]);
  });

  it("preserves valid escapes and quoted prose without changing text", () => {
    const expected = { chapters: [{ chapterNumber: 1, title: "「来客」", summary: '他说"明日再来"。路径 C:\\drafts\n下一行。' }] };
    expect(extractJsonObject(JSON.stringify(expected), { repairTextFields: ["title", "summary"] })).toEqual(expected);
    const mixed = '{"summary":"路径\\q，以"旧价"核账。"}';
    expect(extractJsonObject(mixed, { repairTextFields: ["summary"] }).summary).toBe('路径\\q，以"旧价"核账。');
  });

  it.each([
    '{"summary":"原文" "title":"另一字段"}',
    '{"summary":"原文"title":"另一字段"}',
    '{"summary":"原文"broken"}',
    '{"summary":"原文"注释":1}',
    '{"chapters":[{"summary":"他说"回来"。"}',
    '{"chapters":[{"summary":"他说"回来"}',
  ])("does not invent JSON structure while repairing prose: %s", (raw) => {
    expect(() => extractJsonObject(raw, { repairTextFields: ["title", "summary"] })).toThrow(/JSON/);
  });

  it("repairs only the named text fields and preserves adjacent fields", () => {
    const raw = '{"title":"初见"故人"时","body":"他问"何来"。","bookOutline":"以"归途"为线。","count":2}';
    expect(extractJsonObject(raw, { repairTextFields: ["title", "body", "bookOutline"] })).toEqual({
      title: '初见"故人"时', body: '他问"何来"。', bookOutline: '以"归途"为线。', count: 2,
    });
    expect(() => extractJsonObject('{"unknown":"他问"何来"。"}', { repairTextFields: ["summary"] })).toThrow(/JSON/);
  });

  it("resumes a format-failed batch with quoted summaries without replacing adopted structure", async () => {
    root = await mkdtemp(join(tmpdir(), "weave-quoted-resume-"));
    const created = await createLightweightBook({ projectRoot: root, canon: {
      title: "旧册", oneLine: "查明旧账", proposition: "", protagonist: "阿衡", conflict: "", voice: "",
      boundaries: "", direction: "", openQuestions: [], targetChapters: 8,
    } });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await adoptCoveringStructure(ctx, 8);
    const beforeManifest = await loadManifest(ctx.root);
    const outlinePath = join(created.bookDir, "story", "outline", "volume_map.md");
    const formal = await readFile(outlinePath, "utf-8");
    let calls = 0;
    const broken = '{"chapters":[{"chapterNumber":5,"summary":"截断';
    const partial = await generateWeaveRange({ ...ctx, startChapter: 1, endChapter: 8, llm: async () => {
      calls += 1;
      if (calls === 2) return broken;
      return JSON.stringify({ chapters: [1, 2, 3, 4].map((chapterNumber) => ({ chapterNumber, title: `旧章${chapterNumber}`, summary: `保留原文${chapterNumber}` })) });
    } });
    expect(partial.status).toBe("partial");
    expect(calls).toBe(2);
    expect(await readFile(join(authoringRootDir(ctx.root), "diagnostics", `${partial.runId}.txt`), "utf-8")).toBe(broken);
    let resumedCalls = 0;
    const resumed = await generateWeaveRange({ ...ctx, startChapter: 1, endChapter: 8, resumeRunId: partial.runId, llm: async (call) => {
      resumedCalls += 1;
      expect(call.messages.map((message) => message.content).join("\n")).toContain("规划第 5-8 章概要");
      return '{"chapters":[' + [5, 6, 7, 8].map((n) => '{"chapterNumber":' + n + ',"title":"新章' + n + '","summary":"她不再是"以理取胜"。"}').join(",") + ']}';
    } });
    expect(resumed.status).toBe("completed");
    expect(resumedCalls).toBe(1);
    expect(resumed.beats.slice(0, 4)).toEqual(partial.beats.slice(0, 4));
    expect(resumed.beats.slice(4).map((beat) => beat.summary)).toEqual(Array(4).fill('她不再是"以理取胜"。'));
    expect((await loadManifest(ctx.root)).adopted.weave).toBe(beforeManifest.adopted.weave);
    expect(await readFile(outlinePath, "utf-8")).toBe(formal);
  });

  it("does not feed unadopted catalog entries into weave context", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-settings-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "设定",
        oneLine: "测",
        proposition: "",
        protagonist: "阿衡",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
      },
    });
    const settingsDir = join(created.bookDir, "story", "settings");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "keep.md"), "KEEP_SETTING 已采用约束。\n", "utf-8");
    await writeFile(join(settingsDir, "skip.md"), "UNADOPTED_MARKER 不应进入织卷。\n", "utf-8");
    await writeFile(join(settingsDir, "index.json"), JSON.stringify({
      categories: ["规则"],
      entries: [
        { id: "keep", category: "规则", name: "已采用规则", file: "story/settings/keep.md", adoptedArtifactId: "g-keep" },
        { id: "skip", category: "规则", name: "未采用规则", file: "story/settings/skip.md", candidateArtifactId: "g-skip" },
      ],
    }), "utf-8");
    const ctx = await assembleAuthoringContext({ projectRoot: root, bookId: created.bookId }, { stage: "weave" });
    expect(ctx.text).toContain("KEEP_SETTING");
    expect(ctx.text).not.toContain("UNADOPTED_MARKER");
  });

  it("keeps existing chapter summaries when replanning volumes (R1)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-r1-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "重分卷",
        oneLine: "测",
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
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await adoptCoveringStructure(ctx, 12, [
      { volumeNumber: 1, title: "上", startChapter: 1, endChapter: 6, body: "上卷" },
      { volumeNumber: 2, title: "下", startChapter: 7, endChapter: 12, body: "下卷" },
    ]);
    const first = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [1, 2, 3, 4].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `KEEP_SUM_${n}` })),
      }),
      startChapter: 1,
      endChapter: 4,
      targetChapters: 12,
    });
    await adoptWeave({ ...ctx, artifactId: first.artifactId });
    const replanned = await generateWeaveStructure({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "新结构",
        volumes: [
          { volumeNumber: 1, title: "甲", startChapter: 1, endChapter: 4, body: "甲卷" },
          { volumeNumber: 2, title: "乙", startChapter: 5, endChapter: 8, body: "乙卷" },
          { volumeNumber: 3, title: "丙", startChapter: 9, endChapter: 12, body: "丙卷" },
        ],
      }),
    });
    const body = (await loadArtifact(ctx.root, replanned.artifactId))?.body ?? "";
    expect(body).toContain("KEEP_SUM_1");
    expect(body).toContain("KEEP_SUM_4");
    await adoptWeave({ ...ctx, artifactId: replanned.artifactId });
    const adopted = await readFile(join(created.bookDir, "story", "outline", "volume_map.md"), "utf-8");
    expect(adopted).toContain("KEEP_SUM_1");
    expect(adopted).toContain("KEEP_SUM_4");
  });

  it("rejects overlapping and short volume plans (R2)", async () => {
    expect(() => validateVolumePlan([
      { volumeNumber: 1, title: "上", startChapter: 1, endChapter: 6, body: "a", chapters: [] },
      { volumeNumber: 2, title: "下", startChapter: 5, endChapter: 12, body: "b", chapters: [] },
    ], 12)).toThrow(/重叠/);
    expect(() => validateVolumePlan([
      { volumeNumber: 1, title: "上", startChapter: 1, endChapter: 4, body: "a", chapters: [] },
      { volumeNumber: 2, title: "下", startChapter: 6, endChapter: 12, body: "b", chapters: [] },
    ], 12)).toThrow(/空洞/);
    await expect((async () => {
      root = await mkdtemp(join(tmpdir(), "authoring-weave-r2-"));
      const created = await createLightweightBook({
        projectRoot: root,
        canon: {
          title: "七卷书",
          oneLine: "测",
          proposition: "",
          protagonist: "",
          conflict: "",
          voice: "",
          boundaries: "",
          direction: "七卷长篇",
          openQuestions: [],
          targetChapters: 12,
        },
      });
      await generateWeaveStructure({
        root: { projectRoot: root, bookId: created.bookId },
        project: project(),
        llm: async () => JSON.stringify({
          bookOutline: "六卷",
          volumes: [
            { volumeNumber: 1, title: "一", startChapter: 1, endChapter: 2, body: "a" },
            { volumeNumber: 2, title: "二", startChapter: 3, endChapter: 4, body: "b" },
            { volumeNumber: 3, title: "三", startChapter: 5, endChapter: 6, body: "c" },
            { volumeNumber: 4, title: "四", startChapter: 7, endChapter: 8, body: "d" },
            { volumeNumber: 5, title: "五", startChapter: 9, endChapter: 10, body: "e" },
            { volumeNumber: 6, title: "六", startChapter: 11, endChapter: 12, body: "f" },
          ],
        }),
      });
    })()).rejects.toThrow(/7 卷/);
  });

  it("applies volume changes from structure revision (R3)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-r3-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "修订分卷",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 8,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const structured = await generateWeaveStructure({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "两卷",
        volumes: [
          { volumeNumber: 1, title: "旧上", startChapter: 1, endChapter: 4, body: "旧上目标" },
          { volumeNumber: 2, title: "旧下", startChapter: 5, endChapter: 8, body: "旧下目标" },
        ],
      }),
    });
    const report = parseReviewPayload(JSON.stringify({
      summary: "改卷名",
      issues: [{ issueId: "v1", title: "卷名", severity: "improve", suggestion: "改成新上" }],
    }), { stage: "weave", targetRefs: [structured.artifactId], coverage: "分卷", model: "weave-review" });
    await saveReport(ctx.root, report);
    const nextId = await reviseWeave({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "两卷",
        volumes: [
          { volumeNumber: 1, title: "新上", startChapter: 1, endChapter: 4, body: "新上目标" },
          { volumeNumber: 2, title: "新下", startChapter: 5, endChapter: 8, body: "新下目标" },
        ],
      }),
      artifactId: structured.artifactId,
      reportId: report.reportId,
      selectedIssueIds: ["v1"],
      startChapter: 1,
      endChapter: 8,
      reviseStructure: true,
    });
    const body = (await loadArtifact(ctx.root, nextId))?.body ?? "";
    expect(body).toContain("新上");
    expect(body).not.toContain("旧上");
  });

  it("refuses automatic writing when the adopted outline has no chapter summary (R9)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-write-r9-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "缺概要",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 8,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const structured = await generateWeaveStructure({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "两卷",
        volumes: [
          { volumeNumber: 1, title: "上", startChapter: 1, endChapter: 4, body: "上" },
          { volumeNumber: 2, title: "下", startChapter: 5, endChapter: 8, body: "下" },
        ],
      }),
    });
    await adoptWeave({ ...ctx, artifactId: structured.artifactId });
    await expect(generateChapterDraft({
      ...ctx,
      llm: async () => "不该生成",
      chapterNumber: 1,
    })).rejects.toThrow(/织卷概要/);
  });

  it("uses the current chapter outline when selecting settings for write (R4)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-settings-r4-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "设定选择",
        oneLine: "测",
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
    const settingsDir = join(created.bookDir, "story", "settings");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "shen.md"), "SHEN_ONLY 港口会计。\n", "utf-8");
    await writeFile(join(settingsDir, "lan.md"), "MARK_CURRENT_CHARACTER 商岚按设定行动。\n", "utf-8");
    await writeFile(join(settingsDir, "index.json"), JSON.stringify({
      categories: ["人物"],
      entries: [
        { id: "shen", category: "人物", name: "沈砚", file: "story/settings/shen.md", adoptedArtifactId: "g-shen" },
        { id: "lan", category: "人物", name: "商岚", file: "story/settings/lan.md", adoptedArtifactId: "g-lan" },
      ],
    }), "utf-8");
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await adoptCoveringStructure(ctx, 4);
    const planned = await generateWeaveRange({
      ...ctx,
      llm: async () => JSON.stringify({
        chapters: [{ chapterNumber: 1, title: "夜访", summary: "商岚必须依其人物设定行事。" }],
      }),
      startChapter: 1,
      endChapter: 1,
      targetChapters: 4,
    });
    await adoptWeave({ ...ctx, artifactId: planned.artifactId });
    const seen: string[] = [];
    await generateChapterDraft({
      ...ctx,
      llm: async (call) => {
        seen.push(call.messages.map((message) => message.content).join("\n"));
        return "正文。";
      },
      chapterNumber: 1,
    });
    expect(seen.join("\n")).toContain("MARK_CURRENT_CHARACTER");
  });

  it("does not treat ordinal 第一卷 as the total volume count (F3)", () => {
    expect(inferredVolumeCount({ direction: "第一卷启程；第二卷交锋；第三卷归途" })).toBe(3);
    expect(inferredVolumeCount({ direction: "第一卷启程；第二卷交锋；第三卷归途，总共三卷。" })).toBe(3);
    expect(inferredVolumeCount({ direction: "七卷长篇" })).toBe(7);
    expect(inferredVolumeCount({ direction: "规划为三卷" })).toBe(3);
    expect(inferredVolumeCount({ direction: "尚未确定卷数" })).toBeUndefined();
    expect(inferredVolumeCount({ direction: "第一卷用倒叙，第七卷揭晓真相。其他分卷尚未确定。" })).toBeUndefined();
    expect(inferredVolumeCount({
      direction: "第一卷在书院，第二卷归国。这里只确认开头两卷，后续分卷及总卷数尚未确定。",
    })).toBeUndefined();
  });

  it("accepts a complete three-volume plan when only the opening volumes were named (G3)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-g3-partial-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "部分枚举",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "第一卷在书院，第二卷归国。这里只确认开头两卷，后续分卷及总卷数尚未确定。",
        openQuestions: [],
        targetChapters: 12,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    let prompt = "";
    const structured = await generateWeaveStructure({
      ...ctx,
      llm: async (call) => {
        prompt = call.messages.map((message) => message.content).join("\n");
        return JSON.stringify({
          bookOutline: "三卷规划",
          volumes: [
            { volumeNumber: 1, title: "书院", startChapter: 1, endChapter: 4, body: "开学" },
            { volumeNumber: 2, title: "归国", startChapter: 5, endChapter: 8, body: "回国" },
            { volumeNumber: 3, title: "余波", startChapter: 9, endChapter: 12, body: "未定方向的后续" },
          ],
        });
      },
    });
    expect(prompt).not.toContain("必须正好 2 卷");
    expect(volumesFromOutline((await loadArtifact(ctx.root, structured.artifactId))?.body ?? "").map((volume) => volume.volumeNumber)).toEqual([1, 2, 3]);
  });

  it("rejects adopting a chapter-bearing outline that no longer covers the book (F4)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-f4-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "十二章",
        oneLine: "测",
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
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await adoptCoveringStructure(ctx, 12, [
      { volumeNumber: 1, title: "启程", startChapter: 1, endChapter: 4, body: "建立冲突" },
      { volumeNumber: 2, title: "交锋", startChapter: 5, endChapter: 8, body: "深化冲突" },
      { volumeNumber: 3, title: "归途", startChapter: 9, endChapter: 12, body: "解决冲突" },
    ]);
    const generated = await generateWeaveRange({
      ...ctx,
      startChapter: 1,
      endChapter: 1,
      llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "保留章", summary: "真实已填章概要" }] }),
    });
    const candidate = await loadArtifact(ctx.root, generated.artifactId);
    const broken = (candidate?.body ?? "").replace("9-12", "9-11").replace("9–12", "9–11").replace("9—12", "9—11");
    expect(broken).not.toBe(candidate?.body);
    const edited = await saveHandEditedArtifact(ctx.root, generated.artifactId, broken);
    await expect(adoptWeave({ ...ctx, artifactId: edited.artifactId })).rejects.toThrow(/12/);
  });

  it("rejects empty titles even when volume bodies exist (F4)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-empty-title-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "空标题",
        oneLine: "测",
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
    await expect(generateWeaveStructure({
      root: { projectRoot: root, bookId: created.bookId },
      project: project(),
      llm: async () => JSON.stringify({
        bookOutline: "三卷",
        volumes: [
          { volumeNumber: 1, title: "", startChapter: 1, endChapter: 4, body: "建立冲突" },
          { volumeNumber: 2, title: "交锋", startChapter: 5, endChapter: 8, body: "深化冲突" },
          { volumeNumber: 3, title: "归途", startChapter: 9, endChapter: 12, body: "解决冲突" },
        ],
      }),
    })).rejects.toThrow(/标题/);
  });

  it("keeps author notes and parent lineage when replanning volumes (F2)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-f2-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "备注保全",
        oneLine: "测",
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
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const three = [
      { volumeNumber: 1, title: "启程", startChapter: 1, endChapter: 4, body: "建立冲突" },
      { volumeNumber: 2, title: "交锋", startChapter: 5, endChapter: 8, body: "深化冲突" },
      { volumeNumber: 3, title: "归途", startChapter: 9, endChapter: 12, body: "解决冲突" },
    ];
    await adoptCoveringStructure(ctx, 12, three);
    const generated = await generateWeaveRange({
      ...ctx,
      startChapter: 1,
      endChapter: 1,
      llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "必留标题", summary: "KEEP_CHAPTER 必留章概要" }] }),
    });
    const candidate = await loadArtifact(ctx.root, generated.artifactId);
    const notedBody = (candidate?.body ?? "")
      .replace("覆盖结构", "覆盖结构\n\n## 第1卷·节点A\nKEEP_LEADING_NOTE 作者要求全书坚持限知视角。")
      .replace("建立冲突", "建立冲突\n\n### 场景注记\nKEEP_IN_VOLUME_NOTE 作者要求保留生还线索。");
    const edited = await saveHandEditedArtifact(ctx.root, generated.artifactId, notedBody);
    await adoptWeave({ ...ctx, artifactId: edited.artifactId });
    const replanned = await generateWeaveStructure({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "新大纲",
        volumes: three.map((volume) => ({ ...volume, title: `新${volume.title}` })),
      }),
    });
    const after = await loadArtifact(ctx.root, replanned.artifactId);
    expect(after?.body).toContain("KEEP_CHAPTER");
    expect(after?.body).toContain("KEEP_LEADING_NOTE");
    expect(after?.body).toContain("KEEP_IN_VOLUME_NOTE");
    expect(after?.meta.parentArtifactId).toBe(edited.artifactId);
    expect(after?.meta.parentVersion).toBe(edited.version);
    expect(after?.meta.version).toBe(edited.version + 1);
  });

  it("revises only selected chapters when reviseStructure is false (F1)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-f1-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "章修订",
        oneLine: "测",
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
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await adoptCoveringStructure(ctx, 12, [
      { volumeNumber: 1, title: "启程", startChapter: 1, endChapter: 4, body: "建立冲突" },
      { volumeNumber: 2, title: "交锋", startChapter: 5, endChapter: 8, body: "深化冲突" },
      { volumeNumber: 3, title: "归途", startChapter: 9, endChapter: 12, body: "解决冲突" },
    ]);
    const generated = await generateWeaveRange({
      ...ctx,
      startChapter: 1,
      endChapter: 1,
      llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "入学", summary: "原概要越界信息" }] }),
    });
    const report = parseReviewPayload(JSON.stringify({
      summary: "修正第1章",
      issues: [{ issueId: "c1", title: "信息越界", severity: "improve", suggestion: "删掉越界，加入FIX_CHAPTER_MARK" }],
    }), { stage: "weave", targetRefs: [generated.artifactId], coverage: "第1章", model: "weave-review" });
    await saveReport(ctx.root, report);
    const nextId = await reviseWeave({
      ...ctx,
      llm: async (call) => {
        const prompt = call.messages.map((message) => message.content).join("\n");
        expect(prompt).toContain("只改第 1-1 章概要");
        expect(prompt).not.toContain("修改分卷结构");
        return JSON.stringify({ chapters: [{ chapterNumber: 1, title: "入学", summary: "FIX_CHAPTER_MARK 已修正" }] });
      },
      artifactId: generated.artifactId,
      reportId: report.reportId,
      selectedIssueIds: ["c1"],
      startChapter: 1,
      endChapter: 1,
      reviseStructure: false,
    });
    const after = await loadArtifact(ctx.root, nextId);
    expect(after?.body).toContain("FIX_CHAPTER_MARK");
    expect(after?.body).toContain("5-8");
  });

  it("refuses chapter generation and auto-write until structure and summaries are adopted (F6)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-f6-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "门禁",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 4,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await expect(generateWeaveRange({
      ...ctx,
      startChapter: 1,
      endChapter: 4,
      llm: async () => "不该调用",
    })).rejects.toThrow(/分卷结构/);
    await expect(generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      llm: async () => "不该生成",
    })).rejects.toThrow(/织卷/);
    const structured = await generateWeaveStructure({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "一卷",
        volumes: [{ volumeNumber: 1, title: "全", startChapter: 1, endChapter: 4, body: "全书" }],
      }),
    });
    await expect(generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      llm: async () => "不该生成",
    })).rejects.toThrow(/织卷/);
    await adoptWeave({ ...ctx, artifactId: structured.artifactId });
    await expect(generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      llm: async () => "不该生成",
    })).rejects.toThrow(/织卷概要/);
    const hand = await saveWriteBody({ ...ctx, chapterNumber: 1, body: "手写仍可保存。" });
    expect(hand.artifactId).toBeTruthy();
  });

  it("does not flip an old book to four-stage after a handwritten chapter (F8)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-legacy-f8-"));
    const bookDir = join(root, "books", "legacy");
    await mkdir(join(bookDir, "story", "roles", "主要角色"), { recursive: true });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await writeFile(join(bookDir, "book.json"), JSON.stringify({ id: "legacy", title: "合成旧书", targetChapters: 4 }), "utf-8");
    await writeFile(join(bookDir, "story", "book_rules.md"), "LEGACY_RULE 保留原有世界规则\n", "utf-8");
    expect(await isLightweightAuthoringBook(bookDir)).toBe(false);
    await saveWriteBody({
      root: { projectRoot: root, bookId: "legacy" },
      project: project(),
      chapterNumber: 1,
      body: "旧书手写保存，未迁移新流程。",
    });
    expect(await isLightweightAuthoringBook(bookDir)).toBe(false);
  });

  it("dumps raw chapter-range JSON on failure (F9)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-f9-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "失败原文",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 8,
      },
    });
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    await adoptCoveringStructure(ctx, 8, [
      { volumeNumber: 1, title: "起", startChapter: 1, endChapter: 4, body: "相识" },
      { volumeNumber: 2, title: "承", startChapter: 5, endChapter: 8, body: "分别" },
    ]);
    const invalid = '{"chapters":[{"chapterNumber":1,"summary":"BROKEN_CHAPTER_RESPONSE';
    await expect(generateWeaveRange({
      ...ctx,
      startChapter: 1,
      endChapter: 4,
      llm: async () => invalid,
    })).rejects.toThrow();
    const failed = (await listRuns(ctx.root)).find((item) => item.status === "failed");
    expect(failed?.runId).toBeTruthy();
    const dumped = await readFile(join(authoringRootDir(ctx.root), "diagnostics", `${failed!.runId}.txt`), "utf-8");
    expect(dumped).toContain("BROKEN_CHAPTER_RESPONSE");
  });

  it("packs named characters and hard constraints from a large adopted catalog (F5)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-settings-f5-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "大设定",
        oneLine: "测",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 4,
      },
    });
    const settingsDir = join(created.bookDir, "story", "settings");
    await mkdir(settingsDir, { recursive: true });
    const entries = [];
    for (let n = 0; n < 43; n += 1) {
      const category = n === 42 ? "世界规则" : n === 41 ? "时间线" : "人物";
      const name = n === 40 ? "商岚" : n === 41 ? "旧朝年表" : n === 42 ? "禁术铁律" : `人物${String(n).padStart(3, "0")}`;
      const marker = n === 40 ? "商岚秘密：只在午时开口，MARK_CURRENT_CHARACTER" : n === 41 ? "旧朝历元：MARK_TIMELINE_CONSTRAINT" : n === 42 ? "禁术绝不复活死者：MARK_WORLD_HARD_RULE" : `ADOPTED_BODY_${n}`;
      const body = `# ${name}\n${marker}\n### 内部资料\n${"旧事只在合成资料中，".repeat(580)}`;
      await writeFile(join(settingsDir, `e${n}.md`), body, "utf-8");
      entries.push({ id: `e${n}`, category, name, file: `story/settings/e${n}.md`, adoptedArtifactId: `adopted-${n}` });
    }
    await writeFile(join(settingsDir, "index.json"), JSON.stringify({
      categories: ["人物", "时间线", "世界规则"],
      entries,
    }), "utf-8");
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    let weavePrompt = "";
    await generateWeaveStructure({
      ...ctx,
      llm: async (call) => {
        weavePrompt = call.messages.map((message) => message.content).join("\n");
        return JSON.stringify({
          bookOutline: "合成全书",
          volumes: [{ volumeNumber: 1, title: "合成卷", startChapter: 1, endChapter: 4, body: "合成卷目标" }],
        });
      },
    });
    expect(weavePrompt).toContain("MARK_WORLD_HARD_RULE");
    expect(weavePrompt).toContain("MARK_TIMELINE_CONSTRAINT");
    expect(weavePrompt).not.toContain("CANDIDATE_ONLY_");
    const packed = await assembleAuthoringContext(ctx.root, { stage: "weave" });
    expect(packed.refs.filter((ref) => ref.kind === "setting").length).toBeLessThan(43);
    expect(packed.refs.some((ref) => ref.kind === "setting" && (ref.id === "adopted-41" || ref.id === "adopted-42"))).toBe(true);
    await adoptCoveringStructure(ctx, 4);
    const planned = await generateWeaveRange({
      ...ctx,
      startChapter: 1,
      endChapter: 1,
      llm: async () => JSON.stringify({ chapters: [{ chapterNumber: 1, title: "夜访", summary: "商岚必须依其人物设定行事。" }] }),
    });
    await adoptWeave({ ...ctx, artifactId: planned.artifactId });
    let writePrompt = "";
    await generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      llm: async (call) => {
        writePrompt = call.messages.map((message) => message.content).join("\n");
        return "正文。";
      },
    });
    expect(writePrompt).toContain("商岚必须依其人物设定行事");
    expect(writePrompt).toContain("MARK_CURRENT_CHARACTER");
  });

  it("keeps later-volume author notes when replanning after early chapters exist (G1)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-g1-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "后卷备注",
        oneLine: "测",
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
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const three = [
      { volumeNumber: 1, title: "启程", startChapter: 1, endChapter: 4, body: "OLD_FIRST_GOAL" },
      { volumeNumber: 2, title: "交锋", startChapter: 5, endChapter: 8, body: "OLD_SECOND_GOAL" },
      { volumeNumber: 3, title: "归途", startChapter: 9, endChapter: 12, body: "OLD_THIRD_GOAL" },
    ];
    await adoptCoveringStructure(ctx, 12, three);
    const generated = await generateWeaveRange({
      ...ctx,
      startChapter: 1,
      endChapter: 2,
      llm: async () => JSON.stringify({
        chapters: [1, 2].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `CHAPTER_${n}` })),
      }),
    });
    const candidate = await loadArtifact(ctx.root, generated.artifactId);
    const noted = (candidate?.body ?? "")
      .replace("OLD_SECOND_GOAL", "OLD_SECOND_GOAL\n\n### 场景注记\nKEEP_SECOND_ONLY 仅本卷采用倒叙。")
      .replace("OLD_THIRD_GOAL", "OLD_THIRD_GOAL\n\n### 场景注记\nKEEP_THIRD_ONLY 仅本卷禁止倒叙。");
    const edited = await saveHandEditedArtifact(ctx.root, generated.artifactId, noted);
    await adoptWeave({ ...ctx, artifactId: edited.artifactId });
    const replanned = await generateWeaveStructure({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "新大纲",
        volumes: three.map((volume, index) => ({ ...volume, body: `NEW_GOAL_${index + 1}` })),
      }),
    });
    const after = await loadArtifact(ctx.root, replanned.artifactId);
    const vs = volumesFromOutline(after?.body ?? "");
    expect(vs.find((volume) => volume.volumeNumber === 2)?.body).toContain("KEEP_SECOND_ONLY");
    expect(vs.find((volume) => volume.volumeNumber === 3)?.body).toContain("KEEP_THIRD_ONLY");
    expect(after?.body).toContain("CHAPTER_1");
  });

  it("rejects adopting a candidate with no volume headings (G3)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-g3-zero-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "零卷",
        oneLine: "测",
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
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const structured = await generateWeaveStructure({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "大纲",
        volumes: [
          { volumeNumber: 1, title: "启程", startChapter: 1, endChapter: 4, body: "a" },
          { volumeNumber: 2, title: "交锋", startChapter: 5, endChapter: 8, body: "b" },
          { volumeNumber: 3, title: "归途", startChapter: 9, endChapter: 12, body: "c" },
        ],
      }),
    });
    const edited = await saveHandEditedArtifact(ctx.root, structured.artifactId, "# 全书大纲\n作者暂时整理中的一句话。\n");
    await expect(adoptWeave({ ...ctx, artifactId: edited.artifactId })).rejects.toThrow(/分卷/);
  });

  it("rejects noncontiguous volume numbers (G3)", () => {
    expect(() => validateVolumePlan([
      { volumeNumber: 1, title: "一", startChapter: 1, endChapter: 4, body: "a", chapters: [] },
      { volumeNumber: 3, title: "三", startChapter: 5, endChapter: 8, body: "b", chapters: [] },
      { volumeNumber: 7, title: "七", startChapter: 9, endChapter: 12, body: "c", chapters: [] },
    ], 12)).toThrow(/卷号/);
    expect(() => validateVolumePlan([
      { volumeNumber: 3, title: "三", startChapter: 1, endChapter: 4, body: "a", chapters: [] },
      { volumeNumber: 2, title: "二", startChapter: 5, endChapter: 8, body: "b", chapters: [] },
      { volumeNumber: 1, title: "一", startChapter: 9, endChapter: 12, body: "c", chapters: [] },
    ], 12)).toThrow(/卷号/);
  });

  it("records a failed revise on its own run (G4)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-g4-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "修订失败",
        oneLine: "测",
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
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const structured = await generateWeaveStructure({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "大纲",
        volumes: [
          { volumeNumber: 1, title: "启程", startChapter: 1, endChapter: 4, body: "a" },
          { volumeNumber: 2, title: "交锋", startChapter: 5, endChapter: 8, body: "b" },
          { volumeNumber: 3, title: "归途", startChapter: 9, endChapter: 12, body: "c" },
        ],
      }),
    });
    const report = parseReviewPayload(JSON.stringify({
      summary: "调整",
      issues: [{ issueId: "fix", title: "修改", severity: "improve", suggestion: "改边界" }],
    }), { stage: "weave", targetRefs: [structured.artifactId], coverage: "结构", model: "weave-review" });
    await saveReport(ctx.root, report);
    await expect(reviseWeave({
      ...ctx,
      artifactId: structured.artifactId,
      reportId: report.reportId,
      selectedIssueIds: ["fix"],
      startChapter: 1,
      endChapter: 12,
      reviseStructure: true,
      llm: async () => '{"bookOutline":"BROKEN_REVISION", "volumes":[',
    })).rejects.toThrow();
    const runs = await listRuns(ctx.root);
    const failed = runs.find((item) => item.operation === "revise" && item.status === "failed");
    expect(failed?.runId).toBeTruthy();
    expect(failed?.runId).not.toBe(structured.runId);
    const dumped = await readFile(join(authoringRootDir(ctx.root), "diagnostics", `${failed!.runId}.txt`), "utf-8");
    expect(dumped).toContain("BROKEN_REVISION");
  });

  it("revises only 50 filled chapters in batches of at most four for a 260-chapter request", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-revise-50-"));
    const fixture = await chapterRevisionFixture(root, 260, 50);
    const requested: number[][] = [];
    const revisedId = await reviseWeave({
      ...fixture.ctx,
      artifactId: fixture.generated.artifactId,
      reportId: fixture.report.reportId,
      selectedIssueIds: ["rhythm", "voice"],
      startChapter: 1,
      endChapter: 260,
      requirements: "AUTHOR_REQUIREMENT 保留全部七项概要信息。",
      llm: async (call) => {
        const prompt = call.messages.map((message) => message.content).join("\n");
        const numbers = requestedRevisionChapters(prompt);
        requested.push(numbers);
        expect(numbers.length).toBeLessThanOrEqual(4);
        expect(numbers.every((number) => number >= 1 && number <= 50)).toBe(true);
        expect(prompt).toContain("REVIEW_RHYTHM");
        expect(prompt).toContain("REVIEW_VOICE");
        expect(prompt).toContain("AUTHOR_REQUIREMENT");
        return JSON.stringify({ chapters: numbers.map((number) => ({
          chapterNumber: number,
          title: `修章${number}`,
          summary: `REVISED_${number.toString().padStart(3, "0")} 调整本章。`,
        })) });
      },
    });
    expect(requested).toHaveLength(13);
    expect(requested.flat()).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    const revised = await loadArtifact(fixture.ctx.root, revisedId);
    const tree = parseVolumeMapTree(revised?.body ?? "");
    for (let number = 1; number <= 50; number += 1) {
      expect(findExactChapterNode(tree, number)?.summary).toContain(`REVISED_${number.toString().padStart(3, "0")}`);
    }
    expect(findExactChapterNode(tree, 51)).toBeUndefined();
    expect(findExactChapterNode(tree, 260)).toBeUndefined();
    const run = await loadRun(fixture.ctx.root, revised!.meta.runId!);
    expect(run?.status).toBe("completed");
    expect(run?.progressDone).toBe(50);
    expect(run?.progressTotal).toBe(50);
    expect(run?.checkpoint?.completedChapters).toEqual(requested.flat());
    expect(run?.checkpoint?.missingChapters).toEqual([]);
    expect((await loadManifest(fixture.ctx.root)).adopted.weave).toBe(fixture.structured.artifactId);
    expect(await readFile(fixture.formalPath, "utf-8")).toBe(fixture.formalBefore);
  });

  it("keeps chapters outside the selected revision range and unchanged chapters within it", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-revise-intersection-"));
    const fixture = await chapterRevisionFixture(root, 12, 10);
    const requests: number[][] = [];
    const revisedId = await reviseWeave({
      ...fixture.ctx,
      artifactId: fixture.generated.artifactId,
      reportId: fixture.report.reportId,
      selectedIssueIds: ["rhythm"],
      startChapter: 3,
      endChapter: 6,
      llm: async (call) => {
        requests.push(requestedRevisionChapters(call.messages.map((message) => message.content).join("\n")));
        return JSON.stringify({ chapters: [3, 8].map((number) => ({
          chapterNumber: number,
          title: `改章${number}`,
          summary: `SELECTED_REVISION_${number}`,
        })) });
      },
    });
    expect(requests).toEqual([[3, 4, 5, 6]]);
    const revised = await loadArtifact(fixture.ctx.root, revisedId);
    const tree = parseVolumeMapTree(revised?.body ?? "");
    expect(findExactChapterNode(tree, 3)?.summary).toContain("SELECTED_REVISION_3");
    for (const number of [1, 2, 4, 5, 6, 7, 8, 9, 10]) {
      expect(findExactChapterNode(tree, number)?.summary).toBe(
        findExactChapterNode(parseVolumeMapTree(fixture.candidate.body), number)?.summary,
      );
    }
    expect(revised?.body).not.toContain("SELECTED_REVISION_8");
    expect(await readFile(fixture.formalPath, "utf-8")).toBe(fixture.formalBefore);
  });

  it("keeps successful revision batches and resumes only remaining chapters with the original review and requirements", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-revise-resume-"));
    const fixture = await chapterRevisionFixture(root, 12, 10);
    const broken = '{"chapters":[{"chapterNumber":5,"title":"截断","summary":"BROKEN_REVISION_BATCH';
    let calls = 0;
    const partialId = await reviseWeave({
      ...fixture.ctx,
      artifactId: fixture.generated.artifactId,
      reportId: fixture.report.reportId,
      selectedIssueIds: ["rhythm", "voice"],
      startChapter: 1,
      endChapter: 10,
      requirements: "AUTHOR_RESUME_REQUIREMENT 不改变人物关系。",
      llm: async (call) => {
        calls += 1;
        const numbers = requestedRevisionChapters(call.messages.map((message) => message.content).join("\n"));
        expect(numbers).toEqual(calls === 1 ? [1, 2, 3, 4] : [5, 6, 7, 8]);
        if (calls === 2) return broken;
        // A valid batch can return only chapters that need changes.
        return JSON.stringify({ chapters: [1, 3].map((number) => ({
          chapterNumber: number,
          title: `修章${number}`,
          summary: `FIRST_BATCH_${number} 本章已修。`,
        })) });
      },
    });
    expect(calls).toBe(2);
    const partial = await loadArtifact(fixture.ctx.root, partialId);
    const partialTree = parseVolumeMapTree(partial?.body ?? "");
    expect(findExactChapterNode(partialTree, 1)?.summary).toContain("FIRST_BATCH_1");
    expect(findExactChapterNode(partialTree, 3)?.summary).toContain("FIRST_BATCH_3");
    for (const number of [2, 4, 5, 6, 7, 8, 9, 10]) {
      expect(findExactChapterNode(partialTree, number)?.summary).toContain(`ORIGINAL_${number.toString().padStart(3, "0")}`);
    }
    const partialRun = await loadRun(fixture.ctx.root, partial!.meta.runId!);
    expect(partialRun?.operation).toBe("revise");
    expect(partialRun?.status).toBe("partial");
    expect(partialRun?.progressDone).toBe(4);
    expect(partialRun?.progressTotal).toBe(10);
    expect(partialRun?.checkpoint?.completedChapters).toEqual([1, 2, 3, 4]);
    expect(partialRun?.checkpoint?.missingChapters).toEqual([5, 6, 7, 8, 9, 10]);
    expect(partialRun?.checkpoint?.requirements).toContain("AUTHOR_RESUME_REQUIREMENT");
    expect(partialRun?.reportId).toBe(fixture.report.reportId);
    expect(partialRun?.checkpoint?.revisionIssueIds).toEqual(["rhythm", "voice"]);
    expect(partialRun?.checkpoint?.revisionArtifactId).toBe(fixture.generated.artifactId);
    expect(await readFile(join(authoringRootDir(fixture.ctx.root), "diagnostics", `${partialRun!.runId}.txt`), "utf-8")).toBe(broken);
    expect((await loadManifest(fixture.ctx.root)).candidates.weave).toBe(partialId);
    expect((await loadManifest(fixture.ctx.root)).adopted.weave).toBe(fixture.structured.artifactId);
    expect(await readFile(fixture.formalPath, "utf-8")).toBe(fixture.formalBefore);

    const resumedRequests: number[][] = [];
    const resumedId = await reviseWeave({
      ...fixture.ctx,
      artifactId: fixture.generated.artifactId,
      reportId: fixture.report.reportId,
      selectedIssueIds: [],
      startChapter: 1,
      endChapter: 10,
      resumeRunId: partialRun!.runId,
      llm: async (call) => {
        const prompt = call.messages.map((message) => message.content).join("\n");
        const numbers = requestedRevisionChapters(prompt);
        resumedRequests.push(numbers);
        expect(prompt).toContain("REVIEW_RHYTHM");
        expect(prompt).toContain("REVIEW_VOICE");
        expect(prompt).toContain("AUTHOR_RESUME_REQUIREMENT");
        return JSON.stringify({ chapters: numbers.map((number) => ({
          chapterNumber: number,
          title: `续修${number}`,
          summary: `RESUMED_${number} 续修本章。`,
        })) });
      },
    });
    expect(resumedRequests).toEqual([[5, 6, 7, 8], [9, 10]]);
    const resumed = await loadArtifact(fixture.ctx.root, resumedId);
    const resumedTree = parseVolumeMapTree(resumed?.body ?? "");
    for (const number of [1, 2, 3, 4]) {
      expect(findExactChapterNode(resumedTree, number)?.summary).toBe(findExactChapterNode(partialTree, number)?.summary);
    }
    for (const number of resumedRequests.flat()) {
      expect(findExactChapterNode(resumedTree, number)?.summary).toContain(`RESUMED_${number}`);
    }
    const finished = await loadRun(fixture.ctx.root, partialRun!.runId);
    expect(finished?.status).toBe("completed");
    expect(finished?.progressDone).toBe(10);
    expect(finished?.checkpoint?.missingChapters).toEqual([]);
    expect(finished?.checkpoint?.completedChapters).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
    expect((await loadManifest(fixture.ctx.root)).adopted.weave).toBe(fixture.structured.artifactId);
    expect(await readFile(fixture.formalPath, "utf-8")).toBe(fixture.formalBefore);
  });

  it.each([
    ["truncated first batch", '{"chapters":[{"chapterNumber":1,"summary":"BROKEN_FIRST_REVISION'],
    ["empty chapters", '{"chapters":[]}'],
  ])("does not replace the candidate or mark a revision complete for %s", async (_name, response) => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-revise-no-result-"));
    const fixture = await chapterRevisionFixture(root, 8, 4);
    await expect(reviseWeave({
      ...fixture.ctx,
      artifactId: fixture.generated.artifactId,
      reportId: fixture.report.reportId,
      selectedIssueIds: ["rhythm"],
      startChapter: 1,
      endChapter: 4,
      llm: async () => response,
    })).rejects.toThrow();
    const failed = (await listRuns(fixture.ctx.root)).find((run) => run.operation === "revise");
    expect(failed?.status).toBe("failed");
    expect(failed?.progressDone).toBe(0);
    expect(failed?.producedArtifactIds).toEqual([]);
    expect(failed?.checkpoint?.missingChapters).toEqual([1, 2, 3, 4]);
    expect(await readFile(join(authoringRootDir(fixture.ctx.root), "diagnostics", `${failed!.runId}.txt`), "utf-8")).toBe(response);
    expect((await loadManifest(fixture.ctx.root)).candidates.weave).toBe(fixture.generated.artifactId);
    expect((await loadManifest(fixture.ctx.root)).adopted.weave).toBe(fixture.structured.artifactId);
    expect((await loadArtifact(fixture.ctx.root, fixture.generated.artifactId))?.body).toBe(fixture.candidate.body);
    expect(await readFile(fixture.formalPath, "utf-8")).toBe(fixture.formalBefore);
  });

  it("packs late-document constraints and aliases from a large catalog (G2)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-settings-g2-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "长设定",
        oneLine: "测",
        proposition: "",
        protagonist: "黎舟",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
        targetChapters: 4,
      },
    });
    const settingsDir = join(created.bookDir, "story", "settings");
    await mkdir(settingsDir, { recursive: true });
    const filler = "旧事只在合成资料中，".repeat(580);
    const entries = [];
    for (let n = 0; n < 43; n += 1) {
      const category = n === 42 ? "世界规则" : n === 41 ? "时间线" : "人物";
      const name = n === 0 ? "黎舟" : n === 40 ? "商岚" : n === 41 ? "旧朝年表" : n === 42 ? "禁术铁律" : `人物${String(n).padStart(3, "0")}`;
      const marker = n === 40 ? "商岚秘密：只在午时开口，MARK_CURRENT_CHARACTER" : n === 41 ? "旧朝亡于景和二十七年，MARK_TIMELINE_CONSTRAINT" : n === 42 ? "禁术绝不复活死者：MARK_WORLD_HARD_RULE" : `ADOPTED_BODY_${n}`;
      const alias = n === 40 ? "别名：听雨客。\n" : "";
      const body = `# ${name}\n${alias}### 经历资料\n${filler.slice(0, 4500)}\n### 核心约束\n${marker}\n${filler.slice(4500)}`;
      await writeFile(join(settingsDir, `e${n}.md`), body, "utf-8");
      entries.push({ id: `e${n}`, category, name, file: `story/settings/e${n}.md`, adoptedArtifactId: `adopted-${n}` });
    }
    await writeFile(join(settingsDir, "index.json"), JSON.stringify({
      categories: ["人物", "时间线", "世界规则"],
      entries,
    }), "utf-8");
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    let weavePrompt = "";
    await generateWeaveStructure({
      ...ctx,
      llm: async (call) => {
        weavePrompt = call.messages.map((message) => message.content).join("\n");
        return JSON.stringify({
          bookOutline: "合成全书",
          volumes: [{ volumeNumber: 1, title: "合成卷", startChapter: 1, endChapter: 4, body: "合成卷目标" }],
        });
      },
    });
    expect(weavePrompt).toContain("MARK_WORLD_HARD_RULE");
    expect(weavePrompt).toContain("MARK_TIMELINE_CONSTRAINT");
    await adoptCoveringStructure(ctx, 4);
    const planned = await generateWeaveRange({
      ...ctx,
      startChapter: 1,
      endChapter: 1,
      llm: async () => JSON.stringify({
        chapters: [{ chapterNumber: 1, title: "夜访", summary: "黎舟与商岚在渡口相见，按旧朝年表核对年号，并遵循禁术铁律。" }],
      }),
    });
    await adoptWeave({ ...ctx, artifactId: planned.artifactId });
    let writePrompt = "";
    await generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      llm: async (call) => {
        writePrompt = call.messages.map((message) => message.content).join("\n");
        return "正文。";
      },
    });
    expect(writePrompt).toContain("MARK_CURRENT_CHARACTER");
    expect(writePrompt).toContain("MARK_TIMELINE_CONSTRAINT");
    expect(writePrompt).toContain("MARK_WORLD_HARD_RULE");
    const aliasPlanned = await generateWeaveRange({
      ...ctx,
      startChapter: 1,
      endChapter: 1,
      llm: async () => JSON.stringify({
        chapters: [{ chapterNumber: 1, title: "夜访", summary: "听雨客必须依其人物设定行事。" }],
      }),
    });
    await adoptWeave({ ...ctx, artifactId: aliasPlanned.artifactId });
    let aliasPrompt = "";
    await generateChapterDraft({
      ...ctx,
      chapterNumber: 1,
      llm: async (call) => {
        aliasPrompt = call.messages.map((message) => message.content).join("\n");
        return "正文。";
      },
    });
    expect(aliasPrompt).toContain("MARK_CURRENT_CHARACTER");
  });

  it("keeps volume notes on their volumes and does not copy them into the preamble (G1)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-weave-g1-notes-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "卷备注",
        oneLine: "测",
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
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
    const volumes = [
      { volumeNumber: 1, title: "启程", startChapter: 1, endChapter: 4, body: "OLD_FIRST_GOAL" },
      { volumeNumber: 2, title: "交锋", startChapter: 5, endChapter: 8, body: "OLD_SECOND_GOAL" },
      { volumeNumber: 3, title: "归途", startChapter: 9, endChapter: 12, body: "OLD_THIRD_GOAL" },
    ];
    const first = await generateWeaveStructure({
      ...ctx,
      llm: async () => JSON.stringify({ bookOutline: "大纲", volumes }),
    });
    await adoptWeave({ ...ctx, artifactId: first.artifactId });
    const ranged = await generateWeaveRange({
      ...ctx,
      startChapter: 1,
      endChapter: 2,
      llm: async () => JSON.stringify({
        chapters: [1, 2].map((n) => ({ chapterNumber: n, title: `章${n}`, summary: `CHAPTER_${n}` })),
      }),
    });
    const loaded = await loadArtifact(ctx.root, ranged.artifactId);
    const edited = await saveHandEditedArtifact(
      ctx.root,
      ranged.artifactId,
      (loaded?.body ?? "")
        .replace("OLD_SECOND_GOAL", "OLD_SECOND_GOAL\n\n### 场景注记\nONLY_SECOND 此卷全部采用倒叙。\n\n### 叙事补充\nSECOND_DETAIL 第五章必须先写夜雨。")
        .replace("OLD_THIRD_GOAL", "OLD_THIRD_GOAL\n\n### 场景注记\nONLY_THIRD 此卷禁止任何倒叙。"),
    );
    await adoptWeave({ ...ctx, artifactId: edited.artifactId });
    const count = (body: string, marker: string) => body.split(marker).length - 1;
    const inspect = async (artifactId: string) => {
      const body = (await loadArtifact(ctx.root, artifactId))?.body ?? "";
      const tree = parseVolumeMapTree(body);
      return {
        body,
        preamble: volumeMapPreamble(body),
        second: volumesFromOutline(body).find((volume) => volume.volumeNumber === 2)?.body ?? "",
        third: volumesFromOutline(body).find((volume) => volume.volumeNumber === 3)?.body ?? "",
        firstVolumeStart: tree.volumes[0]?.lineStart ?? -1,
        secondCopies: count(body, "ONLY_SECOND"),
        thirdCopies: count(body, "ONLY_THIRD"),
      };
    };
    const once = await generateWeaveStructure({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "大纲",
        volumes: volumes.map((volume, index) => ({ ...volume, title: `新卷名${index + 1}`, body: `NEW_GOAL_${index + 1}` })),
      }),
    });
    const firstPass = await inspect(once.artifactId);
    expect(firstPass.secondCopies).toBe(1);
    expect(firstPass.thirdCopies).toBe(1);
    expect(firstPass.preamble).not.toContain("ONLY_SECOND");
    expect(firstPass.preamble).not.toContain("ONLY_THIRD");
    expect(firstPass.second).toContain("ONLY_SECOND");
    expect(firstPass.third).toContain("ONLY_THIRD");
    expect(firstPass.body.indexOf("ONLY_SECOND")).toBeGreaterThan(firstPass.firstVolumeStart);
    await adoptWeave({ ...ctx, artifactId: once.artifactId });
    const twice = await generateWeaveStructure({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "大纲",
        volumes: volumes.map((volume, index) => ({ ...volume, body: `AGAIN_${index + 1}` })),
      }),
    });
    const secondPass = await inspect(twice.artifactId);
    expect(secondPass.secondCopies).toBe(1);
    expect(secondPass.thirdCopies).toBe(1);
    expect(secondPass.preamble).not.toContain("ONLY_SECOND");
    expect(secondPass.preamble).not.toContain("ONLY_THIRD");
    expect(secondPass.second).toContain("ONLY_SECOND");
    expect(secondPass.third).toContain("ONLY_THIRD");
  });

  it("keeps ordinary markdown constraints and aliases when the catalog fits or must be excerpted (G2)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-settings-g2-boundary-"));
    const facts = ["商岚只在午时开口", "旧朝亡于景和二十七年", "禁术绝不复活死者"];
    const filler = "夏日集市的行人穿过长街。";
    const runCase = async (name: string, bodies: Array<{ name: string; category: string; body: string }>, summary: string) => {
      const created = await createLightweightBook({
        projectRoot: root,
        canon: {
          title: name,
          oneLine: "测",
          proposition: "",
          protagonist: "",
          conflict: "",
          voice: "",
          boundaries: "",
          direction: "",
          openQuestions: [],
          targetChapters: 4,
        },
      });
      const settingsDir = join(created.bookDir, "story", "settings");
      await mkdir(settingsDir, { recursive: true });
      const entries = bodies.map((row, n) => ({
        id: `b${n}`,
        category: row.category,
        name: row.name,
        file: `story/settings/b${n}.md`,
        adoptedArtifactId: `adopted-${n}`,
      }));
      for (let n = 0; n < bodies.length; n += 1) {
        await writeFile(join(settingsDir, `b${n}.md`), bodies[n]!.body, "utf-8");
      }
      await writeFile(join(settingsDir, "index.json"), JSON.stringify({
        categories: ["人物", "时间线", "世界规则"],
        entries,
      }), "utf-8");
      const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project() };
      let weavePrompt = "";
      const structured = await generateWeaveStructure({
        ...ctx,
        llm: async (call) => {
          weavePrompt = call.messages.map((message) => message.content).join("\n");
          return JSON.stringify({
            bookOutline: "合成全书",
            volumes: [{ volumeNumber: 1, title: "渡口", startChapter: 1, endChapter: 4, body: "合成卷目标" }],
          });
        },
      });
      await adoptWeave({ ...ctx, artifactId: structured.artifactId });
      const planned = await generateWeaveRange({
        ...ctx,
        startChapter: 1,
        endChapter: 1,
        llm: async () => JSON.stringify({
          chapters: [{ chapterNumber: 1, title: "渡口相见", summary }],
        }),
      });
      await adoptWeave({ ...ctx, artifactId: planned.artifactId });
      let writePrompt = "";
      const draft = await generateChapterDraft({
        ...ctx,
        chapterNumber: 1,
        llm: async (call) => {
          writePrompt = call.messages.map((message) => message.content).join("\n");
          return "正文。";
        },
      });
      const artifact = await loadArtifact(ctx.root, draft.artifactId);
      return { weavePrompt, writePrompt, refs: artifact?.meta.inputRefs ?? [] };
    };
    const one = await runCase("one-setting-room-available", [{
      name: "商岚",
      category: "人物",
      body: `# 商岚\n### 核心约束\n${filler.repeat(95)}\n${facts[0]}。`,
    }], "商岚在渡口与来客交谈，行为必须符合人物设定。");
    expect(one.writePrompt).toContain(facts[0]);
    expect(one.weavePrompt).toContain(facts[0]);
    expect(one.refs.some((ref) => ref.kind === "setting" && ref.usage === "full" && ref.reason?.includes("全文"))).toBe(true);
    expect(one.refs.some((ref) => ref.kind === "setting" && ref.snippet?.includes("商岚"))).toBe(true);

    const largeBodies = (heading: string, aliasLine = "别名：听雨客。") => Array.from({ length: 43 }, (_, n) => {
      const idx = n - 40;
      const name = n === 40 ? "商岚" : n === 41 ? "旧朝年表" : n === 42 ? "禁术铁律" : `旁人${n}`;
      const category = n === 41 ? "时间线" : n === 42 ? "世界规则" : "人物";
      const body = idx < 0
        ? `# ${name}\n${"无关旧事，仅供离线验收。".repeat(520)}`
        : `# ${name}\n${idx === 0 ? `${aliasLine}\n` : ""}## 过往经历\n${"无关旧事，仅供离线验收。".repeat(420)}\n${heading}\n${facts[idx]}。\n${filler.repeat(70)}`;
      return { name, category, body };
    });
    const h2 = await runCase("h2-core-constraints", largeBodies("## 核心约束"), "商岚在渡口查阅旧朝年表，并遵循禁术铁律。");
    for (const fact of facts) {
      expect(h2.writePrompt).toContain(fact);
      expect(h2.weavePrompt).toContain(fact);
    }
    expect(h2.refs.some((ref) => ref.kind === "setting" && (ref.usage === "full" || ref.usage === "excerpt") && ref.reason)).toBe(true);

    const bold = await runCase("bold-alias-label", largeBodies("### 核心约束", "**别名**：听雨客。"), "听雨客在渡口依其人物设定行事。");
    expect(bold.writePrompt).toContain(facts[0]);
  });
});
