import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { buildExportArtifact, writeExportArtifact, type ExportStateLike } from "../interaction/export-artifact.js";
import {
  fanqieOptionsFromQuery,
  renderFanqieChapter,
  renderFanqieManuscript,
} from "../interaction/fanqie-text.js";

describe("番茄纯文本", () => {
  it("去掉 Markdown，标题只留一行，默认段间空一行、段首不缩进", () => {
    const text = renderFanqieChapter({
      chapterNumber: 12,
      title: "夜港",
      markdown: [
        "# 第12章 夜港",
        "",
        "# 第12章 夜港",
        "",
        "**雾**从码头漫上来，他没打*伞*。",
        "",
        "---",
        "",
        "- 巷子是空的。",
        "",
        "有人提起第12章的事。",
        "",
        "## 作者有话说",
        "",
        "明天更新。",
      ].join("\n"),
    });

    expect(text).toBe([
      "第12章 夜港",
      "",
      "雾从码头漫上来，他没打伞。",
      "",
      "巷子是空的。",
      "",
      "有人提起第12章的事。",
    ].join("\n"));
    expect(text.match(/第12章 夜港/g)).toHaveLength(1);
    expect(text.startsWith("　　")).toBe(false);
  });

  it("章纲只删提纲，后面的正文还在；缩进和空行可以改", () => {
    const text = renderFanqieChapter({
      chapterNumber: 2,
      title: "第2章 灯",
      markdown: [
        "# 第2章 灯",
        "",
        "## 章纲",
        "- 沈砚推门",
        "",
        "灯还亮着，雨也没停，巷子里一个人都没有。",
      ].join("\n"),
      style: { blankLine: false, indent: true },
    });

    expect(text).toBe([
      "第2章 灯",
      "　　灯还亮着，雨也没停，巷子里一个人都没有。",
    ].join("\n"));
    expect(text).not.toContain("沈砚推门");
    expect(text).not.toContain("章纲");
  });

  it("正文开头的同名标题行，不管是汉字章号还是重复两遍，都只出一次", () => {
    const text = renderFanqieChapter({
      chapterNumber: 3,
      title: "雨",
      markdown: "第三章：雨\n\n第3章 雨\n\n雨下了一夜。",
    });
    expect(text).toBe("第3章 雨\n\n雨下了一夜。");
  });

  it("短篇没有章号时不硬加第1章；有章号就能按范围拆开", () => {
    const single = renderFanqieManuscript({
      title: "明日来信",
      markdown: "# 明日来信\n\n**终稿**正文。\n\n## 作者有话说\n\n谢谢。",
    });
    expect(single.numbered).toBe(false);
    expect(single.combined.trim()).toBe("明日来信\n\n终稿正文。");
    expect(single.files).toHaveLength(1);
    expect(single.files[0]?.fileName).toBe("明日来信.txt");

    const serial = renderFanqieManuscript({
      title: "明日来信",
      markdown: [
        "# 明日来信",
        "",
        "引子写在信前。",
        "",
        "# 第1章 信",
        "",
        "信到了。",
        "",
        "# 第2章 回",
        "",
        "回信很短。",
      ].join("\n"),
      fromChapter: 2,
      toChapter: 2,
    });
    expect(serial.numbered).toBe(true);
    expect(serial.chaptersExported).toBe(1);
    expect(serial.combined.trim()).toBe("明日来信\n\n第2章 回\n\n回信很短。");
    expect(serial.files[0]?.fileName).toBe("第0002章 回.txt");
    expect(serial.combined).not.toContain("引子");

    const duplicated = renderFanqieManuscript({
      title: "明日来信",
      markdown: "# 第1章 信\n\n# 第1章 信\n\n信到了。\n\n# 第2章 回\n\n回了。",
    });
    expect(duplicated.chaptersExported).toBe(2);
    expect(duplicated.combined.match(/第1章 信/g)).toHaveLength(1);
  });

  it("拒绝颠倒的章节范围", () => {
    expect(() => fanqieOptionsFromQuery({ from: "5", to: "2" })).toThrow(/起始章不能大于结束章/);
    expect(fanqieOptionsFromQuery({ layout: "per-chapter", blankLine: "0", indent: "1" })).toMatchObject({
      layout: "per-chapter",
      blankLine: false,
      indent: true,
    });
  });
});

