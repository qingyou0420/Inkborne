import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import { createLightweightBook } from "../authoring/book-create.js";
import {
  adoptGroundEntries,
  generateGroundEntries,
  proposeSettingsCatalog,
} from "../authoring/stages/ground.js";
import { loadSettingsCatalog } from "../authoring/store.js";
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
      model: "ground-main",
      apiKey: "sk",
      temperature: 0.4,
      thinkingBudget: 0,
      apiFormat: "chat",
      stream: true,
    },
  });
}

describe("ground stage", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("keeps finished entries when one item fails and does not write volume maps", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-ground-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "港口",
        genre: "现实",
        oneLine: "会计找账本",
        proposition: "",
        protagonist: "沈砚",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
      },
    });
    let catalogCalls = 0;
    const llm: AuthoringLlmFn = async (call) => {
      if (catalogCalls === 0) {
        catalogCalls += 1;
        return JSON.stringify({
          categories: ["人物", "地点"],
          entries: [
            { id: "shen", category: "人物", name: "沈砚" },
            { id: "port", category: "地点", name: "夜港" },
          ],
        });
      }
      if (call.messages.some((message) => message.content.includes("夜港"))) {
        throw new Error("地点生成失败");
      }
      return "沈砚，港口会计，想赎回自己。";
    };
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm };
    await proposeSettingsCatalog(ctx);
    const result = await generateGroundEntries(ctx);
    expect(result.generated).toContain("shen");
    expect(result.failed).toContain("port");
    await adoptGroundEntries({ ...ctx, entryIds: ["shen"] });
    const catalog = await loadSettingsCatalog(ctx.root);
    const shen = catalog.entries.find((entry) => entry.id === "shen");
    expect(shen?.adoptedArtifactId).toBeTruthy();
    const body = await readFile(join(created.bookDir, shen!.file), "utf-8");
    expect(body).toContain("港口会计");
    await expect(readFile(join(created.bookDir, "story", "outline", "volume_map.md"), "utf-8")).rejects.toThrow();
  });

  it("merges proposed catalog identities and keeps adopted links (R7-02)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r7-02-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "港口",
        genre: "现实",
        oneLine: "会计找账本",
        proposition: "",
        protagonist: "沈砚",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
      },
    });
    let round = 0;
    const llm: AuthoringLlmFn = async () => {
      round += 1;
      if (round === 1) {
        return JSON.stringify({
          categories: ["人物", "规则"],
          entries: [
            { id: "shen", category: "人物", name: "沈砚" },
            { id: "rule", category: "规则", name: "铁律" },
          ],
        });
      }
      if (round === 2) return "沈砚，港口会计。";
      if (round === 3) return "夜里不得翻账。";
      return JSON.stringify({
        categories: ["人物", "地点"],
        entries: [
          { id: "shen-new", category: "人物", name: "沈砚" },
          { id: "port", category: "地点", name: "夜港" },
        ],
      });
    };
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm };
    await proposeSettingsCatalog(ctx);
    await generateGroundEntries(ctx);
    await adoptGroundEntries({ ...ctx, entryIds: ["shen"] });
    const before = await loadSettingsCatalog(ctx.root);
    const adoptedId = before.entries.find((entry) => entry.id === "shen")?.adoptedArtifactId;
    expect(adoptedId).toBeTruthy();
    const next = await proposeSettingsCatalog(ctx);
    const shen = next.entries.find((entry) => entry.name === "沈砚");
    expect(shen?.adoptedArtifactId).toBe(adoptedId);
    expect(next.entries.some((entry) => entry.id === "rule" || entry.name === "铁律")).toBe(true);
    expect(next.entries.some((entry) => entry.name === "夜港")).toBe(true);
    const body = await readFile(join(created.bookDir, shen!.file), "utf-8");
    expect(body).toContain("港口会计");
  });

  it("keeps the adopted catalog when the model returns empty JSON (R7-02)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r7-02-empty-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "港口",
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
    let round = 0;
    const llm: AuthoringLlmFn = async () => {
      round += 1;
      if (round === 1) {
        return JSON.stringify({
          categories: ["人物"],
          entries: [{ id: "shen", category: "人物", name: "沈砚" }],
        });
      }
      return "{}";
    };
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm };
    await proposeSettingsCatalog(ctx);
    await expect(proposeSettingsCatalog(ctx)).rejects.toThrow(/不完整/);
    const catalog = await loadSettingsCatalog(ctx.root);
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]?.id).toBe("shen");
  });

  it("does not let a renamed id steal an adopted setting file (R8-01)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r8-01-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "永夜",
        oneLine: "规则",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
      },
    });
    let round = 0;
    const llm: AuthoringLlmFn = async (call) => {
      const text = call.messages.map((message) => message.content).join("\n");
      round += 1;
      if (text.includes("拟定本书设定目录") && round === 1) {
        return JSON.stringify({
          categories: ["世界"],
          entries: [{ id: "world-1", category: "世界", name: "永夜规则" }],
        });
      }
      if (text.includes("拟定本书设定目录")) {
        return JSON.stringify({
          categories: ["世界"],
          entries: [
            { id: "world-1", category: "世界", name: "地理疆域" },
            { id: "world-2", category: "世界", name: "永夜规则" },
          ],
        });
      }
      if (text.includes("永夜规则")) return "太阳永不升起。";
      return "只有南北两片大陆。";
    };
    const ctx = { root: { projectRoot: root, bookId: created.bookId }, project: project(), llm };
    await proposeSettingsCatalog(ctx);
    await generateGroundEntries(ctx);
    await adoptGroundEntries({ ...ctx, entryIds: ["world-1"] });
    const before = await loadSettingsCatalog(ctx.root);
    const nightBefore = before.entries.find((entry) => entry.name === "永夜规则");
    expect(nightBefore?.id).toBe("world-1");
    const next = await proposeSettingsCatalog(ctx);
    const ids = next.entries.map((entry) => entry.id);
    const files = next.entries.map((entry) => entry.file);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(files).size).toBe(files.length);
    const night = next.entries.find((entry) => entry.name === "永夜规则");
    const geo = next.entries.find((entry) => entry.name === "地理疆域");
    expect(night?.id).toBe("world-1");
    expect(night?.file).toBe("story/settings/world-1.md");
    expect(night?.adoptedArtifactId).toBe(nightBefore?.adoptedArtifactId);
    expect(geo?.id).toBeTruthy();
    expect(geo?.id).not.toBe("world-1");
    expect(geo?.file).not.toBe(night?.file);
    await generateGroundEntries({ ...ctx, entryIds: [geo!.id] });
    await adoptGroundEntries({ ...ctx, entryIds: [geo!.id] });
    const nightBody = await readFile(join(created.bookDir, night!.file), "utf-8");
    const geoBody = await readFile(join(created.bookDir, geo!.file), "utf-8");
    expect(nightBody).toContain("太阳永不升起");
    expect(nightBody).not.toContain("南北两片大陆");
    expect(geoBody).toContain("南北两片大陆");
  });

  it("keeps adopted setting files distinct under Windows case-equivalent names (R9-01)", async () => {
    root = await mkdtemp(join(tmpdir(), "authoring-r9-01-"));
    const created = await createLightweightBook({
      projectRoot: root,
      canon: {
        title: "永夜",
        oneLine: "规则",
        proposition: "",
        protagonist: "",
        conflict: "",
        voice: "",
        boundaries: "",
        direction: "",
        openQuestions: [],
      },
    });
    const cases = [
      { label: "upper-then-lower", oldId: "Rule", newId: "rule" },
      { label: "lower-then-upper", oldId: "rule", newId: "Rule" },
    ] as const;
    for (const sample of cases) {
      let round = 0;
      const llm: AuthoringLlmFn = async (call) => {
        const text = call.messages.map((message) => message.content).join("\n");
        if (text.includes("拟定本书设定目录")) {
          round += 1;
          if (round === 1) {
            return JSON.stringify({
              categories: ["世界"],
              entries: [{ id: sample.oldId, category: "世界", name: "永夜规则" }],
            });
          }
          return JSON.stringify({
            categories: ["世界"],
            entries: [
              { id: sample.newId, category: "世界", name: "地理疆域" },
              { id: "night-new", category: "世界", name: "永夜规则" },
            ],
          });
        }
        if (text.includes("永夜规则")) return "太阳永不升起。";
        return "只有南北两片大陆。";
      };
      const book = await createLightweightBook({
        projectRoot: root,
        existingBookId: `${created.bookId}-${sample.label}`,
        canon: {
          title: `永夜${sample.oldId}`,
          oneLine: "规则",
          proposition: "",
          protagonist: "",
          conflict: "",
          voice: "",
          boundaries: "",
          direction: "",
          openQuestions: [],
        },
      });
      const bookCtx = { root: { projectRoot: root, bookId: book.bookId }, project: project(), llm };
      await proposeSettingsCatalog(bookCtx);
      await generateGroundEntries(bookCtx);
      await adoptGroundEntries({ ...bookCtx, entryIds: [sample.oldId] });
      const next = await proposeSettingsCatalog(bookCtx);
      const night = next.entries.find((entry) => entry.name === "永夜规则");
      const geo = next.entries.find((entry) => entry.name === "地理疆域");
      expect(night?.id).toBe(sample.oldId);
      expect(night?.file).toBe(`story/settings/${sample.oldId}.md`);
      expect(geo?.file.toLowerCase()).not.toBe(night?.file.toLowerCase());
      const keys = next.entries.map((entry) => entry.file.replace(/\\/g, "/").toLowerCase());
      expect(new Set(keys).size).toBe(keys.length);
      await generateGroundEntries({ ...bookCtx, entryIds: [geo!.id] });
      await adoptGroundEntries({ ...bookCtx, entryIds: [geo!.id] });
      const nightBody = await readFile(join(book.bookDir, night!.file), "utf-8");
      const geoBody = await readFile(join(book.bookDir, geo!.file), "utf-8");
      expect(nightBody).toBe("太阳永不升起。\n");
      expect(geoBody).toContain("南北两片大陆");
      expect(nightBody).not.toContain("南北两片大陆");
    }
  });
});
