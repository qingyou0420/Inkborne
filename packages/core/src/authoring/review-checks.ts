/**
 * Deterministic checks that run before the chapter review model.
 *
 * Reuses craft ban lists, AI-tell rules, and book prohibitions.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeAITells } from "../agents/ai-tells.js";
import { readBookRules, readGenreProfile } from "../agents/rules-reader.js";
import { matchCraftPatterns } from "../craft/load-craft-rules.js";
import type { AuthoringStoreRoot } from "./store.js";
import { chapterLengthNote, countChapterChars } from "./serial-ledger.js";
import type { ReviewIssue } from "./types.js";

/** Author-facing aspects. Names line up with continuity.ts labels the author can read. */
export const WRITE_REVIEW_DIMENSIONS = [
  { label: "情节推进", hint: "这一章有没有把该发生的事写出来，有没有跑偏、停住，或章号对不上。对应「本章是否写到」。" },
  { label: "人物一致", hint: "人物说话做事还是不是这个人，有没有忽然换了脾气。对应「人设走样」。" },
  { label: "伏笔", hint: "前面埋下的线索有没有接上，有没有忘了，或提前说破。" },
  { label: "节奏", hint: "哪里拖、哪里赶、转折生不生硬，篇幅和这一章该有的分量是否匹配。" },
  { label: "文笔", hint: "有没有套话、AI 腔、空泛形容、视角乱跳。对应「文风」「套话太多」。" },
] as const;

const DIMENSION_LABELS = new Set<string>(WRITE_REVIEW_DIMENSIONS.map((item) => item.label));

const DIMENSION_ALIASES: Record<string, string> = {
  情节推进: "情节推进",
  情节: "情节推进",
  本章是否写到: "情节推进",
  时间线: "情节推进",
  设定冲突: "情节推进",
  plot: "情节推进",
  人物一致: "人物一致",
  人物: "人物一致",
  人设走样: "人物一致",
  人设: "人物一致",
  character: "人物一致",
  伏笔: "伏笔",
  hook: "伏笔",
  hooks: "伏笔",
  节奏: "节奏",
  段落节奏: "节奏",
  节奏单调: "节奏",
  pacing: "节奏",
  文笔: "文笔",
  文风: "文笔",
  用词习惯: "文笔",
  套话太多: "文笔",
  套话: "文笔",
  转折套式: "文笔",
  句式排比: "文笔",
  视角: "文笔",
  prose: "文笔",
  style: "文笔",
};

export function normalizeReviewDimension(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  if (DIMENSION_LABELS.has(text)) return text;
  return DIMENSION_ALIASES[text] ?? DIMENSION_ALIASES[text.toLowerCase()] ?? "其他";
}

export function formatChecksForPrompt(issues: readonly ReviewIssue[]): string {
  if (issues.length === 0) {
    return "程序先查过这一章：没有发现套话、禁词、章号不连续或字数差得太多。";
  }
  return [
    "程序已经先查到这些。请纳入判断，不要原样再列一遍，除非你要补具体原文：",
    ...issues.map((issue) => `- [${issue.dimension ?? "其他"}] ${issue.title}：${issue.suggestion ?? issue.reason ?? ""}`),
  ].join("\n");
}

