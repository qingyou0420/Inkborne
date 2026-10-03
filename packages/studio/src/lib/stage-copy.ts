/**
 * C.5 empty-state and stage-aware CTA copy.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { BookStageId } from "./book-stage";
import type { AuthoringCatalogEntry, AuthoringWorkspace } from "./authoring-workspace";
import { roleFromPath } from "./truth-display";

export interface StageGuideCopy {
  readonly title: string;
  readonly subtitle: string;
  readonly action: string;
  readonly target: "ask" | "ground" | "weave" | "write" | "create";
}

export function studyGuideCopy(stage: BookStageId, isZh: boolean): StageGuideCopy {
  if (stage === "ask") {
    return isZh
      ? { title: "这本书还没有名字", subtitle: "先聊清楚它讲什么", action: "去问心", target: "ask" }
      : { title: "This book still needs a name", subtitle: "Talk through what it is about first", action: "Go to Ask", target: "ask" };
  }
  if (stage === "ground") {
    return isZh
      ? { title: "先把世界与人磨实", subtitle: "先在研墨采用至少一组设定", action: "去研墨", target: "ground" }
      : { title: "Settle the world and people first", subtitle: "Adopt at least one setting group in Ground first", action: "Go to Ground", target: "ground" };
  }
  if (stage === "weave") {
    return isZh
      ? { title: "全书要分几卷？", subtitle: "先生成并采用分卷规划", action: "去织卷", target: "weave" }
      : { title: "How many volumes?", subtitle: "Generate and adopt the volume plan first", action: "Go to Weave", target: "weave" };
  }
  return isZh
    ? { title: "今日一笔", subtitle: "", action: "写下一章（旧管线）", target: "write" }
    : { title: "Today's stroke", subtitle: "", action: "Write next (legacy)", target: "write" };
}

export function weaveGuideWhenUngrounded(isZh: boolean): StageGuideCopy {
  return isZh
    ? { title: "纲要生于设定", subtitle: "先在研墨采用至少一组设定", action: "去研墨", target: "ground" }
    : { title: "The plan grows from settings", subtitle: "Adopt at least one setting group in Ground first", action: "Go to Ground", target: "ground" };
}

export function weaveLengthGateCopy(isZh: boolean): StageGuideCopy {
  return isZh
    ? { title: "先定全书篇幅", subtitle: "请先在问心正典里确认目标章数和每章字数", action: "去问心", target: "ask" }
    : { title: "Set the book length first", subtitle: "Confirm target chapters and words per chapter in Ask canon", action: "Go to Ask", target: "ask" };
}

export function writeEmptyCopy(input: {
  readonly hasOutline: boolean;
  readonly previousUnapproved?: number;
  readonly isZh: boolean;
}): StageGuideCopy {
  if (input.previousUnapproved) {
    return input.isZh
      ? { title: `第 ${input.previousUnapproved} 章等你过目`, subtitle: "先审查上一章，再写下一章", action: "去落笔审查", target: "write" }
      : { title: `Chapter ${input.previousUnapproved} is waiting`, subtitle: "Review the last chapter before writing on", action: "Review in Write", target: "write" };
  }
  if (!input.hasOutline) {
    return input.isZh
      ? { title: "还没有可写的章", subtitle: "去织卷生成章概要", action: "去织卷", target: "weave" }
      : { title: "No writable chapter yet", subtitle: "Generate chapter summaries in Weave first", action: "Go to Weave", target: "weave" };
  }
  return input.isZh
    ? { title: "还没有落笔", subtitle: "从下一章开始", action: "写下一章（旧管线）", target: "write" }
    : { title: "Nothing on the page yet", subtitle: "Start with the next chapter", action: "Write next (legacy)", target: "write" };
}

export function shelfEmptyCopy(isZh: boolean): StageGuideCopy {
  return isZh
    ? { title: "书架还空着", subtitle: "从一句话开始", action: "开始创作", target: "create" }
    : { title: "The shelf is empty", subtitle: "Start from one sentence", action: "Start creating", target: "create" };
}

export const IN_PROGRESS_BOOK_STATUSES = ["incubating", "outlining", "active"] as const;

export function isInProgressBookStatus(status: string): boolean {
  return (IN_PROGRESS_BOOK_STATUSES as readonly string[]).includes(status);
}

export function isInProgressShortStatus(status: string): boolean {
  return status === "outlining" || status === "drafting";
}

export function formatStartedOn(iso: string | undefined, isZh: boolean): string {
  if (!iso) return "";
  const date = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  return isZh ? `始于 ${date}` : `Since ${date}`;
}

export function formatConfirmedDate(iso: string | undefined, isZh: boolean): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (isZh) return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export interface FourStepCopyInput {
  readonly askDone: boolean;
  readonly grounded: boolean;
  readonly roleCount: number;
  readonly authoring?: AuthoringWorkspace;
  readonly lockedVolumes: number;
  readonly outlineDone: boolean;
  readonly plannedChapters: number;
  readonly writtenChapters: number;
  readonly targetChapters: number;
  readonly weaveReady: boolean;
}

function isPersonEntry(entry: AuthoringCatalogEntry): boolean {
  const path = entry.file.replace(/\\/g, "/").replace(/^story\//, "");
  if (roleFromPath(path)) return true;
  // Catalog categories are author/model supplied. A relationship chart is
  // a setting entry, not one person, even when its category mentions people.
  const category = entry.category.trim();
  if (/关系|關係|relationships?|relations?\b/i.test(category)) return false;
  return /人物|角色|主角|配角|\b(characters?|people|cast)\b/i.test(category);
}

function studyGroundCopy(input: FourStepCopyInput, isZh: boolean): string {
  const workspace = input.authoring;
  const entries = workspace?.catalog?.entries ?? [];
  if (workspace?.authoringBook || entries.length) {
    const visible = entries.filter((entry) => !entry.archived);
    const adopted = visible.filter((entry) => Boolean(entry.adoptedArtifactId));
    const people = adopted.filter(isPersonEntry).length;
    const progress = `${adopted.length}/${visible.length}`;
    if (!visible.length) return isZh ? "尚未拟定设定目录" : "No settings catalog yet";
    if (!adopted.length) {
      return isZh
        ? `设定尚未采用 ${progress} · 0 位已采用人物`
        : `No settings adopted ${progress} · 0 adopted people`;
    }
    const allAdopted = adopted.length === visible.length;
    return isZh
      ? `${allAdopted ? "设定全部采用" : "设定部分采用"} ${progress} · ${people} 位已采用人物`
      : `${allAdopted ? "All settings adopted" : "Settings partly adopted"} ${progress} · ${people} adopted people`;
  }
  return input.grounded
    ? (isZh ? `设定已定稿 · ${input.roleCount} 位人物` : `Grounded · ${input.roleCount} people`)
    : (isZh ? `设定未定稿 · ${input.roleCount} 位人物` : `Not grounded · ${input.roleCount} people`);
}

export function fourStepCopy(
  input: FourStepCopyInput,
  isZh: boolean,
): { ask: string; ground: string; weave: string; write: string } {
  const ask = input.askDone
    ? (isZh ? "故事正典已完成" : "Canon settled")
    : (isZh ? "故事正典未完成" : "Canon not settled");
  const ground = studyGroundCopy(input, isZh);
  const planned = input.targetChapters > 0
    ? `${input.plannedChapters}/${input.targetChapters}`
    : String(input.plannedChapters);
  const weave = !input.weaveReady
    ? "—"
    : isZh
      ? `已锁 ${input.lockedVolumes} 卷 · ${input.outlineDone ? "细纲已完成" : "细纲未完成"} · 章节规划 ${planned}`
      : `${input.lockedVolumes} vol locked · Outline ${input.outlineDone ? "done" : "not done"} · ${planned} planned`;
  const written = input.targetChapters > 0
    ? `${input.writtenChapters}/${input.targetChapters}`
    : String(input.writtenChapters);
  const write = isZh ? `已写 ${written} 章` : `${written} chapters`;
  return { ask, ground, weave, write };
}

export function formatStudyWords(total: number, isZh: boolean): string {
  if (!isZh) return `${total.toLocaleString()} words`;
  if (total >= 10000) {
    const wan = total / 10000;
    const label = Number.isInteger(wan) ? String(wan) : wan.toFixed(1).replace(/\.0$/, "");
    return `${label} 万字`;
  }
  return `${total.toLocaleString()} 字`;
}
