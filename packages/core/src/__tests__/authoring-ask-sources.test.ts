/** SPDX-License-Identifier: AGPL-3.0-only */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK_SOURCE_MAX_CHARS, importAskSource, inspectAskSources, listAskSources, readAskSourceContext, removeAskSource } from "../authoring/ask-sources.js";
import { adoptAskCanon, generateAskCanon, reviewAskCanon, reviseAskCanon } from "../authoring/stages/ask.js";
import { ensureAuthoringDraft } from "../authoring/drafts.js";
import { authoringRootDir, loadManifest } from "../authoring/store.js";
import { ProjectConfigSchema } from "../models/project.js";
import type { AuthoringLlmFn } from "../authoring/types.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const projectRoot = await mkdtemp(join(tmpdir(), "ask-sources-"));
  roots.push(projectRoot);
  return { projectRoot, draftId: "draft-source" };
}
describe("Ask imported sources", () => {
  it.each(["le", "be"] as const)("sends the complete BOM UTF-16%s manuscript to Ask while preserving its original bytes", async (encoding) => {
    const root = await setup();
    const content = `序章：清岚出门。\r\n${"早年手稿。".repeat(2000)}\r\n结尾：沈砚没有复活。`;
    const body = Buffer.from(content, "utf16le");
    const bytes = Buffer.concat([Buffer.from(encoding === "le" ? [0xff, 0xfe] : [0xfe, 0xff]), encoding === "le" ? body : body.swap16()]);
    const source = await importAskSource(root, { filename: "早年手稿.txt", bytes });
    const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
    const llm: AuthoringLlmFn = async (call) => {
      const prompt = call.messages.map((message) => message.content).join("\n");
      expect(prompt).toContain("结尾：沈砚没有复活。");
      expect(prompt).not.toContain("\ufffd");
      return JSON.stringify({ title: "归途", oneLine: "清岚归来", openQuestions: [] });
    };
    await generateAskCanon({ root, project, llm, conversation: "" });
    expect((await loadManifest(root)).adopted.ask).toBeUndefined();
    expect(await readFile(join(root.projectRoot, source.originalPath))).toEqual(bytes);
  });

  it("preserves undecodable original bytes and does not bind them as complete sources", async () => {
    const root = await setup();
    const bytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    await expect(importAskSource(root, { filename: "旧编码.txt", bytes })).rejects.toThrow(/另存为 UTF-8.*原始文件已保留/s);
    expect(await listAskSources(root)).toEqual([]);
    const uploads = join(root.projectRoot, ".inkos", "uploads", "ask");
    const [id] = await readdir(uploads);
    expect(await readFile(join(uploads, id, "旧编码.txt"))).toEqual(bytes);
  });

  it.each(["empty", "truncated", "same-length"] as const)("blocks %s extracted copies before any model call and keeps them removable", async (damage) => {
    const root = await setup();
    const bytes = Buffer.from("开头是河港。末尾：清岚归来。");
    const source = await importAskSource(root, { filename: "原始稿.txt", bytes });
    const path = join(root.projectRoot, source.textPath);
    const text = await readFile(path, "utf-8");
    await writeFile(path, damage === "empty" ? "" : damage === "truncated" ? text.slice(0, -4) : text.replace("清岚归来", "清岚离去"), "utf-8");
    await expect(readAskSourceContext(root)).rejects.toThrow(/缺失或损坏.*重新导入/);
    expect((await inspectAskSources(root))[0]).toMatchObject({ id: source.id, coverage: "invalid", error: expect.stringContaining("重新导入") });
    const llm = vi.fn();
    const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
    await expect(generateAskCanon({ root, project, conversation: "整理原稿", llm })).rejects.toThrow(/缺失或损坏/);
    expect(llm).not.toHaveBeenCalled();
    expect((await loadManifest(root)).candidates.ask).toBeUndefined();
    expect(await readFile(join(root.projectRoot, source.originalPath))).toEqual(bytes);
    await removeAskSource(root, source.id);
    expect(await listAskSources(root)).toEqual([]);
  });

  it("reads unchanged older records without a digest, but rejects their wrong extracted body count", async () => {
    const root = await setup();
    const source = await importAskSource(root, { filename: "旧记录.txt", bytes: Buffer.from("首段\r\n\r\n\r\n结尾事实。") });
    const { textSha256, ...legacy } = source;
    await writeFile(join(authoringRootDir(root), "source-materials", `${source.id}.json`), JSON.stringify(legacy));
    expect((await readAskSourceContext(root))[0].text).toContain("结尾事实。");
    const path = join(root.projectRoot, source.textPath);
    await writeFile(path, (await readFile(path, "utf-8")).slice(0, -2));
    await expect(readAskSourceContext(root)).rejects.toThrow(/缺失或损坏/);
  });
  it("preserves original bytes and the complete ending in generate, review, and revise without adoption or chapters", async () => {
    const root = await setup();
    const body = `开篇依据\n${"长篇中段。".repeat(12000)}\n独有终章：清岚最终归来。`;
    const bytes = Buffer.from(body);
    const source = await importAskSource(root, { filename: "旧作.md", bytes });
    expect(await readFile(join(root.projectRoot, source.originalPath))).toEqual(bytes);
    expect((await readAskSourceContext(root))[0].text).toContain("独有终章：清岚最终归来。");
    const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
    const seen: string[] = [];
    const llm: AuthoringLlmFn = async (call) => {
      const input = call.messages.map((message) => message.content).join("\n");
      seen.push(input);
      if (call.roleId === "ask.review") return JSON.stringify({ summary: "核对结尾", coverage: "全文", issues: [{ issueId: "end", title: "补足归来动机", severity: "suggestion", suggestion: "交代动机" }] });
      return JSON.stringify({ title: "旧作候选", oneLine: "清岚归来", proposition: "归途", protagonist: "清岚", conflict: "去留", voice: "第三人称", boundaries: "", direction: "回乡", openQuestions: ["作者是否沿用旧作结局？"], targetChapters: 12, chapterWordCount: 2000 });
    };
    const ctx = { root, project, llm };
    const generated = await generateAskCanon({ ...ctx, conversation: "" });
    const report = await reviewAskCanon({ ...ctx, artifactId: generated.artifactId });
    await reviseAskCanon({ ...ctx, artifactId: generated.artifactId, reportId: report.reportId, selectedIssueIds: [report.issues[0].issueId] });
    expect(seen).toHaveLength(3);
    for (const prompt of seen) {
      expect(prompt).toContain("独有终章：清岚最终归来。");
      expect(prompt).toContain("完整读取");
      expect(prompt).toContain("待作者确认");
    }
    expect((await loadManifest(root)).adopted.ask).toBeUndefined();
    await expect(readdir(join(root.projectRoot, "books"))).rejects.toMatchObject({ code: "ENOENT" });
    await ensureAuthoringDraft({ projectRoot: root.projectRoot, draftId: root.draftId });
    const adopted = await adoptAskCanon({ ...ctx, artifactId: generated.artifactId });
    const bookRoot = { projectRoot: root.projectRoot, bookId: adopted.bookId };
    expect((await listAskSources(bookRoot)).map((item) => item.id)).toEqual([source.id]);
    expect((await readAskSourceContext(bookRoot))[0].text).toContain("独有终章：清岚最终归来。");
    await removeAskSource(bookRoot, source.id);
    expect(await listAskSources(bookRoot)).toEqual([]);
    expect(await readFile(join(root.projectRoot, source.originalPath))).toEqual(bytes);
  });

  it("rejects over-limit sources visibly and preserves their entire original instead of binding a prefix", async () => {
    const root = await setup();
    const bytes = Buffer.from(`${"a".repeat(ASK_SOURCE_MAX_CHARS)}END`);
    await expect(importAskSource(root, { filename: "long.txt", bytes })).rejects.toThrow(/120,003.*120,000.*未截取开头.*原始文件已保留/s);
    expect(await listAskSources(root)).toEqual([]);
    const uploads = join(root.projectRoot, ".inkos", "uploads", "ask");
    const [id] = await readdir(uploads);
    expect(await readFile(join(uploads, id, "long.txt"))).toEqual(bytes);
  });

  it("checks aggregate coverage and removes only the binding, leaving original material available", async () => {
    const root = await setup();
    const first = await importAskSource(root, { filename: "first.txt", bytes: Buffer.from("a".repeat(80_000)) });
    await expect(importAskSource(root, { filename: "second.txt", bytes: Buffer.from("b".repeat(60_000)) })).rejects.toThrow(/140,000/);
    expect(await listAskSources(root)).toHaveLength(1);
    await removeAskSource(root, first.id);
    expect(await listAskSources(root)).toEqual([]);
    expect((await readFile(join(root.projectRoot, first.originalPath))).length).toBe(80_000);
  });
});
