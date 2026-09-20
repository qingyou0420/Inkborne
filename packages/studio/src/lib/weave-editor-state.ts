/** SPDX-License-Identifier: AGPL-3.0-only */
import { applyVolumeMapNodeEdit, findNodeById, insertChapterStub, parseVolumeMapTree } from "./volume-map-tree";

export interface WeaveChapterRange {
  readonly startChapter: number;
  readonly endChapter: number;
}

/** Generation and review-based revision start with the volume the author is reading. */
export function resolveWeaveVolumeRange(
  volumes: readonly WeaveChapterRange[],
  preferred: WeaveChapterRange | null | undefined,
  target: number,
): WeaveChapterRange {
  const selected = preferred
    ? volumes.find((volume) => volume.startChapter === preferred.startChapter && volume.endChapter === preferred.endChapter)
      ?? volumes.find((volume) => preferred.startChapter >= volume.startChapter && preferred.startChapter <= volume.endChapter)
    : undefined;
  return selected ?? volumes[0] ?? { startChapter: 1, endChapter: target || 36 };
}

/** One writer for all adopted-outline mutations; transforms see the last saved map. */
export interface OutlineMapState { current: string; pending: boolean }
export async function saveOutlineMap(
  state: OutlineMapState,
  transform: (current: string) => string,
  persist: (next: string) => Promise<void>,
): Promise<boolean> {
  if (state.pending) return false;
  state.pending = true;
  try {
    const next = transform(state.current);
    if (next !== state.current) {
      await persist(next);
      state.current = next;
    }
    return true;
  } finally {
    state.pending = false;
  }
}

export interface WeaveSegment {
  readonly nodeId: string;
  readonly kind: "volume" | "chapter" | "range" | "note";
  readonly title: string;
  readonly summary: string;
}

export function readWeaveSegment(markdown: string, nodeId: string): WeaveSegment | null {
  const node = findNodeById(parseVolumeMapTree(markdown), nodeId);
  if (!node) return null;
  if (node.kind === "volume") {
    return { nodeId: node.id, kind: "volume", title: node.title, summary: node.body || node.okr };
  }
  if (node.kind === "note") {
    return { nodeId: node.id, kind: "note", title: node.title, summary: node.body };
  }
  return { nodeId: node.id, kind: node.kind, title: node.title, summary: node.summary };
}

/** Replace one volume/chapter/note block and keep leading notes and other sections verbatim. */
export function replaceWeaveSegment(
  markdown: string,
  nodeId: string,
  next: { readonly title?: string; readonly summary?: string },
): string {
  return applyVolumeMapNodeEdit(markdown, nodeId, next);
}

export function appendUnplannedChapter(markdown: string, nextWrittenChapter: number) {
  const tree = parseVolumeMapTree(markdown);
  const chapters = [...tree.orphanChapters, ...tree.volumes.flatMap((volume) => volume.chapters)];
  // nextWrittenChapter is the next *prose* chapter, often already present in the outline.
  const chapterNumber = Math.max(nextWrittenChapter, 1, ...chapters.map((chapter) => (chapter.endChapter ?? chapter.chapterNumber) + 1));
  return { content: insertChapterStub(markdown, chapterNumber), chapterNumber };
}

/** Poll only after the previous request settles; disposal also ignores late responses. */
export function pollWeaveRun<T extends { status: string }>(options: {
  read: () => Promise<T>;
  update: (run: T) => void;
  error: (error: unknown) => void;
  settled: () => Promise<void>;
  delay?: number;
  keepPollingOnError?: (error: unknown, consecutiveErrors: number) => boolean;
}): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveErrors = 0;
  const tick = async () => {
    let keepPolling = true;
    try {
      const run = await options.read();
      if (cancelled) return;
      consecutiveErrors = 0;
      options.update(run);
      keepPolling = run.status === "running" || run.status === "pausing";
      if (!keepPolling) await options.settled();
    } catch (error) {
      consecutiveErrors += 1;
      if (!cancelled) options.error(error);
      keepPolling = options.keepPollingOnError?.(error, consecutiveErrors) ?? true;
    } finally {
      if (!cancelled && keepPolling) timer = setTimeout(() => void tick(), options.delay ?? 1000);
    }
  };
  void tick();
  return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
}
