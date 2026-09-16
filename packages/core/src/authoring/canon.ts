/**
 * Story canon markdown — 问心 adopted source of truth.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { CanonDocumentSchema, type CanonDocument } from "./types.js";

const SECTION_MAP: ReadonlyArray<{ key: keyof CanonDocument; heading: string }> = [
  { key: "oneLine", heading: "一句话故事" },
  { key: "proposition", heading: "核心命题" },
  { key: "protagonist", heading: "主角与核心欲望" },
  { key: "conflict", heading: "主要冲突" },
  { key: "voice", heading: "叙事视角与文风" },
  { key: "boundaries", heading: "故事边界" },
  { key: "direction", heading: "初始方向" },
];

function yamlEscape(value: string): string {
  if (!value) return '""';
  if (/[:#[\]{}&*?"'\\\r\n]|^\s|\s$/.test(value)) return JSON.stringify(value);
  return value;
}

export function serializeCanon(doc: CanonDocument): string {
  const parsed = CanonDocumentSchema.parse(doc);
  const lines = [
    "---",
    `title: ${yamlEscape(parsed.title)}`,
    parsed.genre ? `genre: ${yamlEscape(parsed.genre)}` : undefined,
    parsed.targetChapters ? `targetChapters: ${parsed.targetChapters}` : undefined,
    parsed.chapterWordCount ? `chapterWordCount: ${parsed.chapterWordCount}` : undefined,
    "---",
    "",
  ].filter((line): line is string => line !== undefined);
  for (const section of SECTION_MAP) {
    lines.push(`## ${section.heading}`, "", String(parsed[section.key] ?? "").trim() || "（待补）", "");
  }
  lines.push("## 待定项", "");
  if (parsed.openQuestions.length === 0) {
    lines.push("- （无）", "");
  } else {
    for (const item of parsed.openQuestions) lines.push(`- ${item}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function parseCanon(markdown: string): CanonDocument {
  const trimmed = markdown.replace(/^\uFEFF/, "");
  let rest = trimmed;
  const meta: Record<string, string> = {};
  if (trimmed.startsWith("---")) {
    const close = trimmed.indexOf("\n---", 3);
    if (close > 0) {
      const yaml = trimmed.slice(4, close);
      rest = trimmed.slice(close + 4).replace(/^\s*\n/, "");
      for (const line of yaml.split(/\r?\n/)) {
        const eq = line.indexOf(":");
        if (eq <= 0) continue;
        const raw = line.slice(eq + 1).trim();
        let value = raw;
        if (raw.startsWith('"') && raw.endsWith('"')) {
          try { value = String(JSON.parse(raw)); } catch { value = raw.slice(1, -1); }
        } else if (raw.startsWith("'") && raw.endsWith("'")) {
          value = raw.slice(1, -1).replace(/''/g, "'");
        }
        meta[line.slice(0, eq).trim()] = value;
      }
    }
  }
  const sections = new Map<string, string>();
  let heading = "";
  const buf: string[] = [];
  const flush = () => {
    if (!heading) return;
    sections.set(heading, buf.join("\n").trim());
    buf.length = 0;
  };
  for (const line of rest.replace(/\r\n/g, "\n").split("\n")) {
    const match = /^##\s+(.+)$/.exec(line);
    if (match) {
      flush();
      heading = match[1]!.trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  const openRaw = sections.get("待定项") ?? "";
  const openQuestions = openRaw
    .split("\n")
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line && line !== "（无）");
  return CanonDocumentSchema.parse({
    title: meta.title || "未命名",
    genre: meta.genre || undefined,
    targetChapters: meta.targetChapters ? Number(meta.targetChapters) : undefined,
    chapterWordCount: meta.chapterWordCount ? Number(meta.chapterWordCount) : undefined,
    oneLine: sections.get("一句话故事") ?? "",
    proposition: sections.get("核心命题") ?? "",
    protagonist: sections.get("主角与核心欲望") ?? "",
    conflict: sections.get("主要冲突") ?? "",
    voice: sections.get("叙事视角与文风") ?? "",
    boundaries: sections.get("故事边界") ?? "",
    direction: sections.get("初始方向") ?? "",
    openQuestions,
  });
}

export function canonFromCompat(input: {
  readonly title: string;
  readonly genre?: string;
  readonly storyCard?: string;
  readonly authorIntent?: string;
  readonly storyFrame?: string;
}): CanonDocument {
  const card = input.storyCard?.trim() ?? "";
  const intent = input.authorIntent?.trim() ?? "";
  const frame = input.storyFrame?.trim() ?? "";
  return CanonDocumentSchema.parse({
    title: input.title,
    genre: input.genre,
    oneLine: firstNonEmpty(card, intent).slice(0, 200),
    proposition: frame.slice(0, 800),
    protagonist: "",
    conflict: "",
    voice: "",
    boundaries: intent,
    direction: "",
    openQuestions: ["此为正典兼容视图，由已有资料组合，尚未经问心采用。"],
  });
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim()) ?? "";
}