export async function collectWriteReviewChecks(input: {
  readonly root: AuthoringStoreRoot;
  readonly body: string;
  readonly chapterNumber?: number;
}): Promise<ReviewIssue[]> {
  const issues: ReviewIssue[] = [];
  const push = (issue: Omit<ReviewIssue, "sources"> & { readonly sources?: readonly string[] }) => {
    issues.push({
      ...issue,
      sources: [...(issue.sources ?? ["自动检查"])],
    });
  };

  const bookDir = input.root.bookId ? join(input.root.projectRoot, "books", input.root.bookId) : undefined;
  const target = bookDir ? await readTargetWordCount(bookDir) : undefined;
  const lengthNote = chapterLengthNote(countChapterChars(input.body), target);
  if (lengthNote) {
    push({
      issueId: "check-length",
      title: "字数和目标差一截",
      severity: "improve",
      dimension: "节奏",
      suggestion: lengthNote,
    });
  }

  if (bookDir && input.chapterNumber && input.chapterNumber > 1) {
    const present = await readChapterNumbers(bookDir);
    const missing: number[] = [];
    for (let number = 1; number < input.chapterNumber; number += 1) {
      if (!present.has(number)) missing.push(number);
    }
    if (missing.length > 0) {
      const listed = missing.slice(0, 12).join("、");
      const more = missing.length > 12 ? `等 ${missing.length} 章` : "";
      push({
        issueId: "check-chapter-gap",
        title: "章号不连续",
        severity: "improve",
        dimension: "情节推进",
        suggestion: `这一章是第 ${input.chapterNumber} 章，前面却没有第 ${listed} 章${more}。先把缺的补上，或确认你就是要跳着写。`,
      });
    }
  }

  if (input.chapterNumber) {
    const heading = headingChapterNumber(input.body);
    if (heading && heading !== input.chapterNumber) {
      push({
        issueId: "check-heading",
        title: "章号对不上",
        severity: "priority",
        dimension: "情节推进",
        evidence: `第${heading}章`,
        suggestion: `稿子开头写的是第 ${heading} 章，但这份稿挂在第 ${input.chapterNumber} 章。改一下标题，免得存错章。`,
      });
    }
    const refs = chapterNumberMentions(input.body, input.chapterNumber);
    if (refs.length > 0) {
      push({
        issueId: "check-chapter-ref",
        title: "正文里写出了章号",
        severity: "improve",
        dimension: "文笔",
        evidence: refs.slice(0, 6).join("、"),
        suggestion: `正文里还写着${refs.slice(0, 6).map((item) => `「${item}」`).join("、")}。读者看着会出戏，改成「那天」「上次」这类说法。`,
      });
    }
  }

  const language = containsMostlyEnglish(input.body) ? "en" : "zh";
  for (const hit of matchCraftPatterns(input.body, language)) {
    push({
      issueId: `check-craft-${hit.id}`,
      title: hit.name,
      severity: hit.severity === "warning" ? "style" : "priority",
      dimension: "文笔",
      evidence: clip(hit.matched),
      suggestion: hit.suggestion,
      reason: hit.description,
    });
  }

  if (input.body.trim().length >= 300) {
    for (const [index, tell] of analyzeAITells(input.body, language).issues.entries()) {
      push({
        issueId: `check-ai-${index + 1}`,
        title: tell.category,
        severity: "style",
        dimension: "文笔",
        suggestion: tell.suggestion,
        reason: tell.description,
      });
    }
  }

  if (bookDir) {
    const banned = await loadBannedWords(input.root.projectRoot, bookDir);
    const hits = banned.prohibitions.filter((word) => word.length >= 2 && word.length <= 30 && input.body.includes(word));
    if (hits.length > 0) {
      push({
        issueId: "check-prohibitions",
        title: "踩了本书禁词",
        severity: "priority",
        dimension: "文笔",
        evidence: hits.slice(0, 8).join("、"),
        suggestion: `正文里出现了本书不让写的${hits.slice(0, 8).map((word) => `「${word}」`).join("、")}。删掉或换一种写法。`,
      });
    }
    const repeated = banned.fatigue
      .map((word) => ({ word, count: countOccurrences(input.body, word) }))
      .filter((item) => item.count > 1)
      .slice(0, 8);
    if (repeated.length > 0) {
      push({
        issueId: "check-fatigue",
        title: "有些词用得太勤",
        severity: "style",
        dimension: "文笔",
        evidence: repeated.map((item) => `${item.word}×${item.count}`).join("、"),
        suggestion: `这些词在本章里反复出现：${repeated.map((item) => `「${item.word}」${item.count} 次`).join("、")}。换换说法，别老用同一个。`,
      });
    }
  }

  return issues;
}

async function readTargetWordCount(bookDir: string): Promise<number | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(bookDir, "book.json"), "utf-8")) as { chapterWordCount?: unknown };
    return typeof raw.chapterWordCount === "number" ? raw.chapterWordCount : undefined;
  } catch {
    return undefined;
  }
}

async function readChapterNumbers(bookDir: string): Promise<Set<number>> {
  try {
    const raw = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8")) as unknown;
    if (!Array.isArray(raw)) return new Set();
    const numbers = raw.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const number = Number((item as { number?: unknown }).number);
      return Number.isInteger(number) && number >= 1 ? [number] : [];
    });
    return new Set(numbers);
  } catch {
    return new Set();
  }
}

function headingChapterNumber(body: string): number | undefined {
  const line = body.split(/\r?\n/).map((item) => item.trim()).find((item) => item.length > 0) ?? "";
  const match = /^(?:#{1,6}\s*)?第\s*(\d+)\s*章/u.exec(line);
  if (!match?.[1]) return undefined;
  return Number(match[1]);
}

/** Same idea as post-write-validator's chapter-number scan, ignoring this chapter's own title line. */
function chapterNumberMentions(body: string, chapterNumber: number): string[] {
  const lines = body.split(/\r?\n/);
  const firstContent = lines.findIndex((line) => line.trim().length > 0);
  const rest = lines.filter((_, index) => index !== firstContent).join("\n");
  const matches = rest.match(/第\s*\d+\s*章|[Cc]hapter\s+\d+/g) ?? [];
  const unique = [...new Set(matches.map((item) => item.replace(/\s+/g, "")))];
  const own = new Set([`第${chapterNumber}章`, `Chapter${chapterNumber}`, `chapter${chapterNumber}`]);
  return unique.filter((item) => !own.has(item));
}

async function loadBannedWords(projectRoot: string, bookDir: string): Promise<{
  readonly prohibitions: readonly string[];
  readonly fatigue: readonly string[];
}> {
  try {
    const rules = await readBookRules(bookDir);
    const override = rules?.rules.fatigueWordsOverride ?? [];
    if (override.length > 0) {
      return { prohibitions: rules?.rules.prohibitions ?? [], fatigue: override };
    }
    let genreId = "other";
    try {
      const book = JSON.parse(await readFile(join(bookDir, "book.json"), "utf-8")) as { genre?: unknown };
      if (typeof book.genre === "string" && book.genre.trim()) genreId = book.genre.trim();
    } catch {
      genreId = "other";
    }
    const profile = await readGenreProfile(projectRoot, genreId).catch(() => undefined);
    return {
      prohibitions: rules?.rules.prohibitions ?? [],
      fatigue: profile?.profile.fatigueWords ?? [],
    };
  } catch {
    return { prohibitions: [], fatigue: [] };
  }
}

function countOccurrences(body: string, word: string): number {
  if (!word) return 0;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.match(new RegExp(escaped, "g"))?.length ?? 0;
}

function containsMostlyEnglish(body: string): boolean {
  const letters = body.match(/[A-Za-z]/g)?.length ?? 0;
  const han = body.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return letters > 40 && letters > han * 2;
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 80)}…`;
}
