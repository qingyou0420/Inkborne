import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import { createLightweightBook } from "../authoring/book-create.js";
import { canonFieldDiff, serializeCanon } from "../authoring/canon.js";
import { assembleAuthoringContext } from "../authoring/context.js";
import { adoptAskCanon } from "../authoring/stages/ask.js";
import { adoptGroundEntries } from "../authoring/stages/ground.js";
import {
  impactContentHash,
  resolveImpactItems,
  triageCanonImpact,
} from "../authoring/stages/impact.js";
import { adoptWeave } from "../authoring/stages/weave.js";
import {
  loadCurrentImpact,
  loadManifest,
  loadReport,
  loadSettingsCatalog,
  newArtifactId,
  saveArtifact,
  saveManifest,
  saveSettingsCatalog,
  type AuthoringStoreRoot,
} from "../authoring/store.js";
import type { AuthoringLlmFn, CanonDocument } from "../authoring/types.js";
import { renderVolumeMapMarkdown } from "../utils/volume-map-tree.js";

function project() {
  return ProjectConfigSchema.parse({
    name: "test",
    version: "0.1.0",
    llm: {
      provider: "custom",
      service: "zenmux",
      configSource: "studio",
      baseUrl: "https://zenmux.ai/api/v1",
      model: "ask-review",
      apiKey: "sk",
      temperature: 0.2,
      thinkingBudget: 0,
      apiFormat: "chat",
      stream: true,
    },
    authoringRoles: {
      "ask.review": { modelId: "ask-review", serviceRef: "zenmux" },
    },
  });
}

const baseCanon: CanonDocument = {
  title: "醉词",
  genre: "现实",
  oneLine: "酒楼旧案",
  proposition: "体面有价",
  protagonist: "沈砚为父复仇",
  conflict: "醉词楼东家仍在",
  voice: "限制视角",
  boundaries: "不写超自然",
  direction: "从酒楼开始",
  openQuestions: ["结局"],
  targetChapters: 12,
  chapterWordCount: 2000,
};

function withCanon(patch: Partial<CanonDocument>): CanonDocument {
  return { ...baseCanon, ...patch, openQuestions: patch.openQuestions ?? baseCanon.openQuestions };
}

function outlineMarkdown(target: number, summaries: Record<number, string> = {}): string {
  return renderVolumeMapMarkdown([{
    volumeNumber: 1,
    title: "全",
    startChapter: 1,
    endChapter: target,
    body: "全书",
    chapters: Array.from({ length: target }, (_, index) => {
      const chapterNumber = index + 1;
      return {
        chapterNumber,
        title: chapterNumber === 12 ? "醉词楼夜" : `第${chapterNumber}章`,
        summary: summaries[chapterNumber] ?? (chapterNumber === 12 ? "原东家仍在酒楼坐镇。" : `第${chapterNumber}章概要`),
      };
    }),
  }]);
}

async function seedCatalog(root: AuthoringStoreRoot, bookDir: string): Promise<void> {
  const entries = [
    { id: "shen-yan", category: "人物", name: "沈砚", file: "story/roles/主要角色/shen.md", body: "沈砚，港口会计。\n别名：沈先生\n动机：为父复仇。" },
    { id: "zui-ci-lou", category: "地点", name: "醉词楼", file: "story/settings/zui.md", body: "醉词楼是旧案发生地。" },
    { id: "passer", category: "人物", name: "路人甲", file: "story/roles/主要角色/passer.md", body: "无关配角。" },
  ];
  const catalogEntries = [];
  for (const entry of entries) {
    const artifactId = `ground-${entry.id}-v1`;
    await saveArtifact(root, {
      artifactId,
      stage: "ground",
      scope: entry.id,
      version: 1,
      source: "generate",
      status: "adopted",
      bodyPath: entry.file,
      inputRefs: [],
      createdAt: new Date().toISOString(),
      label: entry.name,
    }, entry.body);
    await mkdir(dirname(join(bookDir, entry.file)), { recursive: true });
    await writeFile(join(bookDir, entry.file), `${entry.body}\n`, "utf-8");
    catalogEntries.push({
      id: entry.id,
      category: entry.category,
      name: entry.name,
      file: entry.file,
      adoptedArtifactId: artifactId,
      archived: false,
    });
  }
  await saveSettingsCatalog(root, { categories: ["人物", "地点"], entries: catalogEntries });
}

