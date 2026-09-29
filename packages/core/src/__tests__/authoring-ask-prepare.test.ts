import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCanon, serializeCanon } from "../authoring/canon.js";
import { loadCanonDocument } from "../authoring/context.js";
import { adoptAskCanon, prepareAskCanon } from "../authoring/stages/ask.js";
import { authoringRootDir, loadManifest, saveHandEditedArtifact, saveManifest } from "../authoring/store.js";
import { ProjectConfigSchema } from "../models/project.js";

describe("prepare existing ask canon", () => {
  let projectRoot = "";
  afterEach(async () => {
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
    projectRoot = "";
  });

  async function fixture() {
    projectRoot = await mkdtemp(join(tmpdir(), "ask-prepare-"));
    const root = { projectRoot, bookId: "existing" };
    const bookDir = join(projectRoot, "books", root.bookId);
    await mkdir(join(bookDir, "story", "outline"), { recursive: true });
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: root.bookId, title: "旧作", genre: "古风", targetChapters: 260, chapterWordCount: 5000,
    }));
    return { root, bookDir };
  }

  it("keeps all legacy sources and numeric metadata through edit and explicit adoption", async () => {
    const { root, bookDir } = await fixture();
    const sources = {
      "story_card.md": `# 确认卡\n\n## 故事摘要\n${"卡片完整内容".repeat(90)}尾声卡片`,
      "author_intent.md": "# 作者意图\n\n## 主要冲突\n不能删去的作者约定",
      "outline/story_frame.md": `# 故事框架\n\n## 核心命题\n${"框架完整内容".repeat(240)}尾声框架`,
      "story_bible.md": "## 补充背景\n另一份仍需保留的故事资料",
    };
    for (const [file, body] of Object.entries(sources)) {
      await writeFile(join(bookDir, "story", file), body);
    }
    const originalBook = await readFile(join(bookDir, "book.json"), "utf-8");
    const preview = await loadCanonDocument(root);
    expect(preview.source).toBe("compat");
    expect(preview.canon.targetChapters).toBe(260);
    await expect(access(authoringRootDir(root))).rejects.toThrow();

    const prepared = await prepareAskCanon({ root });
    expect(prepared.meta).toMatchObject({ source: "compat", status: "candidate", stage: "ask" });
    const parsed = parseCanon(prepared.body);
    expect(parsed).toMatchObject({ title: "旧作", genre: "古风", targetChapters: 260, chapterWordCount: 5000 });
    expect(parsed.oneLine).toContain("尾声卡片");
    expect(parsed.proposition).toContain("尾声框架");
    expect(parsed.proposition).toContain("另一份仍需保留的故事资料");
    expect(parsed.boundaries).toContain("### 主要冲突\n不能删去的作者约定");
    expect(parseCanon(serializeCanon(parsed))).toEqual(parsed);
    expect((await loadManifest(root)).adopted.ask).toBeUndefined();
    await expect(access(join(bookDir, "story", "canon.md"))).rejects.toThrow();
    expect(await readFile(join(bookDir, "book.json"), "utf-8")).toBe(originalBook);

    const edited = await saveHandEditedArtifact(root, prepared.meta.artifactId,
      prepared.body.replace("不能删去的作者约定", "作者亲自补充的新约定"));
    expect((await prepareAskCanon({ root })).meta.artifactId).toBe(edited.artifactId);
    const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
    const adopted = await adoptAskCanon({ root, project, artifactId: edited.artifactId });
    expect(adopted).toMatchObject({ bookId: "existing", created: false });
    const canon = parseCanon(await readFile(join(bookDir, "story", "canon.md"), "utf-8"));
    expect(canon.boundaries).toContain("作者亲自补充的新约定");
    expect(canon.oneLine).toContain("尾声卡片");
    expect(canon.proposition).toContain("尾声框架");
    expect(canon).toMatchObject({ targetChapters: 260, chapterWordCount: 5000 });
    for (const [file, body] of Object.entries(sources)) {
      expect(await readFile(join(bookDir, "story", file), "utf-8")).toBe(body);
    }
  });

  it("coalesces concurrent prepares and reuses the adopted artifact if the candidate pointer is absent", async () => {
    const { root, bookDir } = await fixture();
    await writeFile(join(bookDir, "story", "author_intent.md"), "作者已有的想法");
    const [first, second] = await Promise.all([prepareAskCanon({ root }), prepareAskCanon({ root })]);
    expect(second.meta.artifactId).toBe(first.meta.artifactId);
    expect(await readdir(join(authoringRootDir(root), "artifacts"))).toEqual([first.meta.artifactId]);
    const manifest = await loadManifest(root);
    await saveManifest(root, {
      ...manifest,
      candidates: { ...manifest.candidates, ask: undefined },
      adopted: { ...manifest.adopted, ask: first.meta.artifactId },
    });
    const reused = await prepareAskCanon({ root });
    expect(reused.meta.artifactId).toBe(first.meta.artifactId);
    expect((await loadManifest(root)).candidates.ask).toBeUndefined();
  });

  it("preserves a real canon document, including extra author sections, without rewriting it", async () => {
    const { root, bookDir } = await fixture();
    const body = "---\ntitle: 手写正典\ntargetChapters: 17\nchapterWordCount: 2800\n---\n\n## 一句话故事\n手稿\n\n## 作者自定义章节\n这段没有对应的结构字段也不能丢失。\n";
    const path = join(bookDir, "story", "canon.md");
    await writeFile(path, body);
    const prepared = await prepareAskCanon({ root });
    expect(prepared.meta.source).toBe("import");
    expect(prepared.body).toBe(body);
    expect(await readFile(path, "utf-8")).toBe(body);
    const project = ProjectConfigSchema.parse({ name: "test", version: "0.1.0", llm: { provider: "custom", model: "unused", baseUrl: "https://unused.invalid/v1" } });
    await adoptAskCanon({ root, project, artifactId: prepared.meta.artifactId });
    expect(await readFile(path, "utf-8")).toBe(body);
  });

  it("rejects empty draft and book placeholders without creating workflow files", async () => {
    const { root } = await fixture();
    const draftRoot = { projectRoot, draftId: "empty" };
    for (const emptyRoot of [root, draftRoot]) {
      await expect(prepareAskCanon({ root: emptyRoot })).rejects.toThrow("尚无可用正典");
      await expect(access(authoringRootDir(emptyRoot))).rejects.toThrow();
    }
  });

  it("can prepare an actual draft canon without creating or adopting a book", async () => {
    await fixture();
    const root = { projectRoot, draftId: "real-draft" };
    const draftDir = join(projectRoot, ".inkos", "authoring-drafts", root.draftId);
    await mkdir(draftDir, { recursive: true });
    const body = "---\ntitle: 构思\n---\n\n## 一句话故事\n已经保存的正典稿件\n";
    await writeFile(join(draftDir, "canon.md"), body);
    const prepared = await prepareAskCanon({ root });
    expect(prepared.body).toBe(body);
    expect(prepared.meta.status).toBe("candidate");
    expect((await loadManifest(root)).adopted.ask).toBeUndefined();
    expect(await readdir(join(projectRoot, "books"))).toEqual(["existing"]);
  });
});
