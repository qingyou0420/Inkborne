import { describe, expect, it } from "vitest";
import {
  MAX_VOLUME_TREE_LABEL_CHARS,
  applyOutlineWorkspaceSave,
  formatVolumeLabel,
  listedExactChapterNumbers,
  lockedNamedVolumeCount,
  missingExactChapters,
  nextUnfilledChapterBatch,
  normalizeVolumeMapChapterHeadings,
  outlineEditorSource,
  resolveOutlineWeaveStep,
  parseProseVolumeHints,
  isPlaceholderVolumeTitle,
  volumeMapHasLockedNamedVolumes,
  parseVolumeMapTree,
  volumeMapPreamble,
  volumeMapLeadingNotesMarkdown,
  splitOutlineTitleAndSummary,
  tidyVolumeMapMarkdown,
  planVolumeRanges,
  planVolumeRangesFromHints,
  renderVolumeMapMarkdown,
  resolveTargetChapterCount,
  volumeMapHasReviewableTree,
} from "../utils/volume-map-tree.js";
import { findVolumeMapEntry } from "../utils/volume-map-entry.js";

/** Real 《醉词》 leftover: 卷一《冕旒》 plus Chinese counts, not 冕旒(40). */
export const ZUI_CI_VOLUME_NOTES = [
  "## 各卷主题与情绪曲线",
  "共七卷：卷一《冕旒》、卷二《棋枰》、卷三《白羽》、卷四《商陆》、卷五《醉生》、卷六《江山》、卷七《清溪》。各卷四十、四十、四十五、四十、三十五、三十五、二十五章。第一卷压，中卷放，末卷压回。",
  "卷一埋：开篇在酒楼听曲，把旧案残页和醉词令混进宾客闲话里，让读者以为只是风月场的气氛铺垫，其实每一句唱词都在点后宅账本的缺口，后宅账本的缺口又指向令牌、典当行和县衙夜审，这一行必须长到旧解析器会把它整段当成卷标题。",
  "卷一Objective：本卷结束时主角必须在酒楼站稳眼线并拿到醉词令残页，同时让典当行承认空账，还要在县衙夜审上逼出第二证人，并且把冕旒一卷的前台冲突、关系变化和不可逆揭示全部写进这一行，旧解析器会把整段当成 1339 字标题。",
  "卷一末：酒楼眼线暴露，旧案残页被当众点破，体面撕开之后没有回头路，这一行同样长到会变成墙标题。",
  "## 卷间钩子与回收承诺",
  "第一卷埋下醉词令，中卷回收典当行空账。",
  "## 各卷OKR",
  "卷一先站稳酒楼眼线，卷二把旧案推到不可收回，卷三公开对质。",
  "KR1 = 拿到醉词令残页",
  "KR2 = 让典当行承认那笔空账",
  "KR3 = 在县衙夜审上逼出第二证人",
  "## 卷尾必须发生的改变",
  "第一卷末：身份暴露。",
  "## 节奏原则",
  "前 10 章高压引人。",
].join("\n");

/** Local 《醉词》 volume_map shape: H2s are section labels, not volumes. */
export const ZUI_CI_PROSE_FIXTURE = `${ZUI_CI_VOLUME_NOTES}\n## 第 1 章\n`;

/** What 2.0.7 actually wrote: even-split 第N程 plus leftover notes under 原架构笔记. */
export const ZUI_CI_PLACEHOLDER_LOCKED_FIXTURE = [
  "## 第1卷 第1程（1-38章）",
  "原架构笔记：",
  ZUI_CI_VOLUME_NOTES,
  "",
  "## 第2卷 第2程（39-75章）",
  "Objective：本卷结束时主角必须达成可验证的阶段状态。\nKR1：前台冲突推进\nKR2：关系或势力变化\nKR3：一次不可逆揭示",
  "",
  "## 第3卷 第3程（76-112章）",
  "Objective：本卷结束时主角必须达成可验证的阶段状态。",
  "",
  "## 第4卷 第4程（113-149章）",
  "Objective：本卷结束时主角必须达成可验证的阶段状态。",
  "",
  "## 第5卷 第5程（150-186章）",
  "Objective：本卷结束时主角必须达成可验证的阶段状态。",
  "",
  "## 第6卷 第6程（187-223章）",
  "Objective：本卷结束时主角必须达成可验证的阶段状态。",
  "",
  "## 第7卷 第7程（224-260章）",
  "Objective：本卷结束时主角必须达成可验证的阶段状态。",
].join("\n");

