import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectConfigSchema } from "../models/project.js";
import { createLightweightBook } from "../authoring/book-create.js";
import {
  BACKGROUND_LOCK_ATTEMPTS,
  BACKGROUND_SAVE_DEFERRED,
  BackgroundSaveDeferredError,
  BookWriteLockNotHeldError,
  bookWriteLockHeld,
  withBackgroundBookWrite,
  withBookWriteLock,
} from "../authoring/book-lock.js";
import { generateAskCanon } from "../authoring/stages/ask.js";
import { closeImpactItems, closeImpactItemsAfterAdopt } from "../authoring/stages/impact.js";
import { generateWeaveStructure } from "../authoring/stages/weave.js";
import { AuthoringRunCancelledError, listArtifacts, loadManifest, saveImpactReport, saveManifest } from "../authoring/store.js";
import { BookWriteLockError, StateManager, isBookWriteLockError, isBookWriteLockMessage, resetProcessBookLocksForTest } from "../state/manager.js";
import { redactSecrets } from "../utils/redact-secrets.js";
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

function lockFsError(code: "EPERM" | "EACCES" | "EBUSY"): NodeJS.ErrnoException {
  const error = new Error(`${code}: operation not permitted, open`) as NodeJS.ErrnoException;
  error.code = code;
  error.syscall = "open";
  return error;
}

/** Private lock helpers stay on the prototype; tests reach them without exporting. */
function bookLockInternals(): {
  createLockFile(this: StateManager, lockPath: string, metadata: object): Promise<void>;
  unlinkWithRetry(this: StateManager, lockPath: string): Promise<void>;
} {
  return StateManager.prototype as unknown as {
    createLockFile(this: StateManager, lockPath: string, metadata: object): Promise<void>;
    unlinkWithRetry(this: StateManager, lockPath: string): Promise<void>;
  };
}

function settledFlag(promise: Promise<unknown>): () => boolean {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  return () => done;
}

/**
 * Retry budget for cases that must still be in-flight when the assertion runs.
 * 200 × 15ms stays far longer than the wait below, so a fast CI cannot exhaust it first.
 */
const RETRY_WHILE_HELD = { maxAttempts: 200, delayMs: 15 } as const;

