import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import { createLightweightBook } from "../authoring/book-create.js";
import { abortAuthoringRun, endAuthoringRun } from "../authoring/run-abort.js";
import { generateAskCanon } from "../authoring/stages/ask.js";
import { generateGroundEntries, proposeSettingsCatalog, reviseGroundEntry, reviewGroundEntries } from "../authoring/stages/ground.js";
import { generateWeaveStructure, reviewWeave } from "../authoring/stages/weave.js";
import {
  AuthoringRunCancelledError,
  authoringRootDir,
  listRuns,
  loadManifest,
  loadRun,
  loadSettingsCatalog,
  newRunId,
  saveRunControl,
} from "../authoring/store.js";
import { resetProcessBookLocksForTest } from "../state/manager.js";
import type { AuthoringLlmFn } from "../authoring/types.js";

const SECRET = "sk-FAKEKEY1234567890";

const canon = {
  title: "夜港账本",
  genre: "现实",
  oneLine: "会计找回账本",
  proposition: "记忆有代价",
  protagonist: "沈砚",
  conflict: "救人还是自保",
  voice: "限制视角",
  boundaries: "开放结局",
  direction: "港口",
  openQuestions: [] as string[],
  targetChapters: 12,
  chapterWordCount: 2000,
};

function project() {
  return ProjectConfigSchema.parse({
    name: "abort-test",
    version: "0.1.0",
    llm: {
      provider: "custom",
      model: "stub-main",
      baseUrl: "https://unused.invalid/v1",
      apiKey: "stub",
    },
    authoringRoles: {
      "ask.main": { modelId: "stub-main" },
      "ground.main": { modelId: "stub-main" },
      "ground.review": { modelId: "stub-main" },
      "weave.main": { modelId: "stub-main" },
      "weave.review": { modelId: "stub-main" },
    },
  });
}

function waitUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (!signal) return;
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

