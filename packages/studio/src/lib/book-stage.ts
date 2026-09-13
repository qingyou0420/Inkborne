/**
 * Four-step book stage from file facts. Workflow timestamps are runtime-only.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type BookStageId = "ask" | "ground" | "weave" | "write";
export type BookStepState = "done" | "current" | "todo" | "blocked";

export interface BookWorkflowJson {
  readonly askConfirmedAt?: string;
  readonly groundConfirmedAt?: string;
  readonly weaveLockedAt?: string;
  readonly lastStage?: BookStageId;
}

export interface BookStageFacts {
  readonly bookExists: boolean;
  readonly authorIntentNonEmpty: boolean;
  readonly storyCardExists: boolean;
  readonly canonExists?: boolean;
  readonly settingsAdoptedCount?: number;
  readonly storyFrameNonEmpty: boolean;
  readonly storyFrameFourSectionsNonEmpty: boolean;
  readonly majorRoleCount: number;
  readonly weaveLocked: boolean;
  readonly nextChapterHasOutline: boolean;
  readonly chaptersWritten: number;
  readonly bookStatus?: string;
  readonly askConfirmedAt?: string;
  readonly groundConfirmedAt?: string;
  readonly weaveLockedAt?: string;
}

export interface BookStageSnapshot {
  readonly stage: BookStageId;
  readonly steps: Record<BookStageId, BookStepState>;
}

export interface BookStageView extends BookStageSnapshot {
  readonly workflow?: BookWorkflowJson;
}

const STAGE_ORDER: ReadonlyArray<BookStageId> = ["ask", "ground", "weave", "write"];

const FRAME_SECTION_GROUPS: ReadonlyArray<RegExp> = [
  /世界|铁律|规则|world|tonal|rule/i,
  /主题|基调|人物|角色|theme|tone|character/i,
  /冲突|主线|因果|conflict/i,
  /终局|结局|伏笔|endgame|ending/i,
];

export function parseBookWorkflow(raw: unknown): BookWorkflowJson {
  if (!raw || typeof raw !== "object") return {};
  const body = raw as Record<string, unknown>;
  const lastStage = body.lastStage;
  return {
    askConfirmedAt: typeof body.askConfirmedAt === "string" ? body.askConfirmedAt : undefined,
    groundConfirmedAt: typeof body.groundConfirmedAt === "string" ? body.groundConfirmedAt : undefined,
    weaveLockedAt: typeof body.weaveLockedAt === "string" ? body.weaveLockedAt : undefined,
    lastStage: lastStage === "ask" || lastStage === "ground" || lastStage === "weave" || lastStage === "write"
      ? lastStage
      : undefined,
  };
}

export function stripYamlFrontmatter(markdown: string): string {
  const trimmed = markdown.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) return trimmed;
  const close = trimmed.indexOf("\n---", 3);
  if (close < 0) return trimmed;
  return trimmed.slice(close + 4).replace(/^\s*\n/, "");
}

export function storyFrameHasFourSections(markdown: string): boolean {
  const body = stripYamlFrontmatter(markdown);
  const sections = splitMarkdownSections(body).filter((section) => section.body.trim().length > 0);
  if (sections.length >= 4) return true;
  return FRAME_SECTION_GROUPS.every((pattern) =>
    sections.some((section) => pattern.test(section.heading)),
  );
}

export function splitMarkdownSections(markdown: string): ReadonlyArray<{ heading: string; body: string }> {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: Array<{ heading: string; body: string }> = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    if (!heading && buf.every((line) => !line.trim())) return;
    sections.push({ heading, body: buf.join("\n") });
    buf = [];
  };
  for (const line of lines) {
    const match = /^(#{1,3})\s+(.+)$/.exec(line);
    if (match) {
      flush();
      heading = match[2]!.trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

export function inferAskDone(facts: BookStageFacts): boolean {
  if (facts.askConfirmedAt) return true;
  if (facts.canonExists) return true;
  if (facts.authorIntentNonEmpty && facts.storyCardExists) return true;
  return facts.storyFrameNonEmpty || facts.weaveLocked || facts.chaptersWritten > 0;
}

export function inferGroundDone(facts: BookStageFacts): boolean {
  if ((facts.settingsAdoptedCount ?? 0) >= 1) return true;
  if (facts.groundConfirmedAt && (facts.storyFrameNonEmpty || facts.majorRoleCount >= 1)) return true;
  return facts.storyFrameFourSectionsNonEmpty && facts.majorRoleCount >= 1 && Boolean(facts.groundConfirmedAt);
}

export function inferWeaveDone(facts: BookStageFacts): boolean {
  if (facts.bookStatus === "completed") return true;
  return facts.weaveLocked && facts.nextChapterHasOutline;
}

export function deriveBookStage(facts: BookStageFacts): BookStageSnapshot {
  if (!facts.bookExists) {
    return {
      stage: "ask",
      steps: { ask: "current", ground: "todo", weave: "todo", write: "todo" },
    };
  }

  const laterThanAsk = facts.storyFrameNonEmpty || facts.weaveLocked || facts.chaptersWritten > 0 || Boolean(facts.groundConfirmedAt);
  const laterThanGround = facts.weaveLocked || facts.chaptersWritten > 0;
  const askDone = inferAskDone(facts) || laterThanAsk;
  const groundDone = inferGroundDone(facts) || laterThanGround;
  const weaveDone = inferWeaveDone(facts) || facts.chaptersWritten > 0;

  let stage: BookStageId = "write";
  if (facts.bookStatus === "completed") {
    stage = "write";
  } else if (!askDone) {
    stage = "ask";
  } else if (!groundDone) {
    stage = "ground";
  } else if (!weaveDone) {
    stage = "weave";
  }

  const currentIndex = STAGE_ORDER.indexOf(stage);
  const steps = {
    ask: stepState(0, currentIndex, askDone || currentIndex > 0),
    ground: stepState(1, currentIndex, groundDone || currentIndex > 1),
    weave: stepState(2, currentIndex, weaveDone || currentIndex > 2),
    write: stepState(3, currentIndex, facts.bookStatus === "completed"),
  };

  return { stage, steps };
}

function stepState(index: number, currentIndex: number, done: boolean): BookStepState {
  if (index === currentIndex) return done && index === 3 ? "done" : "current";
  if (index < currentIndex || done) return "done";
  return "todo";
}

export function migrateWorkflowFromFacts(
  existing: BookWorkflowJson | null,
  facts: Omit<BookStageFacts, "askConfirmedAt" | "groundConfirmedAt" | "weaveLockedAt">,
  nowIso: string,
): { readonly workflow: BookWorkflowJson; readonly wrote: boolean } {
  if (existing) {
    const snapshot = deriveBookStage({
      ...facts,
      askConfirmedAt: existing.askConfirmedAt,
      groundConfirmedAt: existing.groundConfirmedAt,
      weaveLockedAt: existing.weaveLockedAt,
    });
    if (existing.lastStage === snapshot.stage) {
      return { workflow: existing, wrote: false };
    }
    return { workflow: { ...existing, lastStage: snapshot.stage }, wrote: true };
  }

  const askConfirmedAt = facts.authorIntentNonEmpty || facts.storyFrameNonEmpty || facts.weaveLocked || facts.chaptersWritten > 0
    ? nowIso
    : undefined;
  const groundConfirmedAt = facts.storyFrameNonEmpty ? nowIso : undefined;
  const weaveLockedAt = facts.weaveLocked ? nowIso : undefined;
  const snapshot = deriveBookStage({
    ...facts,
    askConfirmedAt,
    groundConfirmedAt,
    weaveLockedAt,
  });
  return {
    workflow: {
      askConfirmedAt,
      groundConfirmedAt,
      weaveLockedAt,
      lastStage: snapshot.stage,
    },
    wrote: true,
  };
}
