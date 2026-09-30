import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { buildExportArtifact, writeExportArtifact, type ExportStateLike } from "../interaction/export-artifact.js";
import { InteractionRequestSchema } from "../interaction/intents.js";
import {
  fanqieOptionsFromQuery,
  renderFanqieChapter,
  renderFanqieManuscript,
} from "../interaction/fanqie-text.js";

describe("TXT 纯文本", () => {
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
      "* * *",
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

  it("drops fence markers and strikethrough marks", () => {
    const text = renderFanqieChapter({
      chapterNumber: 4,
      title: "信",
      markdown: [
        "# 第4章 信",
        "",
        "正文还在。",
        "",
        "```",
        "围栏里的一句",
        "```",
        "",
        "他~~不该留下的口气~~说完了。",
      ].join("\n"),
    });
    expect(text).not.toContain("```");
    expect(text).toContain("围栏里的一句");
    expect(text).toContain("他不该留下的口气说完了。");
    expect(text).not.toContain("~~");
  });

  it("拒绝颠倒的章节范围", () => {
    expect(() => fanqieOptionsFromQuery({ from: "5", to: "2" })).toThrow(/起始章不能大于结束章/);
    expect(fanqieOptionsFromQuery({ layout: "per-chapter", blankLine: "0", indent: "1" })).toMatchObject({
      layout: "per-chapter",
      blankLine: false,
      indent: true,
    });
  });

  it("把常见分节符收成一行 * * *，章首章末和连续的都只留中间那一个", () => {
    const between = (mark: string) => renderFanqieChapter({
      chapterNumber: 1,
      title: "雨",
      markdown: `# 第1章 雨\n\n上。\n\n${mark}\n\n下。\n`,
    });
    const expected = ["第1章 雨", "", "上。", "", "* * *", "", "下。"].join("\n");
    for (const mark of ["---", "***", "___", "———", "* * *", "- - -", "===", "──", "――", "= = ="]) {
      expect(between(mark), mark).toBe(expected);
    }

    const edges = renderFanqieChapter({
      chapterNumber: 1,
      title: "雨",
      markdown: [
        "# 第1章 雨",
        "",
        "---",
        "",
        "***",
        "",
        "上。",
        "",
        "---",
        "",
        "***",
        "",
        "———",
        "",
        "___",
        "",
        "下。",
        "",
        "---",
        "",
      ].join("\n"),
    });
    expect(edges).toBe(["第1章 雨", "", "上。", "", "* * *", "", "下。"].join("\n"));
  });

  it("缩进不加在分节符上；关掉空行时分节符仍独占一行", () => {
    const indented = renderFanqieChapter({
      chapterNumber: 1,
      title: "雨",
      markdown: "# 第1章 雨\n\n上。\n\n---\n\n下。\n",
      style: { indent: true, blankLine: true },
    });
    expect(indented).toBe([
      "第1章 雨",
      "",
      "　　上。",
      "",
      "* * *",
      "",
      "　　下。",
    ].join("\n"));
    expect(indented).not.toContain("　　* * *");

    const tight = renderFanqieChapter({
      chapterNumber: 1,
      title: "雨",
      markdown: "# 第1章 雨\n\n上。\n\n* * *\n\n下。\n",
      style: { indent: true, blankLine: false },
    });
    expect(tight).toBe(["第1章 雨", "　　上。", "* * *", "　　下。"].join("\n"));
  });

  it("行内的横线和单独一个破折号留着，文首的 frontmatter 仍剥掉", () => {
    const text = renderFanqieChapter({
      chapterNumber: 1,
      title: "雨",
      markdown: [
        "---",
        "title: 夜",
        "---",
        "",
        "# 第1章 雨",
        "",
        "今天 --- 继续。",
        "",
        "—",
        "",
        "他说——完了。",
        "",
        "--",
        "",
        "**",
        "",
        "下。",
      ].join("\n"),
    });
    expect(text).not.toContain("title");
    expect(text).not.toContain("* * *");
    expect(text).toContain("今天 --- 继续。");
    expect(text).toContain("—");
    expect(text).toContain("他说——完了。");
    expect(text).toContain("--");
    expect(text).toContain("下。");
    expect(text.split("\n").some((line) => line.trim() === "*")).toBe(false);
  });

  it("合成稿和每章文件、没有章号的短篇都带上分节符", () => {
    const serial = renderFanqieManuscript({
      title: "夜港",
      markdown: [
        "引子之前。",
        "",
        "---",
        "",
        "引子之后。",
        "",
        "# 第1章 雨",
        "",
        "雨下了。",
        "",
        "---",
        "",
        "他抬头。",
        "",
        "# 第2章 雾",
        "",
        "***",
        "",
        "雾来了。",
        "",
        "___",
        "",
        "还有人。",
      ].join("\n"),
    });
    expect(serial.combined).toContain("* * *");
    expect(serial.combined).not.toContain("---");
    expect(serial.combined).not.toContain("***");
    expect(serial.files[0]?.text).toBe("第1章 雨\n\n雨下了。\n\n* * *\n\n他抬头。\n");
    expect(serial.files[1]?.text).toBe("第2章 雾\n\n雾来了。\n\n* * *\n\n还有人。\n");
    expect(serial.combined).toContain("引子之前。");
    expect(serial.combined).toContain("引子之后。");

    const plain = renderFanqieManuscript({
      title: "短信",
      markdown: "# 短信\n\n上一段。\n\n---\n\n下一段。\n",
    });
    expect(plain.numbered).toBe(false);
    expect(plain.combined).toContain("* * *");
    expect(plain.combined).not.toContain("---");
    expect(plain.files[0]?.text).toContain("* * *");
  });

  it("交互请求不再接受 fanqie 格式值", () => {
    expect(InteractionRequestSchema.safeParse({ intent: "export_book", format: "fanqie" }).success).toBe(false);
    expect(InteractionRequestSchema.safeParse({ intent: "export_book", format: "txt" }).success).toBe(true);
  });
});

