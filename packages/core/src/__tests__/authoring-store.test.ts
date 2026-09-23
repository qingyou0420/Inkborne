import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadArtifact,
  loadManifest,
  loadReport,
  listRuns,
  loadRun,
  markReportsStale,
  saveArtifact,
  saveManifest,
  saveReport,
  saveRun,
  type AuthoringStoreRoot,
} from "../authoring/store.js";

describe("authoring store", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("persists artifacts, reports, and stale flags across reload", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-store-"));
    const store: AuthoringStoreRoot = { projectRoot: root, bookId: "demo" };
    await saveManifest(store, {
      version: 1,
      bookId: "demo",
      adopted: { ground: [], write: {} },
      candidates: { ground: [], write: {} },
      coverage: {},
      watches: [],
      updatedAt: new Date().toISOString(),
    });
    const meta = await saveArtifact(store, {
      artifactId: "ask-1",
      stage: "ask",
      scope: "canon",
      version: 3,
      source: "generate",
      status: "candidate",
      bodyPath: "body.md",
      inputRefs: [],
      createdAt: new Date().toISOString(),
    }, "正典正文");
    await saveReport(store, {
      reportId: "rep-1",
      stage: "ask",
      targetRefs: [meta.artifactId],
      coverage: "全文",
      inputRefs: [],
      actualReviewModel: "review-model",
      createdAt: new Date().toISOString(),
      summary: "有一处问题",
      issues: [{
        issueId: "i1",
        title: "冲突不清",
        severity: "priority",
        sources: [],
      }],
      stale: false,
    });
    await markReportsStale(store, "ask-1", "采用同一版本不应过期");
    expect((await loadReport(store, "rep-1"))?.stale).toBe(false);
    await saveArtifact(store, {
      artifactId: "ask-2",
      stage: "ask",
      scope: "canon",
      version: 4,
      source: "revise",
      status: "candidate",
      bodyPath: "body.md",
      inputRefs: [],
      createdAt: new Date().toISOString(),
    }, "正典正文乙");
    await markReportsStale(store, "ask-2", "新版本出现后旧报告对应甲版");
    const reloaded = await loadReport(store, "rep-1");
    expect(reloaded?.stale).toBe(true);
    expect(reloaded?.staleReason).toContain("甲版");
    expect((await loadArtifact(store, "ask-1"))?.body).toContain("正典正文");
    expect((await loadManifest(store)).bookId).toBe("demo");
  });

  it("commits run records atomically so readers never see a truncated file", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-run-"));
    const store: AuthoringStoreRoot = { projectRoot: root, bookId: "demo" };
    await saveRun(store, {
      runId: "run-atom",
      stage: "weave",
      operation: "generate",
      roleId: "weave.main",
      status: "running",
      modelSnapshot: {},
      producedArtifactIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const loaded = await loadRun(store, "run-atom");
    expect(loaded?.status).toBe("running");
    await saveRun(store, { ...loaded!, status: "failed", error: "synthetic" });
    expect((await loadRun(store, "run-atom"))?.status).toBe("failed");
  });

  it("keeps the previous complete JSON readable while a replacement rename is blocked", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-run-gap-"));
    const store: AuthoringStoreRoot = { projectRoot: root, bookId: "demo" };
    await saveRun(store, {
      runId: "run-gap",
      stage: "weave",
      operation: "review",
      roleId: "weave.review",
      status: "running",
      modelSnapshot: {},
      producedArtifactIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let blocked = false;
    const saving = saveRun(store, {
      runId: "run-gap",
      stage: "weave",
      operation: "review",
      roleId: "weave.review",
      status: "failed",
      error: "synthetic",
      modelSnapshot: {},
      producedArtifactIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, {
      renameFile: async (from, to) => {
        blocked = true;
        await gate;
        const { rename } = await import("node:fs/promises");
        await rename(from, to);
      },
    });
    while (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
    const during = await loadRun(store, "run-gap");
    expect(during?.status).toBe("running");
    expect(during).toBeDefined();
    const raw = await readFile(join(root, "books", "demo", "story", "workflow", "runs", "run-gap.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).status).toBe("running");
    release();
    await saving;
    expect((await loadRun(store, "run-gap"))?.status).toBe("failed");
  });

  it("keeps the old JSON byte-for-byte when rename retries fail, without copy", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-run-fail-"));
    const store: AuthoringStoreRoot = { projectRoot: root, bookId: "demo" };
    await saveRun(store, {
      runId: "run-keep",
      stage: "ask",
      operation: "generate",
      roleId: "ask.main",
      status: "running",
      modelSnapshot: {},
      producedArtifactIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const dest = join(root, "books", "demo", "story", "workflow", "runs", "run-keep.json");
    const before = await readFile(dest);
    await expect(saveRun(store, {
      runId: "run-keep",
      stage: "ask",
      operation: "generate",
      roleId: "ask.main",
      status: "failed",
      error: "synthetic",
      modelSnapshot: {},
      producedArtifactIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, {
      renameFile: async () => { throw Object.assign(new Error("busy"), { code: "EPERM" }); },
    })).rejects.toThrow("busy");
    expect(Buffer.compare(before, await readFile(dest))).toBe(0);
    expect((await loadRun(store, "run-keep"))?.status).toBe("running");
  });

  it("skips a truncated run JSON when listing", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-run-broken-"));
    const store: AuthoringStoreRoot = { projectRoot: root, bookId: "demo" };
    await saveRun(store, {
      runId: "run-ok",
      stage: "ask",
      operation: "generate",
      roleId: "ask.main",
      status: "completed",
      modelSnapshot: {},
      producedArtifactIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const dir = join(root, "books", "demo", "story", "workflow", "runs");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run-broken.json"), '{"runId":', "utf8");
    const listed = await listRuns(store);
    expect(listed.map((run) => run.runId)).toEqual(["run-ok"]);
  });

  it("does not fall back to copyFile after rename retries", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../authoring/store.ts"), "utf8");
    const fn = source.slice(source.indexOf("export async function replaceJsonFile"), source.indexOf("export async function saveRun"));
    expect(fn).not.toMatch(/copyFile/);
    expect(fn).toMatch(/throw lastError/);
  });
});
