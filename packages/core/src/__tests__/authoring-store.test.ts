import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadArtifact,
  loadManifest,
  loadReport,
  markReportsStale,
  saveArtifact,
  saveManifest,
  saveReport,
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
});
