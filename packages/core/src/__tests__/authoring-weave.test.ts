import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import { createLightweightBook } from "../authoring/book-create.js";
import { generateWeaveRange, reviewWeave } from "../authoring/stages/weave.js";
import { loadManifest, loadRun } from "../authoring/store.js";
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
});