describe("parseVolumeMapTree — heading contract", () => {
  it("parses a reviewable 卷→章 tree", () => {
    const markdown = renderVolumeMapMarkdown([
      {
        volumeNumber: 1,
        title: "试炼",
        startChapter: 1,
        endChapter: 3,
        body: "Objective：从杂役转入正式弟子籍。\nKR1 = 拿到药园执事",
        chapters: [
          { chapterNumber: 1, title: "入局", summary: "主角走进档案室。" },
          { chapterNumber: 2, title: "夜谈", summary: "在廊下听见旧案。" },
          { chapterNumber: 3, title: "残页", summary: "发现半页案卷。" },
        ],
      },
    ]);
    const tree = parseVolumeMapTree(markdown);
    expect(tree.volumeCount).toBe(1);
    expect(tree.chapterCount).toBe(3);
    expect(tree.volumes[0]?.title.length).toBeLessThanOrEqual(MAX_VOLUME_TREE_LABEL_CHARS);
    expect(tree.volumes[0]?.title).toContain("试炼");
    expect(tree.volumes[0]?.body).toContain("Objective");
    expect(listedExactChapterNumbers(tree)).toEqual([1, 2, 3]);
  });

  it("does not treat 醉词-style prose as a wall-of-text volume title", () => {
    const tree = parseVolumeMapTree(ZUI_CI_PROSE_FIXTURE);
    expect(tree.volumeCount).toBe(0);
    expect(tree.volumes).toHaveLength(0);
    // The empty `## 第 1 章` stub is a real chapter entry; parser does not invent more.
    expect(tree.chapterCount).toBe(1);
    expect(tree.orphanChapters[0]?.title).toBe("");
    expect(formatVolumeLabel(1, ZUI_CI_PROSE_FIXTURE.split("\n").find((line) => line.startsWith("卷一埋"))!, true).length)
      .toBeLessThanOrEqual(MAX_VOLUME_TREE_LABEL_CHARS);
  });

  it("does not promote the old 卷N VOLUME_HEADER prose lines or section H2s", () => {
    const oldVolumeHeader = /^\s*卷\s*[一二三四五六七八九十百\d]+/;
    const fakeTitles = [
      ZUI_CI_PROSE_FIXTURE.split("\n").find((line) => line.startsWith("卷一埋"))!,
      ZUI_CI_PROSE_FIXTURE.split("\n").find((line) => line.startsWith("卷一Objective"))!,
      ZUI_CI_PROSE_FIXTURE.split("\n").find((line) => line.startsWith("卷一末"))!,
    ];
    expect(fakeTitles.every((line) => oldVolumeHeader.test(line))).toBe(true);
    const tree = parseVolumeMapTree(ZUI_CI_PROSE_FIXTURE);
    expect(tree.volumes).toHaveLength(0);
    for (const heading of ["各卷主题与情绪曲线", "卷间钩子与回收承诺", "各卷OKR", "卷尾必须发生的改变", "节奏原则"]) {
      expect(tree.volumes.some((volume) => volume.title.includes(heading))).toBe(false);
    }
    const hints = parseProseVolumeHints(ZUI_CI_PROSE_FIXTURE);
    expect(hints.map((hint) => `${hint.title}(${hint.chapterCount})`)).toEqual([
      "冕旒(40)",
      "棋枰(40)",
      "白羽(45)",
      "商陆(40)",
      "醉生(35)",
      "江山(35)",
      "清溪(25)",
    ]);
    expect(hints.reduce((sum, hint) => sum + hint.chapterCount, 0)).toBe(260);
    const ranges = planVolumeRangesFromHints(hints, 260);
    expect(ranges).toHaveLength(7);
    expect(ranges?.[0]).toMatchObject({ title: "冕旒", startChapter: 1, endChapter: 40 });
    expect(ranges?.[6]).toMatchObject({ title: "清溪", startChapter: 236, endChapter: 260 });
  });

  it("still recovers 冕旒(40) parenthetical hints", () => {
    const hints = parseProseVolumeHints("共七卷：冕旒(40) 棋枰(40) 白羽(45) 商陆(40) 醉生(35) 江山(35) 清溪(25)。");
    expect(hints.map((hint) => hint.title)).toEqual(["冕旒", "棋枰", "白羽", "商陆", "醉生", "江山", "清溪"]);
    expect(hints.reduce((sum, hint) => sum + hint.chapterCount, 0)).toBe(260);
  });

  it("pairs 卷一《冕旒》四十章 adjacent counts", () => {
    const hints = parseProseVolumeHints("卷一《冕旒》四十章，卷二《棋枰》四十章，卷三《白羽》四十五章。");
    expect(hints).toEqual([
      { title: "冕旒", chapterCount: 40 },
      { title: "棋枰", chapterCount: 40 },
      { title: "白羽", chapterCount: 45 },
    ]);
  });

  it("re-reads leftover 原架构笔记 after a 第N程 even-split lock", () => {
    const tree = parseVolumeMapTree(ZUI_CI_PLACEHOLDER_LOCKED_FIXTURE);
    expect(tree.volumeCount).toBe(7);
    expect(tree.volumes.map((volume) => volume.title)).toEqual(
      expect.arrayContaining(["第1卷 第1程", "第7卷 第7程"]),
    );
    expect(tree.volumes.every((volume) => isPlaceholderVolumeTitle(volume.title))).toBe(true);
    expect(volumeMapHasLockedNamedVolumes(tree)).toBe(false);
    expect(resolveOutlineWeaveStep(tree, 260, ZUI_CI_PLACEHOLDER_LOCKED_FIXTURE)).toBe("volumes");
    const hints = parseProseVolumeHints(ZUI_CI_PLACEHOLDER_LOCKED_FIXTURE);
    expect(hints.map((hint) => `${hint.title}(${hint.chapterCount})`)).toEqual([
      "冕旒(40)",
      "棋枰(40)",
      "白羽(45)",
      "商陆(40)",
      "醉生(35)",
      "江山(35)",
      "清溪(25)",
    ]);
    expect(planVolumeRanges(260)[0]).toMatchObject({ startChapter: 1, endChapter: 38 });
  });

  it("keeps a heading-only 第N卷 title short even if a writer stuffed junk after the marker", () => {
    const tree = parseVolumeMapTree("## 第1卷 试炼：卷一埋很长的OKR和KR1不要进标题（1-4章）\nObjective：开局。\n");
    expect(tree.volumeCount).toBe(1);
    expect(tree.volumes[0]?.title.length).toBeLessThanOrEqual(MAX_VOLUME_TREE_LABEL_CHARS);
    expect(tree.volumes[0]?.title).not.toMatch(/KR1|埋很长/);
    expect(formatVolumeLabel(tree.volumes[0]!.volumeNumber, tree.volumes[0]!.title, true).length)
      .toBeLessThanOrEqual(MAX_VOLUME_TREE_LABEL_CHARS);
  });

  it("folds junk 第N卷 headings into 备注 and keeps 7 locked volumes", () => {
    const messy = [
      "## 第1卷 书院（1-38章）",
      "本卷要抵达：相识。",
      "## 第一卷分章事件清单（可在其上补合细纲）",
      "旧清单不要算一卷。",
      "## 第一卷·节点A",
      "节点说明。",
      "## 第一卷·节点B",
      "## 第 1 章 倒叙冷开",
      "落回书院春日。",
      "## 第 4–13 章（粗纲）",
      "后半卷粗排。",
      "## 第二卷:以\"德者掌兵\"开局压阵",
      "这不是卷。",
      "## 第2卷 焚院（39-72章）",
      "## 第3卷 白羽（73-117章）",
      "## 第4卷 商陆（118-157章）",
      "## 第5卷 醉生（158-192章）",
      "## 第6卷 江山（193-227章）",
      "## 第7卷 清溪（228-260章）",
    ].join("\n");
    const tree = parseVolumeMapTree(messy);
    expect(tree.volumeCount).toBe(7);
    expect(lockedNamedVolumeCount(tree)).toBe(7);
    expect(tree.volumes.some((volume) => /节点|分章|德者掌兵/.test(volume.title))).toBe(false);
    expect(tree.volumes[0]?.notes.some((note) => note.title.includes("节点A"))).toBe(true);
    expect(tree.volumes[0]?.chapters.some((node) => node.kind === "range" && node.chapterNumber === 4)).toBe(true);
    const tidied = parseVolumeMapTree(tidyVolumeMapMarkdown(messy));
    expect(tidied.volumeCount).toBe(7);
    expect(tidied.volumes[0]?.title).toMatch(/书院/);
  });

  it("does not invent chapter entries from volume prose", () => {
    const tree = parseVolumeMapTree("## 第1卷 试炼（1-4章）\nObjective：开局。\n");
    expect(tree.chapterCount).toBe(0);
    expect(findVolumeMapEntry("## 第1卷 试炼（1-4章）\nObjective：开局。\n", 1)).toBeUndefined();
  });
});

