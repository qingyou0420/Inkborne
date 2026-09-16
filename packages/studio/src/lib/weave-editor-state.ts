/** SPDX-License-Identifier: AGPL-3.0-only */
import { insertChapterStub, parseVolumeMapTree } from "./volume-map-tree";

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
}): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    let keepPolling = true;
    try {
      const run = await options.read();
      if (cancelled) return;
      options.update(run);
      keepPolling = run.status === "running" || run.status === "pausing";
      if (!keepPolling) await options.settled();
    } catch (error) {
      if (!cancelled) options.error(error);
    } finally {
      if (!cancelled && keepPolling) timer = setTimeout(() => void tick(), options.delay ?? 1000);
    }
  };
  void tick();
  return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
}
