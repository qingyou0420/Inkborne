/**
 * Book chrome: 书房 + 问心 · 研墨 · 织卷 · 落笔 + ⋯
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { useBookStage } from "../hooks/use-book-stage";
import type { TFunction } from "../hooks/use-i18n";
import type { BookStageId, BookStepState } from "../lib/book-stage";
import { useChatStore } from "../store/chat";
import { BookSettingsDrawer } from "./BookSettingsDrawer";
import { BookToolsDrawer } from "./BookToolsDrawer";
import { StageDot, stageStateLabel } from "./StageDot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export type BookWorkspaceTab =
  | "study"
  | "ask"
  | "ground"
  | "weave"
  | "write"
  | "cockpit"
  | "outline"
  | "chat"
  | "manuscript";

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

function currentPageClass(active: boolean): string {
  return active
    ? "is-current-page bg-primary text-primary-foreground"
    : "text-muted-foreground hover:bg-accent hover:text-foreground";
}

export function BookWorkspaceNav({
  bookId,
  active,
  nav,
  isZh,
  stage,
  t,
}: {
  readonly bookId: string;
  readonly active: BookWorkspaceTab;
  readonly nav: BookWorkspaceNavTarget;
  readonly isZh: boolean;
  readonly stage?: { readonly steps: Record<BookStageId, BookStepState> } | null;
  readonly t?: TFunction;
}) {
  const current = normalizeBookWorkspaceTab(active);
  const fetched = useBookStage(stage ? undefined : bookId);
  const loaded = stage ?? fetched;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const bumpBookDataVersion = useChatStore((state) => state.bumpBookDataVersion);
  const copy = t ?? ((key: string) => key);

  const goAsk = () => nav.toAsk(bookId);
  const goGround = () => (nav.toGround ?? nav.toTruth ?? nav.toBook)(bookId);
  const goWeave = () => (nav.toWeave ?? nav.toOutline)(bookId);
  const goWrite = () => (nav.toWrite ?? nav.toBookSettings)(bookId);
  const goStep = (id: BookStageId) => {
    if (id === "ask") goAsk();
    else if (id === "ground") goGround();
    else if (id === "weave") goWeave();
    else goWrite();
  };

  return (
    <nav className="flex w-full items-center justify-between gap-3" data-testid="book-workspace-nav">
      <button
        type="button"
        data-testid="book-tab-study"
        onClick={() => nav.toBook(bookId)}
        className={`inline-flex h-8 items-center rounded-lg px-3 text-[14px] font-medium transition-colors ${currentPageClass(current === "study")}`}
      >
        {isZh ? "书房" : "Study"}
      </button>

      <div className="flex items-center gap-1">
        <ol className="flex items-center gap-1" data-testid="book-stage-strip">
          {STEPS.map((step, index) => {
            const state = loaded?.steps[step.id];
            const highlighted = current === step.id;
            const label = isZh ? step.zh : step.en;
            const hint = state
              ? `${label} · ${stageStateLabel(state, isZh, step.id === "write")}`
              : label;
            return (
              <li key={step.id} className="flex items-center gap-1">
                {index > 0 && <span className="h-px w-4 bg-border" aria-hidden="true" />}
                <button
                  type="button"
                  data-testid={`book-step-${step.id}`}
                  data-state={state ?? "todo"}
                  title={hint}
                  onClick={() => goStep(step.id)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[14px] font-medium transition-colors ${currentPageClass(highlighted)}`}
                >
                  {state ? <StageDot state={state} /> : null}
                  {label}
                </button>
              </li>
            );
          })}
        </ol>

        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="book-tab-more"
            className="btn-ghost"
          >
            <MoreHorizontal size={14} />
            <span className="sr-only">{isZh ? "更多" : "More"}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
              {isZh ? "书籍设置" : "Book settings"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setToolsOpen(true)}>
              {isZh ? "更多工具" : "More tools"}
            </DropdownMenuItem>
            {nav.toTruth && (
              <DropdownMenuItem onClick={() => nav.toTruth?.(bookId)}>
                {isZh ? "设定档案" : "Story files"}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <BookSettingsDrawer
        bookId={bookId}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        t={copy}
        isZh={isZh}
        onDeleted={() => {
          bumpBookDataVersion();
          setSettingsOpen(false);
          if (nav.toDashboard) nav.toDashboard();
          else nav.toBook(bookId);
        }}
      />
      <BookToolsDrawer
        bookId={bookId}
        open={toolsOpen}
        onClose={() => setToolsOpen(false)}
        t={copy}
        isZh={isZh}
        onOpenAnalytics={() => nav.toAnalytics?.(bookId)}
      />
    </nav>
  );
}