async function waitForMoreLockAttempts(
  acquire: { mock: { calls: readonly unknown[] } },
  baseline: number,
): Promise<void> {
  await vi.waitFor(() => {
    expect(acquire.mock.calls.length).toBeGreaterThan(baseline);
  }, { timeout: 2_000, interval: 10 });
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

  async function hold(bookId: string, stage = "采用正文") {
    const release = await new StateManager(projectRoot).acquireBookLock(bookId, {
      stage,
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
    }, RETRY_WHILE_HELD);
    const done = settledFlag(pending);
    await waitForMoreLockAttempts(acquire, foregroundAttempts + 1);
    expect(done()).toBe(false);
    expect(entered).toBe(0);
    expect(acquire.mock.calls.length).toBeGreaterThan(foregroundAttempts + 1);

    await releases.shift()!();
    await expect(pending).resolves.toBe("saved");
    expect(entered).toBe(1);
  });

  it("stops retrying when the run is cancelled and does not write", async () => {
    const { root, bookId } = await book();
    const acquire = vi.spyOn(StateManager.prototype, "acquireBookLock");
    await hold(bookId);
    const heldAttempts = acquire.mock.calls.length;
    const controller = new AbortController();
    let entered = 0;
    const pending = withBackgroundBookWrite(root, "研墨候选", async () => {
      entered += 1;
      return "saved";
    }, { ...RETRY_WHILE_HELD, signal: controller.signal });
    await waitForMoreLockAttempts(acquire, heldAttempts);
    expect(entered).toBe(0);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AuthoringRunCancelledError);
    expect(entered).toBe(0);
  });

  it("gives up with the lock error after the attempt limit", async () => {
    const { root, bookId } = await book();
    await hold(bookId, "采用正典");
    await expect(withBackgroundBookWrite(root, "影响审查", async () => "saved", {
      maxAttempts: 2,
      delayMs: 5,
    })).rejects.toBeInstanceOf(BookWriteLockError);
  });

  it("keeps waiting while 落笔 holds the lock past the old five-second budget", async () => {
    const { root, bookId } = await book();
    const acquire = vi.spyOn(StateManager.prototype, "acquireBookLock");
    await hold(bookId, "落笔");
    const heldAttempts = acquire.mock.calls.length;
    let entered = 0;
    const pending = withBackgroundBookWrite(root, "问心候选", async () => {
      entered += 1;
      return "saved";
    }, { delayMs: 5 });
    const done = settledFlag(pending);
    await vi.waitFor(() => {
      expect(acquire.mock.calls.length).toBeGreaterThan(heldAttempts + BACKGROUND_LOCK_ATTEMPTS);
    }, { timeout: 2_000, interval: 5 });
    expect(done()).toBe(false);
    expect(entered).toBe(0);

    await releases.shift()!();
    await expect(pending).resolves.toBe("saved");
    expect(entered).toBe(1);
  });

  it("cancels a long 落笔 wait as soon as the run aborts", async () => {
    const { root, bookId } = await book();
    const acquire = vi.spyOn(StateManager.prototype, "acquireBookLock");
    await hold(bookId, "落笔");
    const heldAttempts = acquire.mock.calls.length;
    const controller = new AbortController();
    let entered = 0;
    const pending = withBackgroundBookWrite(root, "研墨候选", async () => {
      entered += 1;
      return "saved";
    }, { delayMs: 5, signal: controller.signal });
    await vi.waitFor(() => {
      expect(acquire.mock.calls.length).toBeGreaterThan(heldAttempts + BACKGROUND_LOCK_ATTEMPTS);
    }, { timeout: 2_000, interval: 5 });
    expect(entered).toBe(0);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AuthoringRunCancelledError);
    expect(entered).toBe(0);
  });

  it("still stops at the short budget when the holder is not a write stage", async () => {
    const { root, bookId } = await book();
    const acquire = vi.spyOn(StateManager.prototype, "acquireBookLock");
    await hold(bookId, "采用正典");
    const heldAttempts = acquire.mock.calls.length;
    await expect(withBackgroundBookWrite(root, "问心候选", async () => "saved", {
      delayMs: 5,
    })).rejects.toBeInstanceOf(BookWriteLockError);
    expect(acquire.mock.calls.length).toBe(heldAttempts + BACKGROUND_LOCK_ATTEMPTS);
  });

  it("maps a give-up while 落笔 still holds the lock to the deferred save code", async () => {
    const { root, bookId } = await book();
    await hold(bookId, "落笔");
    const error = await withBackgroundBookWrite(root, "织卷候选", async () => "saved", {
      maxAttempts: 2,
      delayMs: 5,
    }).then(() => {
      throw new Error("expected the background save to give up");
    }, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackgroundSaveDeferredError);
    expect(error).toMatchObject({
      code: BACKGROUND_SAVE_DEFERRED,
      message: BACKGROUND_SAVE_DEFERRED,
    });
    expect(isBookWriteLockError(error)).toBe(false);
    expect(isBookWriteLockMessage(error instanceof Error ? error.message : String(error))).toBe(false);
  });

  it("keeps an adopted chapter when a background ask persist lands afterwards", async () => {
    const { root, bookId } = await book();
    const before = await loadManifest(root);
    const acquire = vi.spyOn(StateManager.prototype, "acquireBookLock");
    await hold(bookId);
    const heldAttempts = acquire.mock.calls.length;
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
    await waitForMoreLockAttempts(acquire, heldAttempts);
    expect(done()).toBe(false);

    await saveManifest(root, {
      ...before,
      adopted: { ...before.adopted, write: { ...before.adopted.write, "1": "write-adopted-1" } },
      coverage: { ...before.coverage, chaptersWrittenAdopted: 1 },
    });
    await waitForMoreLockAttempts(acquire, acquire.mock.calls.length);
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

  it("drops a weave draft when the manifest pointer update fails", async () => {
    const { root, bookId } = await book();
    const before = (await listArtifacts(root)).map((item) => item.artifactId);
    const original = StateManager.prototype.acquireBookLock;
    const acquire = vi.spyOn(StateManager.prototype, "acquireBookLock");
    acquire.mockImplementation(function (this: StateManager, lockedBookId, holder, options) {
      if (holder?.stage === "织卷候选") return Promise.reject(new Error("pointer update failed"));
      return original.call(this, lockedBookId, holder, options);
    });
    await expect(generateWeaveStructure({
      root,
      project: ProjectConfigSchema.parse({
        name: "lock-test",
        version: "0.1.0",
        llm: {
          provider: "custom",
          model: "weave-main",
          baseUrl: "https://unused.invalid/v1",
          apiKey: "stub",
        },
        authoringRoles: { "weave.main": { modelId: "weave-main" } },
      }),
      llm: async () => JSON.stringify({
        bookOutline: "覆盖结构",
        volumes: [{ volumeNumber: 1, title: "全", startChapter: 1, endChapter: 12, body: "全书" }],
      }),
    })).rejects.toThrow("pointer update failed");
    expect((await listArtifacts(root)).map((item) => item.artifactId).sort()).toEqual([...before].sort());
    expect((await loadManifest(root)).candidates.weave).toBeUndefined();
    const names = await readdir(join(projectRoot, "books", bookId, "story", "workflow", "artifacts")).catch(() => [] as string[]);
    expect(names.filter((name) => name.startsWith("weave-"))).toEqual([]);
  });

  function openWeaveImpact(impactId: string) {
    return {
      impactId,
      createdAt: "2026-09-29T00:00:00.000Z",
      from: { artifactId: "ask-1", version: 1 },
      to: { artifactId: "ask-2", version: 2 },
      changes: [],
      globals: [],
      items: [{
        key: "weave:structure",
        stage: "weave" as const,
        targetId: "volume-map",
        label: "分卷",
        verdict: "affected" as const,
        fields: ["oneLine"],
        reason: "正典变了",
        method: "rule" as const,
        status: "open" as const,
      }],
      method: "heuristic" as const,
    };
  }

  it("writes impact with locked:true only while this call already holds the book lock", async () => {
    const { root } = await book();
    await saveImpactReport(root, openWeaveImpact("impact-held"));
    const acquire = vi.spyOn(StateManager.prototype, "acquireBookLock");
    const before = acquire.mock.calls.length;
    await withBookWriteLock(root, "采用规划", async () => {
      expect(bookWriteLockHeld(root.projectRoot, root.bookId!)).toBe(true);
      const atLock = acquire.mock.calls.length;
      await expect(withBookWriteLock(root, "落笔", async () => "inner")).rejects.toBeInstanceOf(BookWriteLockError);
      const saved = await closeImpactItems(root, {
        weaveBody: "# 卷一\n",
        weaveArtifactId: "weave-x",
      }, { locked: true });
      expect(saved?.items[0]?.status).toBe("regenerated");
      expect(acquire.mock.calls.length).toBe(atLock + 1);
    });
    expect(bookWriteLockHeld(root.projectRoot, root.bookId!)).toBe(false);
    expect(acquire.mock.calls.length).toBe(before + 2);
    const manifest = await loadManifest(root);
    expect(manifest.impactBaseline?.ask).toBe("ask-2");
  });

  it("rejects locked:true when the caller does not hold the book lock", async () => {
    const { root } = await book();
    await saveImpactReport(root, openWeaveImpact("impact-open"));
    const before = await loadManifest(root);
    await expect(closeImpactItems(root, {
      weaveBody: "# 卷一\n",
      weaveArtifactId: "weave-y",
    }, { locked: true })).rejects.toBeInstanceOf(BookWriteLockNotHeldError);
    const after = await loadManifest(root);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.watches).toEqual(before.watches);
    expect(after.impactBaseline).toEqual(before.impactBaseline);
  });

  it("redacts secrets when closing impact items after adopt fails", async () => {
    const { root } = await book();
    const secretRoot = { projectRoot: root.projectRoot, bookId: "sk-supersecretvalue" };
    await saveImpactReport(secretRoot, openWeaveImpact("impact-secret"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(closeImpactItemsAfterAdopt(secretRoot, {
      weaveBody: "# 卷一\n",
      weaveArtifactId: "weave-x",
    })).resolves.toBeUndefined();
    const logged = warn.mock.calls.map((call) => call.map((part) => String(part)).join(" ")).join("\n");
    expect(logged).toContain("closeImpactItems after adopt failed");
    expect(logged).not.toContain("sk-supersecretvalue");
    expect(logged).toContain(redactSecrets("sk-supersecretvalue"));
  });

  it("retries a transient EPERM while creating the lock file and then acquires it", async () => {
    const { bookId } = await book();
    const internals = bookLockInternals();
    const original = internals.createLockFile;
    let eperm = 0;
    const create = vi.spyOn(internals, "createLockFile").mockImplementation(async function (this: StateManager, lockPath, metadata) {
      if (eperm < 2) {
        eperm += 1;
        throw lockFsError("EPERM");
      }
      return original.call(this, lockPath, metadata);
    });

    const release = await new StateManager(projectRoot).acquireBookLock(bookId, {
      stage: "落笔",
      taskId: "eperm-retry",
    }, { waitMs: 0 });
    releases.push(release);
    expect(eperm).toBe(2);
    expect(create).toHaveBeenCalledTimes(3);
    expect((await stat(join(projectRoot, "books", bookId, ".write.lock"))).isFile()).toBe(true);
  });

  it("turns an exhausted Windows lock race into BookWriteLockError instead of EPERM", async () => {
    const { bookId } = await book();
    const create = vi.spyOn(bookLockInternals(), "createLockFile").mockImplementation(async () => {
      throw lockFsError("EPERM");
    });
    const error = await new StateManager(projectRoot).acquireBookLock(bookId, {
      stage: "落笔",
      taskId: "eperm-exhausted",
    }, { waitMs: 0 }).then(() => {
      throw new Error("expected the lock acquire to fail busy");
    }, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(BookWriteLockError);
    expect(error).toMatchObject({ code: "BOOK_BUSY" });
    expect((error as NodeJS.ErrnoException).code).not.toBe("EPERM");
    expect(create).toHaveBeenCalledTimes(4);
    expect(new StateManager(projectRoot).inspectBookLock(bookId)).toBeNull();
  });

  it("does not surface EPERM when this process acquires again as soon as release finishes", async () => {
    const { bookId } = await book();
    const manager = new StateManager(projectRoot);
    const release = await manager.acquireBookLock(bookId, {
      stage: "落笔",
      taskId: "release-race",
    });
    const internals = bookLockInternals();
    const original = internals.unlinkWithRetry;
    let entered = 0;
    let unblock = () => {};
    const gate = new Promise<void>((resolveGate) => {
      unblock = resolveGate;
    });
    vi.spyOn(internals, "unlinkWithRetry").mockImplementation(async function (this: StateManager, lockPath) {
      entered += 1;
      await gate;
      return original.call(this, lockPath);
    });

    const releasing = release();
    try {
      await vi.waitFor(() => {
        expect(entered).toBe(1);
      });
      expect(manager.inspectBookLock(bookId)).toMatchObject({ stage: "落笔", inProcess: true });
      const raced = await manager.acquireBookLock(bookId, { stage: "问心候选" }, { waitMs: 0 }).then(() => {
        throw new Error("expected the lock to stay held until the file is gone");
      }, (caught: unknown) => caught);
      expect(raced).toBeInstanceOf(BookWriteLockError);
      expect(raced).toMatchObject({ code: "BOOK_BUSY" });
      expect((raced as NodeJS.ErrnoException).code).not.toBe("EPERM");

      unblock();
      await releasing;
      expect(manager.inspectBookLock(bookId)).toBeNull();
      const again = await manager.acquireBookLock(bookId, { stage: "问心候选" }, { waitMs: 0 });
      releases.push(again);
      expect((await stat(join(projectRoot, "books", bookId, ".write.lock"))).isFile()).toBe(true);
    } finally {
      unblock();
      await releasing.catch(() => undefined);
    }
  });
});