describe("TXT 导出文件", () => {
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

  it("合成一个 txt，md 仍是原来的 Markdown 拼接", async () => {
    const state = await fixture();
    const txt = await buildExportArtifact(state, "harbor", {
      format: "txt",
      fromChapter: 1,
      toChapter: 2,
    });
    expect(txt.format).toBe("txt");
    expect(txt.fileName).toBe("夜港.txt");
    expect(txt.outputPath).toBe(join(root, "harbor_export.txt"));
    expect(txt.contentType).toContain("text/plain");
    expect(String(txt.payload).trim()).toBe([
      "夜港",
      "",
      "第1章 雨",
      "",
      "雨下了。",
      "",
      "* * *",
      "",
      "他抬头。",
      "",
      "第2章 雾",
      "",
      "雾来了。",
    ].join("\n"));
    expect(String(txt.payload).match(/第2章 雾/g)).toHaveLength(1);
    expect(String(txt.payload)).not.toContain("作者有话说");
    expect(String(txt.payload)).not.toContain("#");
    expect(String(txt.payload)).not.toContain("**");
    expect(String(txt.payload)).not.toContain("---");

    const markdown = await buildExportArtifact(state, "harbor", {
      format: "md",
      fromChapter: 2,
      toChapter: 2,
    });
    expect(String(markdown.payload)).toContain("# 第1章 雨");
    expect(String(markdown.payload)).toContain("**雨**");
    expect(String(markdown.payload)).toContain("---");
    expect(markdown.fileName).toBe("harbor.md");
  });

  it("按章范围写成一章一个文件，文件名带章号和章名", async () => {
    const state = await fixture();
    const dir = join(root, "out");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "旧的.txt"), "旧", "utf-8");
    const saved = await writeExportArtifact(state, "harbor", {
      format: "txt",
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
      format: "txt",
      layout: "per-chapter",
    });
    expect(zipArtifact.fileName).toBe("夜港.zip");
    expect(zipArtifact.contentType).toContain("zip");
    const zip = await JSZip.loadAsync(zipArtifact.payload);
    expect(Object.keys(zip.files).sort()).toEqual(["第0001章 雨.txt", "第0002章 雾.txt"]);
    const chapter = await zip.file("第0001章 雨.txt")?.async("string");
    expect(chapter).toContain("他抬头。");
    expect(chapter).toContain("* * *");
    expect(chapter).not.toContain("---");
    expect(chapter?.split("\n").some((line) => line.trim() === "*")).toBe(false);
  });

  it("只导出已通过的章", async () => {
    const state = await fixture();
    const artifact = await buildExportArtifact(state, "harbor", {
      format: "txt",
      approvedOnly: true,
    });
    expect(artifact.chaptersExported).toBe(1);
    expect(String(artifact.payload)).toContain("第1章 雨");
    expect(String(artifact.payload)).toContain("* * *");
    expect(String(artifact.payload)).not.toContain("第2章 雾");
  });

  it("没有章节时，txt 用中文报错，md 和 epub 仍用英文", async () => {
    const state = await fixture();
    const empty = { ...state, loadChapterIndex: async () => [] };
    await expect(buildExportArtifact(empty, "harbor", { format: "txt" })).rejects.toThrow("没有可导出的章节。");
    await expect(buildExportArtifact(empty, "harbor", { format: "md" })).rejects.toThrow("No chapters to export.");
    await expect(buildExportArtifact(empty, "harbor", { format: "epub" })).rejects.toThrow("No chapters to export.");
  });

  it("epub 仍能生成", async () => {
    const state = await fixture();
    const epub = await buildExportArtifact(state, "harbor", { format: "epub" });
    expect(epub.format).toBe("epub");
    expect(epub.contentType).toContain("epub");
    expect(Buffer.isBuffer(epub.payload)).toBe(true);
    expect((epub.payload as Buffer).length).toBeGreaterThan(100);
  });
});
