/**
 * Chapter table grouped by volume, with search and a windowed list for long books.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from "react";
import { ChevronDown } from "lucide-react";
import { parseVolumeMapTree } from "../lib/volume-map-tree";
import {
  CHAPTER_TABLE_VIRTUAL_THRESHOLD,
  buildChapterGroups,
  defaultOpenGroupId,
  filterChapterGroups,
} from "../lib/chapter-table";
import type { TFunction } from "../hooks/use-i18n";

const ROW_HEIGHT = 48;
const OVERSCAN = 6;

interface ChapterRow {
  readonly number: number;
  readonly title: string;
}

type FlatRow<T> =
  | { readonly kind: "header"; readonly id: string; readonly title: string; readonly count: number; readonly open: boolean }
  | { readonly kind: "chapter"; readonly chapter: T };

export function ChapterManuscriptTable<T extends ChapterRow>({
  chapters,
  nextChapter,
  volumeMap,
  isZh,
  t,
  renderChapter,
}: {
  readonly chapters: readonly T[];
  readonly nextChapter: number;
  readonly volumeMap: string;
  readonly isZh: boolean;
  readonly t: TFunction;
  readonly renderChapter: (chapter: T) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<ReadonlySet<string> | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(640);
  const tree = useMemo(() => (volumeMap.trim() ? parseVolumeMapTree(volumeMap) : null), [volumeMap]);
  const groups = useMemo(
    () => filterChapterGroups(buildChapterGroups(chapters, tree, isZh), query),
    [chapters, isZh, query, tree],
  );
  const searching = query.trim().length > 0;
  const focusChapter = nextChapter > 0 ? nextChapter : chapters[chapters.length - 1]?.number ?? 1;
  const defaultId = defaultOpenGroupId(groups, focusChapter);
  const openIds = searching
    ? new Set(groups.map((group) => group.id))
    : opened ?? new Set(defaultId ? [defaultId] : []);
  const rows: Array<FlatRow<T>> = [];
  for (const group of groups) {
    const open = openIds.has(group.id);
    rows.push({ kind: "header", id: group.id, title: group.title, count: group.chapters.length, open });
    if (open) {
      for (const chapter of group.chapters) rows.push({ kind: "chapter", chapter });
    }
  }
  const virtual = chapters.length > CHAPTER_TABLE_VIRTUAL_THRESHOLD;
  const start = virtual ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const visibleCount = virtual ? Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN * 2 : rows.length;
  const visible = rows.slice(start, start + visibleCount);
  const topPad = virtual ? start * ROW_HEIGHT : 0;
  const bottomPad = virtual ? Math.max(0, (rows.length - start - visible.length) * ROW_HEIGHT) : 0;

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node || !virtual) return undefined;
    const observer = new ResizeObserver(() => setViewport(node.clientHeight || 640));
    observer.observe(node);
    setViewport(node.clientHeight || 640);
    return () => observer.disconnect();
  }, [virtual]);

  const toggle = (id: string) => {
    const base = opened ?? new Set(defaultId ? [defaultId] : []);
    const next = new Set(base);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpened(next);
  };

  return (
    <div data-testid="chapter-manuscript-table">
      <div className="border-b border-border px-4 py-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={isZh ? "搜索章号或标题" : "Search chapter number or title"}
          aria-label={isZh ? "搜索章号或标题" : "Search chapter number or title"}
          data-testid="chapter-table-search"
          className="w-full max-w-sm rounded-[10px] border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
      <div
        ref={scrollerRef}
        className={virtual ? "max-h-[70vh] overflow-auto" : "overflow-x-auto"}
        onScroll={virtual ? (event: UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop) : undefined}
      >
        <table className="w-full text-[15px] leading-[26px] border-collapse">
          {chapters.length > 0 && (
            <thead>
              <tr className="bg-muted/30 border-b border-border">
                <th className="text-left px-4 py-3 font-medium text-[13px] leading-5 text-muted-foreground w-16">#</th>
                <th className="text-left px-4 py-3 font-medium text-[13px] leading-5 text-muted-foreground">{t("book.manuscriptTitle")}</th>
                <th className="text-left px-4 py-3 font-medium text-[13px] leading-5 text-muted-foreground w-28">{t("book.words")}</th>
                <th className="text-left px-4 py-3 font-medium text-[13px] leading-5 text-muted-foreground w-36">{t("book.status")}</th>
                <th className="text-right px-4 py-3 font-medium text-[13px] leading-5 text-muted-foreground w-32">{t("book.curate")}</th>
              </tr>
            </thead>
          )}
          <tbody className="divide-y divide-border/30">
            {topPad > 0 && (
              <tr aria-hidden>
                <td colSpan={5} style={{ height: topPad, padding: 0, border: 0 }} />
              </tr>
            )}
            {visible.map((row) => row.kind === "header" ? (
              <tr key={`volume-${row.id}`} className="bg-muted/20" data-testid={`chapter-volume-${row.id}`}>
                <td colSpan={5} className="px-4 py-2">
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 text-sm font-medium"
                    aria-expanded={row.open}
                    onClick={() => toggle(row.id)}
                  >
                    <ChevronDown size={16} className={row.open ? "" : "-rotate-90"} />
                    {row.title}
                    <span className="text-muted-foreground">{isZh ? `${row.count} 章` : `${row.count}`}</span>
                  </button>
                </td>
              </tr>
            ) : renderChapter(row.chapter))}
            {bottomPad > 0 && (
              <tr aria-hidden>
                <td colSpan={5} style={{ height: bottomPad, padding: 0, border: 0 }} />
              </tr>
            )}
            {groups.length === 0 && chapters.length > 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-sm text-muted-foreground">
                  {isZh ? "没有匹配的章节" : "No matching chapters"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
