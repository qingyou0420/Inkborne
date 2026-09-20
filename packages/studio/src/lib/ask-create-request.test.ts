/** SPDX-License-Identifier: AGPL-3.0-only */
import { describe, expect, it } from "vitest";
import { buildAskCreateRequest } from "./ask-create-request";
import { createBookInstruction, trimStoryCard } from "./story-card";

const fullSynopsis = "书院旧约与渡口风波。".repeat(60) + "最后一卷保留人物命运待定。";
const fullInstruction = "完整问心约定：" + "不可改变四人的身份与各自选择。".repeat(80) + "七卷结构需要完整保留。";
const proposal = {
  instruction: fullInstruction,
  requestedSkills: ["fiction"],
  actionPayload: {
    createBook: {
      title: "渡河记", genre: "古风", platform: "other" as const,
      targetChapters: 260, chapterWordCount: 5000, language: "zh" as const,
      oneLine: "四位书院友人面临渡口风波。", synopsis: fullSynopsis, tone: "克制",
    },
  },
};
const card = trimStoryCard({
  workingTitle: proposal.actionPayload.createBook.title,
  ...proposal.actionPayload.createBook,
});

describe("Ask creation request", () => {
  it("keeps complete proposal requirements and execution metadata behind the shortened card", () => {
    expect(card.synopsis).toHaveLength(300);
    const request = buildAskCreateRequest({ card, isZh: true, proposal });
    expect(request.instruction).toContain(fullInstruction);
    expect(request.instruction).toContain(fullSynopsis);
    expect(request.actionPayload.createBook).toEqual(proposal.actionPayload.createBook);
    expect(request.requestedSkills).toEqual(["fiction"]);
    expect(request.instruction).toContain("正典先保存为候选");
  });

  it("applies only author edits over the full proposal and preserves other requirements", () => {
    const edits = { workingTitle: "新的渡河记", oneLine: "作者新定的故事。", synopsis: "新约定。".repeat(200) };
    const request = buildAskCreateRequest({ card: { ...card, ...edits }, isZh: true, proposal, edits });
    expect(request.actionPayload.createBook).toEqual({
      ...proposal.actionPayload.createBook, title: edits.workingTitle, oneLine: edits.oneLine, synopsis: edits.synopsis,
    });
    expect(request.instruction).toContain(fullInstruction);
    expect(request.instruction).toContain(edits.synopsis);
    expect(request.instruction.indexOf(edits.synopsis)).toBeGreaterThan(request.instruction.indexOf(fullInstruction));
    expect(proposal.actionPayload.createBook.title).toBe("渡河记");
    expect(proposal.actionPayload.createBook.synopsis).toBe(fullSynopsis);
  });

  it("does not replace the full synopsis when the author only edits the title", () => {
    const request = buildAskCreateRequest({
      card: { ...card, workingTitle: "改名" }, isZh: true, proposal, edits: { workingTitle: "改名" },
    });
    expect(request.actionPayload.createBook?.synopsis).toBe(fullSynopsis);
    expect(request.actionPayload.createBook?.title).toBe("改名");
  });

  it("keeps the chosen manuscript language when the interface language differs", () => {
    const request = buildAskCreateRequest({ card, isZh: false, proposal });
    expect(request.actionPayload.createBook?.language).toBe("zh");
    expect(request.instruction).toContain("canon candidate");
  });

  it("supports manual cards without inventing chapter counts or carrying another proposal", () => {
    const manual = { workingTitle: "另一本书", oneLine: "新的故事", synopsis: fullSynopsis };
    const request = buildAskCreateRequest({ card: manual, isZh: true });
    expect(request.actionPayload.createBook).toEqual({
      title: manual.workingTitle, oneLine: manual.oneLine, synopsis: fullSynopsis,
      language: "zh", genre: undefined, tone: undefined,
    });
    expect(request.actionPayload.createBook?.targetChapters).toBeUndefined();
    expect(request.requestedSkills).toBeUndefined();
    expect(request.instruction).not.toContain(fullInstruction);
  });

  it("never caps the creation instruction at the story card presentation limit", () => {
    const request = createBookInstruction({ workingTitle: "长梗概", oneLine: "一句话", synopsis: fullSynopsis }, true);
    expect(request).toContain(fullSynopsis);
  });
});