describe("planVolumeRanges", () => {
  it("splits 90 chapters across multiple volumes", () => {
    const ranges = planVolumeRanges(90);
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges[0]?.startChapter).toBe(1);
    expect(ranges.at(-1)?.endChapter).toBe(90);
    expect(ranges.reduce((sum, range) => sum + (range.endChapter - range.startChapter + 1), 0)).toBe(90);
  });

  it("does not dump 200 chapters into one volume", () => {
    expect(planVolumeRanges(200).length).toBeGreaterThan(3);
  });

  it("resolves chapter count from total words when targetChapters is missing", () => {
    expect(resolveTargetChapterCount({ totalWords: 270_000, chapterWordCount: 3000 })).toBe(90);
    expect(resolveTargetChapterCount({ targetChapters: 90, totalWords: 10 })).toBe(90);
  });
});

describe("renderVolumeMapMarkdown", () => {
  it("emits a 90-chapter tree the outline parser can review", () => {
    const ranges = planVolumeRanges(90);
    const volumes = ranges.map((range) => ({
      ...range,
      title: `弧${range.volumeNumber}`,
      body: `Objective：第${range.volumeNumber}卷推进。`,
      chapters: Array.from({ length: range.endChapter - range.startChapter + 1 }, (_, index) => ({
        chapterNumber: range.startChapter + index,
        title: `节点${range.startChapter + index}`,
        summary: `推进到节点${range.startChapter + index}。`,
      })),
    }));
    const markdown = renderVolumeMapMarkdown(volumes);
    const tree = parseVolumeMapTree(markdown);
    expect(tree.volumeCount).toBeGreaterThan(1);
    expect(listedExactChapterNumbers(tree)).toHaveLength(90);
    expect(volumeMapHasReviewableTree(tree, 90)).toBe(true);
    for (const volume of tree.volumes) {
      expect(volume.title.length).toBeLessThanOrEqual(MAX_VOLUME_TREE_LABEL_CHARS);
      expect(volume.title).not.toMatch(/OKR|KR1|埋线/);
    }
  });

  it("emits headings parseVolumeMapTree can read as N volumes and targetChapters chapters", () => {
    const ranges = planVolumeRanges(12);
    const volumes = ranges.map((range) => ({
      ...range,
      title: `弧${range.volumeNumber}`,
      body: `Objective：第${range.volumeNumber}卷推进。`,
      chapters: Array.from({ length: range.endChapter - range.startChapter + 1 }, (_, index) => ({
        chapterNumber: range.startChapter + index,
        title: `节点${range.startChapter + index}`,
        summary: `推进到节点${range.startChapter + index}。`,
      })),
    }));
    const markdown = renderVolumeMapMarkdown(volumes);
    const tree = parseVolumeMapTree(markdown);
    expect(volumeMapHasReviewableTree(tree, 12)).toBe(true);
    expect(missingExactChapters(tree, 12)).toEqual([]);
    expect(findVolumeMapEntry(markdown, 1)).toBeTruthy();
  });

  it("resumes 醉词-style books as volume-lock then 10-chapter batches", () => {
    expect(resolveOutlineWeaveStep(parseVolumeMapTree(ZUI_CI_PROSE_FIXTURE), 260, ZUI_CI_PROSE_FIXTURE)).toBe("volumes");
    expect(resolveOutlineWeaveStep(
      parseVolumeMapTree(ZUI_CI_PLACEHOLDER_LOCKED_FIXTURE),
      260,
      ZUI_CI_PLACEHOLDER_LOCKED_FIXTURE,
    )).toBe("volumes");
    const locked = renderVolumeMapMarkdown([{
      volumeNumber: 1,
      title: "冕旒",
      startChapter: 1,
      endChapter: 40,
      body: "Objective：开局。",
      chapters: [{ chapterNumber: 1, title: "入局", summary: "走进酒楼。" }],
    }]);
    const tree = parseVolumeMapTree(locked);
    expect(resolveOutlineWeaveStep(tree, 40, locked)).toBe("batch");
    expect(nextUnfilledChapterBatch(tree, 40, 10)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});

describe("splitOutlineTitleAndSummary", () => {
  it("splits at 12 characters and keeps paired parentheses in the short title", () => {
    const split = splitOutlineTitleAndSummary(
      "倒叙冷开(见开篇技法)→落回书院春日苏绻入辩堂初遇阿月后身份暗流起",
      "",
    );
    expect(split.split).toBe(true);
    expect(split.title).toBe("倒叙冷开(见开篇技法)");
    expect([...split.title].length).toBeLessThanOrEqual(12);
    expect(split.summary).toContain("落回书院");
  });

  it("treats ASCII comma / semicolon / colon as separators", () => {
    const comma = splitOutlineTitleAndSummary("辩堂正面交锋,苏缙以文脉对抗旧学", "");
    expect(comma.split).toBe(true);
    expect(comma.title).toBe("辩堂正面交锋");
    expect(comma.summary).toContain("苏缙以文脉");

    const semi = splitOutlineTitleAndSummary("夜审开庭追问旧案;第二证人被逼出当堂", "");
    expect(semi.title).toBe("夜审开庭追问旧案");
    expect(semi.summary).toContain("第二证人");
  });

  it("does not split a short title or a title that already has a summary", () => {
    expect(splitOutlineTitleAndSummary("短题尚可", "").split).toBe(false);
    expect(splitOutlineTitleAndSummary("这是超过十二个字的长标题没有标点符号", "已有提要").split).toBe(false);
  });

  it("falls back to a truncated title and keeps the full original as summary", () => {
    const original = "这是超过十二个字的长标题没有标点符号";
    const split = splitOutlineTitleAndSummary(original, "");
    expect(split.split).toBe(true);
    expect([...split.title].length).toBeLessThanOrEqual(12);
    expect(split.summary).toBe(original);
  });

  it("uses a 24-character threshold for English", () => {
    const english = splitOutlineTitleAndSummary("A longer english title", "", { language: "en" });
    expect(english.split).toBe(false);
    const long = splitOutlineTitleAndSummary(
      "Opening clash, Su argues the lineage against the old school",
      "",
      { language: "en" },
    );
    expect(long.split).toBe(true);
    expect(long.title).toBe("Opening clash");
    expect(long.summary).toContain("Su argues");
  });
});

describe("normalizeVolumeMapChapterHeadings", () => {
  it("rewrites only the oversized chapter heading into title + summary lines", () => {
    const markdown = [
      "## 第1卷 书院（1-38章）",
      "本卷要抵达：相识。",
      "",
      "## 第 1 章 倒叙冷开(见开篇技法)→落回书院春日苏绻入辩堂初遇阿月后身份暗流起",
      "## 第 2 章 短题",
      "已有提要。",
      "### 备注",
      "卷末笔记。",
      "",
    ].join("\n");
    const next = normalizeVolumeMapChapterHeadings(markdown);
    const originalLines = markdown.split("\n");
    const nextLines = next.split("\n");
    expect(nextLines[0]).toBe(originalLines[0]);
    expect(nextLines[1]).toBe(originalLines[1]);
    expect(nextLines[3]).toBe("## 第 1 章 倒叙冷开(见开篇技法)");
    expect(nextLines[4]).toContain("落回书院");
    expect(next).toContain("## 第 2 章 短题");
    expect(next).toContain("已有提要。");
    expect(next).toContain("### 备注");
    expect(next).toContain("卷末笔记。");
    const chapter2Index = nextLines.findIndex((line) => line.includes("第 2 章"));
    const originalChapter2 = originalLines.findIndex((line) => line.includes("第 2 章"));
    expect(nextLines[chapter2Index]).toBe(originalLines[originalChapter2]);
    expect(nextLines[chapter2Index + 1]).toBe(originalLines[originalChapter2 + 1]);
  });

  it("does not rewrite a file that only has short titles", () => {
    const markdown = "## 第 1 章 短题\n一句提要。\n";
    expect(normalizeVolumeMapChapterHeadings(markdown)).toBe(markdown);
  });

  it("keeps the editor source split so an unchanged select-save is a no-op", () => {
    const markdown = "## 第 1 章 倒叙冷开(见开篇技法)→落回书院春日苏绻入辩堂\n";
    const tree = parseVolumeMapTree(markdown);
    const node = tree.orphanChapters[0]!;
    const source = outlineEditorSource(node);
    expect(source.split).toBe(true);
    expect(applyOutlineWorkspaceSave(markdown, node.id, source.title, source.summary)).toBe(markdown);
  });

  it("extracts the same preamble for standard, plain, and bold volume headings (R9-02)", () => {
    const samples = [
      ["standard", "## 第1卷 纸城（1-4章）\n卷纲。\n## 第 1 章 来信\n死亡。\n"],
      ["plain", "第1卷 纸城（1-4章）\n卷纲。\n第 1 章 来信\n死亡。\n"],
      ["bold", "## **第1卷** 纸城（1-4章）\n卷纲。\n## **第 1 章** 来信\n死亡。\n"],
    ] as const;
    for (const [label, structure] of samples) {
      const markdown = `唯一全书纲 BOOK_OVERVIEW。\n\n${structure}`;
      const tree = parseVolumeMapTree(markdown);
      expect(tree.volumeCount, label).toBe(1);
      expect(tree.chapterCount, label).toBe(1);
      expect(volumeMapPreamble(markdown), label).toBe("唯一全书纲 BOOK_OVERVIEW。");
      expect(volumeMapPreamble(markdown), label).not.toContain("死亡");
      expect(volumeMapPreamble(markdown), label).not.toContain("卷纲");
    }
    const mixed = [
      "叙述里会提到第1章和第2卷，但那不是标题。",
      "",
      "## 第1卷 纸城（1-4章）",
      "卷纲。",
      "## 第 1 章 来信",
      "死亡。",
    ].join("\n");
    expect(volumeMapPreamble(mixed)).toContain("第1章和第2卷");
    expect(volumeMapPreamble(mixed)).not.toContain("死亡");
    expect(parseVolumeMapTree(mixed).volumeCount).toBe(1);
  });

  it("keeps volume-order notes out of the book outline and formats them for rewrite (R10-01)", () => {
    const samples = [
      ["## 第1卷·节点A", "作者要求全书坚持限知视角，禁止提前泄露幕后身份。"],
      ["## 第一卷：人物弧线", "作者要求配角不会背叛主角。"],
      ["## **第1卷**·节点A", "作者要求保留配角生还线索。"],
    ] as const;
    for (const [heading, body] of samples) {
      const markdown = [
        "唯一全书纲 BOOK_OVERVIEW。",
        "",
        heading,
        body,
        "",
        "## 第1卷 纸城（1-4章）",
        "卷纲。",
        "## 第 1 章 来信",
        "死亡。",
      ].join("\n");
      const tree = parseVolumeMapTree(markdown);
      expect(tree.orphanNotes.length).toBe(1);
      expect(volumeMapPreamble(markdown)).toBe("唯一全书纲 BOOK_OVERVIEW。");
      expect(volumeMapPreamble(markdown)).not.toContain(body);
      const notes = volumeMapLeadingNotesMarkdown(markdown);
      expect(notes).toContain(heading);
      expect(notes).toContain(body);
    }
    const ordinary = [
      "BOOK_OVERVIEW。",
      "## 写作方向",
      "限知视角。",
      "",
      "## 第1卷 纸城（1-4章）",
      "卷纲。",
      "## 第 1 章 来信",
      "死亡。",
    ].join("\n");
    expect(parseVolumeMapTree(ordinary).orphanNotes).toHaveLength(0);
    expect(volumeMapPreamble(ordinary)).toContain("写作方向");
    expect(volumeMapPreamble(ordinary)).toContain("限知视角");
    expect(volumeMapLeadingNotesMarkdown(ordinary)).toBe("");
  });

  it("saves an empty volume summary without deleting later notes (R11-02)", () => {
    const source = [
      "# 全书",
      "BOOK_OVERVIEW",
      "",
      "## 第1卷 纸城（1-4章）",
      "EMPTY_VOLUME_BODY",
      "",
      "## 第1卷·节点A",
      "EMPTY_VOLUME_NOTE",
      "",
      "## 第2卷 南岸（5-5章）",
      "VOL2_BODY",
      "",
      "## 第 5 章 渡口",
      "CH5_SUMMARY",
      "",
    ].join("\n");
    const tree = parseVolumeMapTree(source);
    const volume = tree.volumes[0]!;
    expect(volume.notes.some((note) => note.body.includes("EMPTY_VOLUME_NOTE"))).toBe(true);
    const sourceEdit = outlineEditorSource(volume);
    expect(applyOutlineWorkspaceSave(source, volume.id, sourceEdit.title, sourceEdit.summary)).toBe(source);
    const next = applyOutlineWorkspaceSave(
      source,
      volume.id,
      sourceEdit.title,
      `${sourceEdit.summary}\nUSER_ADDED_ONE_LINE`,
    );
    expect(next).toContain("USER_ADDED_ONE_LINE");
    expect(next).toContain("EMPTY_VOLUME_NOTE");
    expect(next).toContain("VOL2_BODY");
    expect(next).toContain("CH5_SUMMARY");
    const twoNotes = source.replace(
      "EMPTY_VOLUME_NOTE",
      "EMPTY_VOLUME_NOTE\n\n## 第1卷·节点B\nSECOND_NOTE",
    );
    const twoTree = parseVolumeMapTree(twoNotes);
    const editedTwo = applyOutlineWorkspaceSave(
      twoNotes,
      twoTree.volumes[0]!.id,
      outlineEditorSource(twoTree.volumes[0]!).title,
      `${outlineEditorSource(twoTree.volumes[0]!).summary}\nUSER_ADDED_ONE_LINE`,
    );
    expect(editedTwo).toContain("EMPTY_VOLUME_NOTE");
    expect(editedTwo).toContain("SECOND_NOTE");
    expect(editedTwo).toContain("VOL2_BODY");
  });
});