describe("authoring run abort and secret redaction", () => {
  let projectRoot = "";

  afterEach(async () => {
    resetProcessBookLocksForTest();
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
    projectRoot = "";
  });

  async function book() {
    projectRoot = await mkdtemp(join(tmpdir(), "authoring-abort-"));
    const created = await createLightweightBook({ projectRoot, canon });
    return { root: { projectRoot, bookId: created.bookId }, bookId: created.bookId };
  }

  it("aborts the ask model call and does not save a canon candidate", async () => {
    const { root, bookId } = await book();
    const before = await loadManifest(root);
    const runId = newRunId();
    let signal: AbortSignal | undefined;
    const pending = generateAskCanon({
      root,
      project: project(),
      conversation: "港口会计",
      runId,
      llm: async (call) => {
        signal = call.signal;
        return waitUntilAborted(call.signal);
      },
    });
    await vi.waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
    expect(abortAuthoringRun(bookId, runId)).toBe(true);
    expect(signal!.aborted).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(AuthoringRunCancelledError);
    expect((await loadRun(root, runId))?.status).toBe("cancelled");
    const manifest = await loadManifest(root);
    expect(manifest.candidates.ask).toBe(before.candidates.ask);
    expect(manifest.adopted.ask).toBe(before.adopted.ask);
    endAuthoringRun(bookId, runId);
  });

  it("aborts the ground model call and does not save a setting candidate", async () => {
    const { root, bookId } = await book();
    const ctx = { root, project: project() };
    const catalogLlm: AuthoringLlmFn = async () => JSON.stringify({
      categories: ["人物"],
      entries: [{ id: "shen", category: "人物", name: "沈砚" }],
    });
    await proposeSettingsCatalog({ ...ctx, llm: catalogLlm });
    const runId = newRunId();
    let signal: AbortSignal | undefined;
    const pending = generateGroundEntries({
      ...ctx,
      runId,
      llm: async (call) => {
        signal = call.signal;
        return waitUntilAborted(call.signal);
      },
    });
    await vi.waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
    expect(abortAuthoringRun(bookId, runId)).toBe(true);
    expect(signal!.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ generated: [], failed: [], runId });
    expect((await listRuns(root)).find((run) => run.runId === runId)?.status).toBe("cancelled");
    const entry = (await loadSettingsCatalog(root)).entries.find((item) => item.id === "shen");
    expect(entry?.candidateArtifactId).toBeFalsy();
    endAuthoringRun(bookId, runId);
  });

  it("does not save a ground candidate when cancel is marked before the write", async () => {
    const { root } = await book();
    const ctx = { root, project: project() };
    const runId = newRunId();
    const llm: AuthoringLlmFn = async (call) => {
      const text = call.messages.map((message) => message.content).join("\n");
      if (text.includes("拟定本书设定目录")) {
        return JSON.stringify({
          categories: ["人物"],
          entries: [{ id: "shen", category: "人物", name: "沈砚" }],
        });
      }
      await saveRunControl(root, runId, "cancel");
      return "沈砚，港口会计，这段不该留下候选。";
    };
    await proposeSettingsCatalog({ ...ctx, llm });
    const result = await generateGroundEntries({ ...ctx, llm, runId });
    expect(result.generated).toEqual([]);
    expect((await listRuns(root)).find((run) => run.runId === runId)?.status).toBe("cancelled");
    expect((await loadSettingsCatalog(root)).entries.find((item) => item.id === "shen")?.candidateArtifactId).toBeFalsy();
  });

  it("redacts secrets in weave and ground run files", async () => {
    const { root } = await book();
    const ctx = { root, project: project() };
    const weaveRunId = newRunId();
    await expect(generateWeaveStructure({
      ...ctx,
      runId: weaveRunId,
      llm: async () => { throw new Error(`upstream rejected ${SECRET}`); },
    })).rejects.toThrow(/分卷规划失败|rejected|sk-FAKEKEY/);
    const weaveRun = await loadRun(root, weaveRunId);
    expect(weaveRun?.status).toBe("failed");
    expect(weaveRun?.error).toContain("已隐藏");
    expect(weaveRun?.error).not.toContain(SECRET);
    const weaveFile = await readFile(join(authoringRootDir(root), "runs", `${weaveRunId}.json`), "utf-8");
    expect(weaveFile).toContain("已隐藏");
    expect(weaveFile).not.toContain(SECRET);

    const llm: AuthoringLlmFn = async (call) => {
      const text = call.messages.map((message) => message.content).join("\n");
      if (text.includes("拟定本书设定目录")) {
        return JSON.stringify({
          categories: ["人物"],
          entries: [{ id: "shen", category: "人物", name: "沈砚" }],
        });
      }
      throw new Error(`entry failed ${SECRET}`);
    };
    await proposeSettingsCatalog({ ...ctx, llm });
    const ground = await generateGroundEntries({ ...ctx, llm });
    const groundRun = (await listRuns(root)).find((run) => run.runId === ground.runId);
    expect(groundRun?.error).toContain("已隐藏");
    expect(groundRun?.error).not.toContain(SECRET);
    const groundFile = await readFile(join(authoringRootDir(root), "runs", `${ground.runId}.json`), "utf-8");
    expect(groundFile).toContain("已隐藏");
    expect(groundFile).not.toContain(SECRET);
  });

  it("does not replace a ground candidate when revise is cancelled after a late model return", async () => {
    const { root, bookId } = await book();
    const ctx = { root, project: project() };
    const catalogLlm: AuthoringLlmFn = async (call) => {
      const text = call.messages.map((message) => message.content).join("\n");
      if (text.includes("拟定本书设定目录")) {
        return JSON.stringify({ categories: ["人物"], entries: [{ id: "shen", category: "人物", name: "沈砚" }] });
      }
      return "沈砚，港口会计。";
    };
    await proposeSettingsCatalog({ ...ctx, llm: catalogLlm });
    await generateGroundEntries({ ...ctx, llm: catalogLlm });
    const before = (await loadSettingsCatalog(root)).entries.find((item) => item.id === "shen")?.candidateArtifactId;
    const report = await reviewGroundEntries({
      ...ctx,
      entryIds: ["shen"],
      llm: async () => JSON.stringify({
        summary: "收紧",
        coverage: "1",
        issues: [{ issueId: "g1", target: "shen", title: "职业", severity: "improve", suggestion: "写明账房" }],
      }),
    });
    const runId = newRunId();
    const result = reviseGroundEntry({
      ...ctx,
      runId,
      reportId: report.reportId,
      selectedIssueIds: ["g1"],
      llm: async () => {
        await saveRunControl(root, runId, "cancel");
        abortAuthoringRun(bookId, runId);
        return "这句不该成为候选。";
      },
    });
    await expect(result).rejects.toBeInstanceOf(AuthoringRunCancelledError);
    expect((await loadSettingsCatalog(root)).entries.find((item) => item.id === "shen")?.candidateArtifactId).toBe(before);
    endAuthoringRun(bookId, runId);
  });

  it("does not save a weave review report after cancel", async () => {
    const { root, bookId } = await book();
    const ctx = { root, project: project() };
    const structured = await generateWeaveStructure({
      ...ctx,
      llm: async () => JSON.stringify({
        bookOutline: "港口",
        volumes: [{ volumeNumber: 1, title: "上", startChapter: 1, endChapter: 12, body: "上卷" }],
      }),
    });
    const runId = newRunId();
    const pending = reviewWeave({
      ...ctx,
      artifactId: structured.artifactId,
      coverage: "分卷",
      runId,
      llm: async () => {
        await saveRunControl(root, runId, "cancel");
        abortAuthoringRun(bookId, runId);
        return JSON.stringify({ summary: "不该留下", coverage: "分卷", issues: [] });
      },
    });
    await expect(pending).rejects.toBeInstanceOf(AuthoringRunCancelledError);
    expect((await loadRun(root, runId))?.status).toBe("cancelled");
    const reports = await listRuns(root);
    void reports;
    endAuthoringRun(bookId, runId);
  });
});
