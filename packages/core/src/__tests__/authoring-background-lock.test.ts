import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import { createLightweightBook } from "../authoring/book-create.js";
import { withBackgroundBookWrite, withBookWriteLock } from "../authoring/book-lock.js";
import { generateAskCanon } from "../authoring/stages/ask.js";
import { AuthoringRunCancelledError, loadManifest, saveManifest } from "../authoring/store.js";
import { BookWriteLockError, StateManager, resetProcessBookLocksForTest } from "../state/manager.js";
import type { AuthoringLlmFn } from "../authoring/types.js";

const canonJson = JSON.stringify({
  title: "夜港账本",
  oneLine: "会计找回账本",
  proposition: "记忆有代价",
  protagonist: "沈砚",
  conflict: "救人还是自保",
  voice: "限制视角",
  boundaries: "开放结局",
  direction: "港口",
  openQuestions: [],
  targetChapters: 12,
  chapterWordCount: 2000,
});

function project() {
  return ProjectConfigSchema.parse({
    name: "lock-test",
    version: "0.1.0",
    llm: {
      provider: "custom",
      model: "ask-main",
      baseUrl: "https://unused.invalid/v1",
      apiKey: "stub",
    },
    authoringRoles: {
      "ask.main": { modelId: "ask-main" },
    },
  });
}

function settledFlag(promise: Promise<unknown>): () => boolean {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  return () => done;
}

describe("background authoring writes share the book lock", () => {
  let projectRoot = "";
  const releases: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const release of releases) await release().catch(() => undefined);
    releases.length = 0;
    resetProcessBookLocksForTest();
    vi.restoreAllMocks();
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
    projectRoot = "";
  });

  async function book() {
    projectRoot = await mkdtemp(join(tmpdir(), "authoring-bg-lock-"));
    const created = await createLightweightBook({
      projectRoot,
      canon: {
        title: "夜港账本",
        genre: "现实",
        oneLine: "会计找回账本",
        proposition: "记忆有代价",
        protagonist: "沈砚",
        conflict: "救人还是自保",
        voice: "限制视角",
        boundaries: "开放结局",
        direction: "港口",
        openQuestions: [],
        targetChapters: 12,
        chapterWordCount: 2000,
      },
    });
    const root = { projectRoot, bookId: created.bookId };
    return { root, bookId: created.bookId };
  }

  async function hold(bookId: string) {
    const release = await new StateManager(projectRoot).acquireBookLock(bookId, {
      stage: "采用正文",
      taskId: "adopt-holds",
    }, { waitMs: 0 });
    releases.push(release);
    return release;
  }

  it("fails a foreground write immediately and retries a background write until the lock frees", async () => {
    const { root, bookId } = await book();
    const acquire = vi.spyOn(StateManager.prototype, "acquireBookLock");
    await hold(bookId);
    const heldAttempts = acquire.mock.calls.length;
    await expect(withBookWriteLock(root, "落笔", async () => "foreground")).rejects.toBeInstanceOf(BookWriteLockError);
    const foregroundAttempts = acquire.mock.calls.length;
    expect(foregroundAttempts).toBe(heldAttempts + 1);

    let entered = 0;
    const pending = withBackgroundBookWrite(root, "问心候选", async () => {
      entered += 1;
      return "saved";
    }, { maxAttempts: 6, delayMs: 15 });
    const done = settledFlag(pending);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(done()).toBe(false);
    expect(entered).toBe(0);
    expect(acquire.mock.calls.length).toBeGreaterThan(foregroundAttempts + 1);

    await releases.shift()!();
    await expect(pending).resolves.toBe("saved");
    expect(entered).toBe(1);
  });

  it("stops retrying when the run is cancelled and does not write", async () => {
    const { root, bookId } = await book();
    await hold(bookId);
    const controller = new AbortController();
    let entered = 0;
    const pending = withBackgroundBookWrite(root, "研墨候选", async () => {
      entered += 1;
      return "saved";
    }, { signal: controller.signal, maxAttempts: 20, delayMs: 30 });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(AuthoringRunCancelledError);
    expect(entered).toBe(0);
  });

  it("gives up with the lock error after the attempt limit", async () => {
    const { root, bookId } = await book();
    await hold(bookId);
    await expect(withBackgroundBookWrite(root, "影响审查", async () => "saved", {
      maxAttempts: 2,
      delayMs: 5,
    })).rejects.toBeInstanceOf(BookWriteLockError);
  });

  it("keeps an adopted chapter when a background ask persist lands afterwards", async () => {
    const { root, bookId } = await book();
    const before = await loadManifest(root);
    await hold(bookId);
    let modelReturned = false;
    const llm: AuthoringLlmFn = async () => {
      modelReturned = true;
      return canonJson;
    };
    const pending = generateAskCanon({
      root,
      project: project(),
      conversation: "港口会计找回账本",
      llm,
    });
    const done = settledFlag(pending);
    await vi.waitFor(() => expect(modelReturned).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(done()).toBe(false);

    await saveManifest(root, {
      ...before,
      adopted: { ...before.adopted, write: { ...before.adopted.write, "1": "write-adopted-1" } },
      coverage: { ...before.coverage, chaptersWrittenAdopted: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(done()).toBe(false);

    await releases.shift()!();
    const generated = await pending;
    const latest = await loadManifest(root);
    expect(latest.adopted.write["1"]).toBe("write-adopted-1");
    expect(latest.coverage.chaptersWrittenAdopted).toBe(1);
    expect(latest.adopted.ask).toBe(before.adopted.ask);
    expect(latest.candidates.ask).toBe(generated.artifactId);
    expect(latest.candidates.ask).not.toBe(before.candidates.ask);
  });
});