describe("番茄导出文件", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  async function fixture(): Promise<ExportStateLike> {
    root = await mkdtemp(join(tmpdir(), "fanqie-export-"));
    const bookDir = join(root, "books", "harbor");
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await writeFile(join(bookDir, "chapters", "0001_雨.md"), "# 第1章 雨\n\n**雨**下了。\n\n---\n\n他抬头。\n", "utf-8");
    await writeFile(join(bookDir, "chapters", "0002_雾.md"), "# 第2章 雾\n\n# 第2章 雾\n\n雾来了。\n\n## 作者有话说\n\n明天见。\n", "utf-8");
    return {
      bookDir: () => bookDir,
      loadBookConfig: async () => ({ title: "夜港", language: "zh" }),
      loadChapterIndex: async () => [
        { number: 1, title: "雨", status: "approved", wordCount: 4 },
        { number: 2, title: "雾", status: "drafted", wordCount: 3 },
      ],
    };
  }

  it("合成一个 txt，并保留原来的 txt 原样导出", async () => {
    const state = await fixture();
    const fanqie = await buildExportArtifact(state, "harbor", {
      format: "fanqie",
      fromChapter: 1,
      toChapter: 2,
    });
    expect(fanqie.fileName).toBe("夜港-番茄.txt");
    expect(fanqie.contentType).toContain("text/plain");
    expect(String(fanqie.payload).trim()).toBe([
      "夜港",
      "",
      "第1章 雨",
      "",
      "雨下了。",
      "",
      "他抬头。",
      "",
      "第2章 雾",
      "",
      "雾来了。",
    ].join("\n"));
    expect(String(fanqie.payload).match(/第2章 雾/g)).toHaveLength(1);
    expect(String(fanqie.payload)).not.toContain("作者有话说");
    expect(String(fanqie.payload)).not.toContain("#");

    const raw = await buildExportArtifact(state, "harbor", { format: "txt" });
    expect(String(raw.payload)).toContain("# 第1章 雨");
    expect(String(raw.payload)).toContain("**雨**");
  });

  it("按章范围写成一章一个文件，文件名带章号和章名", async () => {
    const state = await fixture();
    const dir = join(root, "out");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "旧的.txt"), "旧", "utf-8");
    const saved = await writeExportArtifact(state, "harbor", {
      format: "fanqie",
      layout: "per-chapter",
      fromChapter: 2,
      toChapter: 2,
      outputPath: dir,
    });
    expect(saved.chaptersExported).toBe(1);
    expect(saved.outputPath).toBe(dir);
    const text = await readFile(join(dir, "第0002章 雾.txt"), "utf-8");
    expect(text.trim()).toBe("第2章 雾\n\n雾来了。");
    await expect(readFile(join(dir, "旧的.txt"), "utf-8")).rejects.toThrow();
    await expect(readFile(join(dir, "第0001章 雨.txt"), "utf-8")).rejects.toThrow();

    const zipArtifact = await buildExportArtifact(state, "harbor", {
      format: "fanqie",
      layout: "per-chapter",
    });
    expect(zipArtifact.contentType).toContain("zip");
    const zip = await JSZip.loadAsync(zipArtifact.payload);
    expect(Object.keys(zip.files).sort()).toEqual(["第0001章 雨.txt", "第0002章 雾.txt"]);
    expect(await zip.file("第0001章 雨.txt")?.async("string")).toContain("他抬头。");
  });

  it("只导出已通过的章", async () => {
    const state = await fixture();
    const artifact = await buildExportArtifact(state, "harbor", {
      format: "fanqie",
      approvedOnly: true,
    });
    expect(artifact.chaptersExported).toBe(1);
    expect(String(artifact.payload)).toContain("第1章 雨");
    expect(String(artifact.payload)).not.toContain("第2章 雾");
  });
});
