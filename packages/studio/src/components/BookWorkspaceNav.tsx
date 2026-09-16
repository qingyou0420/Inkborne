/**
 * One compact book context and four-stage navigation.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Maximize2 } from "lucide-react";
import { useApi } from "../hooks/use-api";
import { useBookStage } from "../hooks/use-book-stage";
import type { TFunction } from "../hooks/use-i18n";
import type { BookStageId, BookStepState } from "../lib/book-stage";
import { StageDot, stageStateLabel } from "./StageDot";

export type BookWorkspaceTab = "study" | "ask" | "ground" | "weave" | "write" | "cockpit" | "outline" | "chat" | "manuscript";
export interface BookWorkspaceNavTarget {
  readonly toBook: (bookId: string) => void;
  readonly toOutline: (bookId: string) => void;
  readonly toBookSettings: (bookId: string) => void;
  readonly toAsk: (bookId: string) => void;
  readonly toGround?: (bookId: string) => void;
  readonly toWeave?: (bookId: string) => void;
  readonly toWrite?: (bookId: string) => void;
  readonly toTruth?: (bookId: string) => void;
  readonly toAnalytics?: (bookId: string) => void;
  readonly toDashboard?: () => void;
}
const STEPS: ReadonlyArray<{ id: BookStageId; zh: string; en: string }> = [
  { id: "ask", zh: "问心", en: "Ask" },
  { id: "ground", zh: "研墨", en: "Ground" },
  { id: "weave", zh: "织卷", en: "Weave" },
  { id: "write", zh: "落笔", en: "Write" },
];
export function normalizeBookWorkspaceTab(active: BookWorkspaceTab): BookStageId | "study" {
  if (active === "cockpit" || active === "study") return "study";
  if (active === "chat") return "ask";
  if (active === "outline") return "weave";
  if (active === "manuscript") return "write";
  return active;
}
export function BookWorkspaceNav({ bookId, active, nav, isZh, stage, onFocusMode }: {
  readonly bookId: string;
  readonly active: BookWorkspaceTab;
  readonly nav: BookWorkspaceNavTarget;
  readonly isZh: boolean;
  readonly stage?: { readonly steps: Record<BookStageId, BookStepState> } | null;
  readonly t?: TFunction;
  readonly onFocusMode?: () => void;
}) {
  const current = normalizeBookWorkspaceTab(active);
  const fetched = useBookStage(stage ? undefined : bookId);
  const loaded = stage ?? fetched;
  const { data: bookData } = useApi<{ book?: { title?: string } }>(`/books/${encodeURIComponent(bookId)}`);
  const title = bookData?.book?.title?.trim() || bookId;
  const goStep = (id: BookStageId) => {
    if (id === "ask") nav.toAsk(bookId);
    else if (id === "ground") (nav.toGround ?? nav.toTruth ?? nav.toBook)(bookId);
    else if (id === "weave") (nav.toWeave ?? nav.toOutline)(bookId);
    else (nav.toWrite ?? nav.toBookSettings)(bookId);
  };
  return (
    <nav className="book-chrome ink-book-nav" data-testid="book-workspace-nav" aria-label={isZh ? "作品与创作阶段" : "Work and stages"}>
      <span className="ink-book-context" title={title}>{title}</span>
      <ol className="ink-stage-strip" data-testid="book-stage-strip">
        {STEPS.map((step) => {
          const state = loaded?.steps[step.id];
          const label = isZh ? step.zh : step.en;
          const hint = state ? `${label} · ${stageStateLabel(state, isZh, step.id === "write")}` : label;
          return <li key={step.id}>
            <button type="button" data-testid={`book-step-${step.id}`} data-state={state ?? "todo"} title={hint}
              aria-label={hint} aria-current={current === step.id ? "page" : undefined}
              onClick={() => goStep(step.id)} className="ink-stage-link">
              <span className="ink-calligraphy">{label}</span>
              {state ? <StageDot state={state} /> : null}
            </button>
          </li>;
        })}
      </ol>
      {current === "write" && onFocusMode ? <button type="button" className="icon-btn ink-focus-entry" onClick={onFocusMode} aria-label={isZh ? "专注写作" : "Focus writing"} title={isZh ? "专注写作" : "Focus writing"}><Maximize2 size={16} /></button> : null}
    </nav>
  );
}