async function seedWeave(root: AuthoringStoreRoot, ctx: { projectRoot: string; bookId: string }, target = 12, summaries?: Record<number, string>) {
  const body = outlineMarkdown(target, summaries);
  const artifactId = "weave-plan-v1";
  await saveArtifact(root, {
    artifactId,
    stage: "weave",
    scope: "outline",
    version: 1,
    source: "generate",
    status: "candidate",
    bodyPath: "story/outline/volume_map.md",
    inputRefs: [],
    createdAt: new Date().toISOString(),
    label: "规划 v1",
  }, body);
  await adoptWeave({ root, project: project(), artifactId });
  return { artifactId, body };
}

async function adoptCanonVersion(
  root: AuthoringStoreRoot,
  canon: CanonDocument,
  version: number,
) {
  const artifactId = newArtifactId("ask", "canon");
  await saveArtifact(root, {
    artifactId,
    stage: "ask",
    scope: "canon",
    version,
    source: "generate",
    status: "candidate",
    bodyPath: "story/canon.md",
    inputRefs: [],
    createdAt: new Date().toISOString(),
    label: `正典 v${version}`,
  }, serializeCanon(canon));
  return adoptAskCanon({ root, project: project(), artifactId });
}

describe("canon impact triage", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("does not create watches when re-adopting equal canon (including openQuestions-only)", async () => {
    dir = await mkdtemp(join(tmpdir(), "impact-equal-"));
    const created = await createLightweightBook({ projectRoot: dir, canon: baseCanon });
    const root: AuthoringStoreRoot = { projectRoot: dir, bookId: created.bookId };
    const same = await adoptCanonVersion(root, withCanon({ openQuestions: ["另一个待定"] }), 2);
    expect(same.impactPending).toBeFalsy();
    const manifest = await loadManifest(root);
    expect(manifest.watches).toEqual([]);
    expect(await loadCurrentImpact(root)).toBeUndefined();
  });

  it("adds a weave:structure item when targetChapters changes", async () => {
    dir = await mkdtemp(join(tmpdir(), "impact-chapters-"));
    const created = await createLightweightBook({ projectRoot: dir, canon: withCanon({ targetChapters: 200 }) });
    const root: AuthoringStoreRoot = { projectRoot: dir, bookId: created.bookId };
    const adopted = await adoptCanonVersion(root, withCanon({ targetChapters: 240 }), 2);
    expect(adopted.impactPending).toBe(true);
    const result = await triageCanonImpact({
      root,
      project: project(),
      llm: async () => JSON.stringify({ items: [] }),
    });
    const structure = result.report?.items.find((item) => item.key === "weave:structure");
    expect(structure).toMatchObject({ verdict: "affected", status: "open", method: "rule" });
    expect(result.report?.items.some((item) => item.stage === "ground" && item.status === "open")).toBe(false);
  });

  it("maps a fake LLM subset onto review report targets and leaves items open", async () => {
    dir = await mkdtemp(join(tmpdir(), "impact-llm-"));
    const created = await createLightweightBook({ projectRoot: dir, canon: baseCanon });
    const root: AuthoringStoreRoot = { projectRoot: dir, bookId: created.bookId };
    await seedCatalog(root, created.bookDir);
    await seedWeave(root, { projectRoot: dir, bookId: created.bookId });
    await adoptCanonVersion(root, withCanon({
      protagonist: "沈砚替父赎罪",
      conflict: "醉词楼易主，东家不再坐镇",
      voice: "全知旁白",
    }), 2);
    const llm: AuthoringLlmFn = async (call) => {
      expect(call.roleId).toBe("ask.review");
      const text = call.messages.map((message) => message.content).join("\n");
      if (text.includes("设定目录索引")) {
        return JSON.stringify({
          items: [{
            target: "shen-yan",
            verdict: "affected",
            fields: ["protagonist"],
            reason: "核心欲望由复仇改为赎罪，本条动机仍写复仇",
            hint: "重写动机",
          }, {
            target: "ghost",
            verdict: "affected",
            fields: ["protagonist"],
            reason: "不存在",
          }],
        });
      }
      return JSON.stringify({
        items: [{
          target: "12",
          verdict: "maybe",
          fields: ["conflict"],
          reason: "主要冲突新增易主，第12章仍写原东家",
          hint: "确认东家去向",
        }],
      });
    };
    const result = await triageCanonImpact({ root, project: project(), llm });
    expect(result.report?.unmapped.some((item) => item.target === "ghost")).toBe(true);
    expect(result.report?.items.find((item) => item.targetId === "shen-yan")).toMatchObject({ status: "open", verdict: "affected" });
    expect(result.report?.items.find((item) => item.key === "weave:chapter:12")).toMatchObject({ status: "open" });
    expect(result.report?.items.every((item) => item.key !== "ground:passer")).toBe(true);
    const ground = await loadReport(root, result.report!.groundReportId!);
    const weave = await loadReport(root, result.report!.weaveReportId!);
    expect(ground?.issues.map((issue) => issue.target)).toContain("shen-yan");
    expect(weave?.issues.map((issue) => issue.target)).toContain("12");
    expect(result.report?.globals.some((item) => item.field === "voice")).toBe(true);
    expect(ground?.summary).toMatch(/全局项：/);
    expect(weave?.summary).toMatch(/全局项：/);
  });

  it("keeps voice-only globals visible until the author acknowledges them", async () => {
    dir = await mkdtemp(join(tmpdir(), "impact-globals-"));
    const created = await createLightweightBook({ projectRoot: dir, canon: baseCanon });
    const root: AuthoringStoreRoot = { projectRoot: dir, bookId: created.bookId };
    const adopted = await adoptCanonVersion(root, withCanon({ voice: "全知旁白" }), 2);
    const result = await triageCanonImpact({
      root,
      project: project(),
      llm: async () => JSON.stringify({ items: [] }),
    });
    expect(result.report?.items).toEqual([]);
    expect(result.report?.degraded).toBeUndefined();
    expect(result.report?.globals.some((item) => item.note.includes("全知旁白"))).toBe(true);
    const manifest = await loadManifest(root);
    expect(manifest.watches.filter((watch) => watch.sourceKind === "canon").every((watch) => !watch.acknowledged)).toBe(true);
    expect(manifest.impactBaseline?.ask).not.toBe(adopted.artifactId);
    await resolveImpactItems(root, { as: "reviewed" });
    const after = await loadManifest(root);
    expect(after.watches.filter((watch) => watch.sourceKind === "canon").every((watch) => watch.acknowledged)).toBe(true);
    expect(after.impactBaseline?.ask).toBe(adopted.artifactId);
  });

  it("acknowledges leftover pending watches when recompute finds unchanged canon", async () => {
    dir = await mkdtemp(join(tmpdir(), "impact-unchanged-watch-"));
    const created = await createLightweightBook({ projectRoot: dir, canon: baseCanon });
    const root: AuthoringStoreRoot = { projectRoot: dir, bookId: created.bookId };
    const manifest = await loadManifest(root);
    const askId = manifest.adopted.ask!;
    await saveManifest(root, {
      ...manifest,
      watches: [
        {
          id: "legacy-g",
          stage: "ground",
          sourceKind: "canon",
          sourceId: askId,
          label: "正典已采用新版本，设定可能需要核对",
          acknowledged: false,
          impactReportId: "pending",
        },
        {
          id: "legacy-w",
          stage: "weave",
          sourceKind: "canon",
          sourceId: askId,
          label: "正典已采用新版本，大纲可能需要核对",
          acknowledged: false,
          impactReportId: "pending",
        },
      ],
    });
    const result = await triageCanonImpact({ root, project: project(), llm: async () => JSON.stringify({ items: [] }) });
    expect(result.unchanged).toBe(true);
    const after = await loadManifest(root);
    expect(after.watches.filter((watch) => watch.sourceKind === "canon").every((watch) => watch.acknowledged)).toBe(true);
    expect(after.impactBaseline?.ask).toBe(askId);
  });

  it("falls back to name/alias heuristic when a batch returns invalid JSON", async () => {
    dir = await mkdtemp(join(tmpdir(), "impact-heuristic-"));
    const created = await createLightweightBook({ projectRoot: dir, canon: baseCanon });
    const root: AuthoringStoreRoot = { projectRoot: dir, bookId: created.bookId };
    await seedCatalog(root, created.bookDir);
    await seedWeave(root, { projectRoot: dir, bookId: created.bookId });
    await adoptCanonVersion(root, withCanon({ protagonist: "沈砚改走赎罪，沈先生不再复仇" }), 2);
    const result = await triageCanonImpact({
      root,
      project: project(),
      llm: async () => "这不是 JSON",
    });
    const hit = result.report?.items.find((item) => item.targetId === "shen-yan");
    expect(hit).toMatchObject({ method: "heuristic", verdict: "maybe", status: "open" });
    expect(hit?.reason).toContain("启发式");
    expect(result.report?.items.some((item) => item.targetId === "passer")).toBe(false);
  });

  it("writes a degraded empty report when both LLM and heuristic miss", async () => {
    dir = await mkdtemp(join(tmpdir(), "impact-degraded-"));
    const created = await createLightweightBook({ projectRoot: dir, canon: baseCanon });
    const root: AuthoringStoreRoot = { projectRoot: dir, bookId: created.bookId };
    await seedCatalog(root, created.bookDir);
    const adopted = await adoptCanonVersion(root, withCanon({ protagonist: "另一个完全无关的人" }), 2);
    const result = await triageCanonImpact({
      root,
      project: project(),
      llm: async () => JSON.stringify({ items: [] }),
    });
    expect(result.report?.items).toEqual([]);
    expect(result.report?.degraded?.reason).toBeTruthy();
    const manifest = await loadManifest(root);
    expect(manifest.watches.every((watch) => watch.impactReportId === result.impactId)).toBe(true);
    expect(manifest.watches.some((watch) => watch.label.includes("影响分辨失败"))).toBe(true);
    // The degraded report is itself the open reminder: watches stay unacknowledged and the baseline does not move,
    // so 「重算」 still diffs v1→v2 instead of short-circuiting as unchanged.
    expect(manifest.watches.filter((watch) => watch.sourceKind === "canon").every((watch) => !watch.acknowledged)).toBe(true);
    expect(manifest.impactBaseline?.ask).not.toBe(adopted.artifactId);
    const recomputed = await triageCanonImpact({
      root,
      project: project(),
      llm: async () => JSON.stringify({
        items: [{ target: "shen-yan", verdict: "maybe", fields: ["protagonist"], reason: "再看一眼" }],
      }),
    });
    expect(recomputed.unchanged).toBeFalsy();
    expect(recomputed.report?.degraded).toBeUndefined();
    expect((await loadCurrentImpact(root))?.impactId).toBe(recomputed.impactId);
  });

  it("lets the author acknowledge a degraded report so the banner can clear", async () => {
    dir = await mkdtemp(join(tmpdir(), "impact-degraded-ack-"));
    const created = await createLightweightBook({ projectRoot: dir, canon: baseCanon });
    const root: AuthoringStoreRoot = { projectRoot: dir, bookId: created.bookId };
    await seedCatalog(root, created.bookDir);
    const adopted = await adoptCanonVersion(root, withCanon({ protagonist: "另一个完全无关的人" }), 2);
    const result = await triageCanonImpact({ root, project: project(), llm: async () => JSON.stringify({ items: [] }) });
    expect(result.report?.degraded).toBeTruthy();
    await resolveImpactItems(root, { as: "reviewed" });
    const manifest = await loadManifest(root);
    expect(manifest.watches.filter((watch) => watch.impactReportId === result.impactId).every((watch) => watch.acknowledged)).toBe(true);
    expect(manifest.impactBaseline?.ask).toBe(adopted.artifactId);
  });

  it("closes ground items on adopt when the adopted artifact changes", async () => {
    dir = await mkdtemp(join(tmpdir(), "impact-ground-close-"));
    const created = await createLightweightBook({ projectRoot: dir, canon: baseCanon });
    const root: AuthoringStoreRoot = { projectRoot: dir, bookId: created.bookId };
    await seedCatalog(root, created.bookDir);
    await adoptCanonVersion(root, withCanon({ protagonist: "沈砚替父赎罪" }), 2);
    await triageCanonImpact({
      root,
      project: project(),
      llm: async () => JSON.stringify({
        items: [{ target: "shen-yan", verdict: "affected", fields: ["protagonist"], reason: "欲望改了" }],
      }),
    });
    const before = await loadCurrentImpact(root);
    const snapshot = before?.items.find((item) => item.targetId === "shen-yan")?.snapshot;
    expect(snapshot).toBeTruthy();
    const nextId = "ground-shen-yan-v2";
    await saveArtifact(root, {
      artifactId: nextId,
      stage: "ground",
      scope: "shen-yan",
      version: 2,
      source: "revise",
      status: "candidate",
      bodyPath: "story/roles/主要角色/shen.md",
      inputRefs: [],
      createdAt: new Date().toISOString(),
      label: "沈砚",
    }, "沈砚改为赎罪。");
    const catalog = await loadSettingsCatalog(root);
    const entry = catalog.entries.find((item) => item.id === "shen-yan")!;
    entry.candidateArtifactId = nextId;
    await saveSettingsCatalog(root, catalog);
    await adoptGroundEntries({ root, project: project(), entryIds: ["shen-yan"] });
    const after = await loadCurrentImpact(root);
    expect(after?.items.find((item) => item.targetId === "shen-yan")?.status).toBe("regenerated");
  });

  it("closes weave items when the adopted summary hash changes", async () => {
    dir = await mkdtemp(join(tmpdir(), "impact-weave-close-"));
    const created = await createLightweightBook({ projectRoot: dir, canon: baseCanon });
    const root: AuthoringStoreRoot = { projectRoot: dir, bookId: created.bookId };
    const first = await seedWeave(root, { projectRoot: dir, bookId: created.bookId });
    await adoptCanonVersion(root, withCanon({ conflict: "醉词楼易主" }), 2);
    await triageCanonImpact({
      root,
      project: project(),
      llm: async () => JSON.stringify({
        items: [{ target: "12", verdict: "affected", fields: ["conflict"], reason: "东家变了" }],
      }),
    });
    const before = await loadCurrentImpact(root);
    const item = before?.items.find((row) => row.key === "weave:chapter:12");
    expect(item?.status).toBe("open");
    const nextBody = outlineMarkdown(12, { 12: "新东家入主醉词楼。", 1: "第1章概要" });
    expect(impactContentHash("醉词楼夜\n新东家入主醉词楼。")).not.toBe(item?.snapshot);
    const nextId = "weave-plan-v2";
    await saveArtifact(root, {
      artifactId: nextId,
      stage: "weave",
      scope: "outline",
      version: 2,
      source: "revise",
      status: "candidate",
      bodyPath: "story/outline/volume_map.md",
      inputRefs: [],
      createdAt: new Date().toISOString(),
    }, nextBody);
    await adoptWeave({ root, project: project(), artifactId: nextId });
    const after = await loadCurrentImpact(root);
    expect(after?.items.find((row) => row.key === "weave:chapter:12")?.status).toBe("regenerated");
    const unchanged = after?.items.find((row) => row.key === "weave:chapter:1");
    if (unchanged) expect(unchanged.status).toBe("open");
    void first;
  });

  it("acknowledges watches and advances the impact baseline when every item is closed", async () => {
    dir = await mkdtemp(join(tmpdir(), "impact-ack-"));
    const created = await createLightweightBook({ projectRoot: dir, canon: baseCanon });
    const root: AuthoringStoreRoot = { projectRoot: dir, bookId: created.bookId };
    await seedCatalog(root, created.bookDir);
    const adopted = await adoptCanonVersion(root, withCanon({ protagonist: "沈砚替父赎罪" }), 2);
    await triageCanonImpact({
      root,
      project: project(),
      llm: async () => JSON.stringify({
        items: [{ target: "shen-yan", verdict: "affected", fields: ["protagonist"], reason: "欲望改了" }],
      }),
    });
    const current = await loadCurrentImpact(root);
    await resolveImpactItems(root, {
      keys: current!.items.filter((item) => item.status === "open").map((item) => item.key),
      as: "reviewed",
    });
    const manifest = await loadManifest(root);
    expect(manifest.watches.filter((watch) => watch.sourceKind === "canon").every((watch) => watch.acknowledged)).toBe(true);
    expect(manifest.impactBaseline?.ask).toBe(adopted.artifactId);
  });

  it("keeps v3 as the from baseline across v4 then v5 while migrating unchanged reviewed items", async () => {
    dir = await mkdtemp(join(tmpdir(), "impact-baseline-"));
    const created = await createLightweightBook({ projectRoot: dir, canon: withCanon({ title: "v3" }) });
    const root: AuthoringStoreRoot = { projectRoot: dir, bookId: created.bookId };
    const v3 = (await loadManifest(root)).adopted.ask;
    await seedCatalog(root, created.bookDir);
    await seedWeave(root, { projectRoot: dir, bookId: created.bookId });
    await adoptCanonVersion(root, withCanon({ title: "v4", protagonist: "沈砚替父赎罪", conflict: "醉词楼东家仍在" }), 2);
    await triageCanonImpact({
      root,
      project: project(),
      llm: async () => JSON.stringify({
        items: [
          { target: "shen-yan", verdict: "affected", fields: ["protagonist"], reason: "欲望改了" },
          { target: "12", verdict: "maybe", fields: ["conflict"], reason: "东家仍在" },
        ],
      }),
    });
    await resolveImpactItems(root, { keys: ["ground:shen-yan"], as: "reviewed" });
    expect((await loadManifest(root)).impactBaseline?.ask).toBe(v3);
    const v4 = (await loadManifest(root)).adopted.ask;
    await adoptCanonVersion(root, withCanon({ title: "v5", protagonist: "沈砚替父赎罪", conflict: "醉词楼易主" }), 3);
    const third = await triageCanonImpact({
      root,
      project: project(),
      llm: async () => JSON.stringify({
        items: [
          { target: "shen-yan", verdict: "affected", fields: ["protagonist"], reason: "欲望仍是赎罪" },
          { target: "12", verdict: "maybe", fields: ["conflict"], reason: "易主" },
        ],
      }),
    });
    expect(third.report?.from.artifactId).toBe(v3);
    expect(third.report?.to.artifactId).not.toBe(v4);
    expect(third.report?.items.find((item) => item.key === "ground:shen-yan")?.status).toBe("reviewed");
    expect(third.report?.items.find((item) => item.key === "weave:chapter:12")?.status).toBe("open");
  });

  it("does not inject watch labels into ground/weave prompts and only notes the marked write chapter", async () => {
    dir = await mkdtemp(join(tmpdir(), "impact-context-"));
    const created = await createLightweightBook({ projectRoot: dir, canon: baseCanon });
    const root: AuthoringStoreRoot = { projectRoot: dir, bookId: created.bookId };
    await seedWeave(root, { projectRoot: dir, bookId: created.bookId });
    await adoptCanonVersion(root, withCanon({ conflict: "醉词楼易主" }), 2);
    const triaged = await triageCanonImpact({
      root,
      project: project(),
      llm: async () => JSON.stringify({
        items: [{ target: "12", verdict: "affected", fields: ["conflict"], reason: "东家仍在" }],
      }),
    });
    expect(triaged.report?.items.some((item) => item.key === "weave:chapter:12")).toBe(true);
    const ground = await assembleAuthoringContext(root, { stage: "ground" });
    const weave = await assembleAuthoringContext(root, { stage: "weave" });
    expect(ground.text).not.toContain("待核对：");
    expect(weave.text).not.toContain("待核对：");
    const marked = await assembleAuthoringContext(root, { stage: "write", chapterNumber: 12 });
    const other = await assembleAuthoringContext(root, { stage: "write", chapterNumber: 1 });
    expect(marked.text).toContain("本章概要在正典");
    expect(marked.text).toContain("东家仍在");
    expect(other.text).not.toContain("本章概要在正典");
  });

  it("compares canon fields and ignores openQuestions", () => {
    expect(canonFieldDiff(baseCanon, withCanon({ openQuestions: ["新的待定"] }))).toEqual([]);
    expect(canonFieldDiff(baseCanon, withCanon({ voice: "第一人称" })).map((item) => item.field)).toEqual(["voice"]);
  });
});
