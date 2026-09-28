import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadArtifact,
  loadAuthoringWorkspaceLists,
  loadManifest,
  loadReport,
  markReportsStale,
  saveArtifact,
  saveHandEditedArtifact,
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

  it("filters workspace lists by chapter and leaves unrelated reports untouched", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-store-"));
    const store: AuthoringStoreRoot = { projectRoot: root, bookId: "demo" };
    const stamp = new Date().toISOString();
    const writeMeta = (chapter: number, artifactId: string) => saveArtifact(store, {
      artifactId,
      stage: "write",
      scope: `chapter:${chapter}`,
      version: 1,
      source: chapter === 2 ? "hand" : "generate",
      status: "candidate",
      bodyPath: "body.md",
      inputRefs: [],
      createdAt: stamp,
    }, `第${chapter}章`);
    await writeMeta(1, "write-ch1");
    await writeMeta(2, "write-ch2");
    await writeMeta(3, "write-ch3");
    await saveReport(store, {
      reportId: "bound",
      stage: "write",
      targetRefs: ["write-ch2"],
      coverage: "本章",
      inputRefs: [],
      actualReviewModel: "review",
      createdAt: stamp,
      summary: "本章报告",
      issues: [],
      stale: false,
    });
    await saveReport(store, {
      reportId: "other",
      stage: "write",
      targetRefs: ["write-ch3"],
      coverage: "他章",
      inputRefs: [],
      actualReviewModel: "review",
      createdAt: stamp,
      summary: "他章报告",
      issues: [],
      stale: false,
    });
    const otherPath = join(root, "books", "demo", "story", "workflow", "reviews", "other.json");
    const before = await stat(otherPath);
    const chapter = await loadAuthoringWorkspaceLists(store, { chapter: 2 });
    expect(chapter.artifacts.map((item) => item.artifactId)).toEqual(["write-ch2"]);
    expect(chapter.reports.map((item) => item.reportId)).toEqual(["bound"]);
    expect(chapter.runs).toEqual([]);
    const summary = await loadAuthoringWorkspaceLists(store, { summary: true });
    expect(summary.artifacts).toEqual([]);
    expect(summary.reports).toEqual([]);
    await saveHandEditedArtifact(store, "write-ch2", "改过的第二章");
    expect((await stat(otherPath)).mtimeMs).toBe(before.mtimeMs);
    expect((await loadReport(store, "other"))?.stale).toBe(false);
    expect((await loadReport(store, "bound"))?.stale).toBe(true);
    expect(await readFile(otherPath, "utf-8")).toContain("他章报告");
  });

  it("rebuilds a truncated manifest from artifact meta and keeps chapter usage", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-store-"));
    const store: AuthoringStoreRoot = { projectRoot: root, bookId: "demo" };
    const stamp = new Date().toISOString();
    await saveArtifact(store, {
      artifactId: "write-ch2",
      stage: "write",
      scope: "chapter:2",
      version: 2,
      source: "generate",
      status: "candidate",
      bodyPath: "body.md",
      inputRefs: [],
      createdAt: stamp,
    }, "第二章正文");
    await saveRun(store, {
      runId: "run-ch2",
      stage: "write",
      operation: "generate",
      roleId: "write.main",
      status: "completed",
      scope: "chapter:2",
      producedArtifactIds: ["write-ch2"],
      modelSnapshot: {},
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      createdAt: stamp,
      updatedAt: stamp,
    });
    const manifestPath = join(root, "books", "demo", "story", "workflow", "manifest.json");
    await writeFile(manifestPath, "{", "utf-8");
    const restored = await loadManifest(store);
    expect(restored.candidates.write["2"]).toBe("write-ch2");
    const names = await readdir(join(root, "books", "demo", "story", "workflow"));
    expect(names.some((name) => name.startsWith("manifest.json.corrupt-"))).toBe(true);
    const chapter = await loadAuthoringWorkspaceLists(store, { chapter: 2 });
    expect(chapter.runs.map((run) => run.usage?.totalTokens)).toEqual([15]);
    const summary = await loadAuthoringWorkspaceLists(store, { summary: true });
    expect(summary.artifacts).toEqual([]);
    expect(summary.runs.reduce((sum, run) => sum + (run.usage?.totalTokens ?? 0), 0)).toBe(15);
    const other = await loadAuthoringWorkspaceLists(store, { chapter: 1 });
    expect(other.runs).toEqual([]);
  });

  it("rebuilds an empty manifest from artifact meta", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-store-empty-"));
    const store: AuthoringStoreRoot = { projectRoot: root, bookId: "demo" };
    const stamp = new Date().toISOString();
    await saveArtifact(store, {
      artifactId: "write-ch4",
      stage: "write",
      scope: "chapter:4",
      version: 1,
      source: "generate",
      status: "candidate",
      bodyPath: "body.md",
      inputRefs: [],
      createdAt: stamp,
    }, "第四章");
    const manifestPath = join(root, "books", "demo", "story", "workflow", "manifest.json");
    await writeFile(manifestPath, "\n  ", "utf-8");
    const restored = await loadManifest(store);
    expect(restored.candidates.write["4"]).toBe("write-ch4");
    const names = await readdir(join(root, "books", "demo", "story", "workflow"));
    expect(names.some((name) => name.startsWith("manifest.json.corrupt-"))).toBe(true);
    expect(names.includes("manifest.json")).toBe(true);
  });
});
