/** SPDX-License-Identifier: AGPL-3.0-only */
import { describe, expect, it } from "vitest";
import { readCanonFields, updateCanonField, updateCanonText, validateCanonFields } from "./ask-canon-fields";

describe("canon field form preserves manuscript storage", () => {
  const source = '---\r\ntitle: "潮声：未寄"\r\ngenre: 都市\r\ntargetChapters: 12\r\nchapterWordCount: 300\r\ncustomNote: 留给以后的批注\r\n---\r\n\r\n## 一句话故事\r\n\r\n一封迟到的信。\r\n\r\n## 自添一节\r\n\r\n不丢失这段。\r\n';

  it("separates metadata from prose and preserves unknown fields when changing one value", () => {
    const read = readCanonFields(source);
    expect(read.fields).toEqual({ title: "潮声：未寄", genre: "都市", targetChapters: "12", chapterWordCount: "300" });
    expect(read.text).not.toContain("customNote");
    const updated = updateCanonField(source, "genre", "悬疑");
    expect(updated).toBe(source.replace("genre: 都市", 'genre: "悬疑"'));
    expect(readCanonFields(updated).text).toBe(read.text);
  });

  it("edits prose without rewriting metadata or removing author-added sections", () => {
    const text = readCanonFields(source).text;
    const updated = updateCanonText(source, text.replace("迟到", "未寄"));
    expect(updated).toBe(source.replace("迟到", "未寄"));
    expect(updated).toContain("## 自添一节");
  });

  it("supports optional scale fields, quoted titles and documents without metadata", () => {
    const removed = updateCanonField(source, "targetChapters", "");
    expect(readCanonFields(removed).fields.targetChapters).toBe("");
    expect(removed).toContain("chapterWordCount: 300");
    const title = '他写下"归来"';
    const added = updateCanonField("## 一句话故事\n\n归来的人。", "title", title);
    expect(readCanonFields(added).fields.title).toBe(title);
    expect(readCanonFields(added).text.trim()).toBe("## 一句话故事\n\n归来的人。");
  });

  it("does not mistake a later thematic break for frontmatter", () => {
    const text = "## 故事\n正文\n---\n后文";
    expect(readCanonFields(text).text).toBe(text);
    expect(updateCanonText(text, "修改后的正文")).toBe("修改后的正文");
  });

  it("rejects invalid scale fields before saving but allows the supported 300-word canon", () => {
    expect(validateCanonFields(source, true)).toBeUndefined();
    expect(validateCanonFields(updateCanonField(source, "targetChapters", "0"), true)).toContain("预计章节");
    expect(validateCanonFields(updateCanonField(source, "chapterWordCount", "99"), true)).toContain("每章字数");
    expect(validateCanonFields(updateCanonField(source, "title", ""), true)).toContain("书名");
    expect(validateCanonFields(updateCanonField(source, "targetChapters", ""), true)).toBeUndefined();
  });
});
