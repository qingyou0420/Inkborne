/** SPDX-License-Identifier: AGPL-3.0-only */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { askCanonScopeKey, askConversation, askReportState, createAskCanonEditor, isAskSession } from "./ask-canon-state";
import type { AuthoringReport } from "../lib/authoring-workspace";
import { emptyManifest, loadArtifact, loadManifest, saveArtifact, saveHandEditedArtifact, saveManifest } from "../../../core/src/authoring/store";

describe("问心 current conversation and review state", () => {
  it("uses the existing book's active discussion and textual streaming parts", () => {
    expect(askConversation({ bookId: "book-a", sessionKind: "book", messages: [
      { role: "user", content: "修复师寻找父亲。", timestamp: 1 },
      { role: "assistant", content: "", timestamp: 2, parts: [{ type: "thinking", content: "hidden reasoning", streaming: false }, { type: "text", content: "先确定他为何寻找。" }] },
    ] }, "book-a")).toBe("user: 修复师寻找父亲。\nassistant: 先确定他为何寻找。");
  });
  it("does not send another book or a play session into canon generation", () => {
    const messages = [{ role: "user" as const, content: "other story", timestamp: 1 }];
    expect(askConversation({ bookId: "book-b", sessionKind: "book", messages }, "book-a")).toBe("");
    expect(askConversation({ bookId: "book-a", sessionKind: "play", messages }, "book-a")).toBe("");
    expect(isAskSession({ bookId: null, sessionKind: "chat" })).toBe(false);
    expect(isAskSession({ bookId: null, sessionKind: "book-create" })).toBe(true);
  });
  it("supports legacy book sessions without a kind", () => {
    expect(isAskSession({ bookId: "book-a" }, "book-a")).toBe(true);
  });
  const report: AuthoringReport = { reportId: "ask-review", stage: "ask", coverage: "canon", actualReviewModel: "review-model", summary: "Review", targetRefs: ["ask-v2"], issues: [] };
  it("marks a review outdated immediately on unsaved edits, before a new artifact exists", () => {
    expect(askReportState([report], "ask-v2", false).stale).toBe(false);
    expect(askReportState([report], "ask-v2", true).stale).toBe(true);
    expect(askReportState([report], "ask-v3", false).stale).toBe(true);
  });
  it("never labels another agent's report as an ask review", () => {
    const ground = { ...report, reportId: "ground-review", stage: "ground" };
    expect(askReportState([ground, report], "ask-v2", false).report?.reportId).toBe("ask-review");
    expect(askReportState([ground], "ask-v2", false).report).toBeUndefined();
  });
});

describe("问心 save and history endpoint contract", () => {
  it("saving and restoring old text create new candidates, preserving adopted canon and history", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "inkborne-ask-ui-"));
    const root = { projectRoot, draftId: "ask-ui-test" };
    try {
      await saveArtifact(root, { artifactId: "canon-adopted", stage: "ask", scope: "canon", version: 1, source: "generate", status: "adopted", bodyPath: "story/canon.md", inputRefs: [], createdAt: "2026-09-15T00:00:00Z" }, "Original canon");
      const manifest = emptyManifest(root);
      await saveManifest(root, { ...manifest, adopted: { ...manifest.adopted, ask: "canon-adopted" }, candidates: { ...manifest.candidates, ask: "canon-adopted" } });
      const edited = await saveHandEditedArtifact(root, "canon-adopted", "Edited candidate");
      expect(edited.version).toBe(2);
      expect(edited.status).toBe("candidate");
      expect((await loadManifest(root)).adopted.ask).toBe("canon-adopted");
      const historical = await loadArtifact(root, "canon-adopted");
      const restored = await saveHandEditedArtifact(root, edited.artifactId, historical!.body);
      expect(restored.version).toBe(3);
      expect(restored.artifactId).not.toBe(edited.artifactId);
      expect((await loadManifest(root)).candidates.ask).toBe(restored.artifactId);
      expect((await loadManifest(root)).adopted.ask).toBe("canon-adopted");
      expect((await loadArtifact(root, edited.artifactId))?.body).toBe("Edited candidate\n");
      expect((await loadArtifact(root, restored.artifactId))?.body).toBe("Original canon\n");
    } finally { await rm(projectRoot, { recursive: true, force: true }); }
  });
});

describe("问心 retained candidate edits", () => {
  const candidate = (artifactId: string, body: string) => ({ artifactId, body, version: 1, status: "candidate" });

  it("explicit discard restores the saved body and releases only this book's cached edits", () => {
    const editor = createAskCanonEditor("book:discard-edit");
    const other = createAskCanonEditor("book:discard-other");
    editor.load(candidate("v1", "saved"));
    other.load(candidate("other-v1", "other saved"));
    editor.change("not wanted"); other.change("keep these edits");
    editor.discard();
    expect(editor.snapshot).toMatchObject({ body: "saved", editBaseId: "v1", dirty: false });
    expect(createAskCanonEditor("book:discard-edit").snapshot.dirty).toBe(false);
    expect(createAskCanonEditor("book:discard-other").snapshot.body).toBe("keep these edits");
    other.discard();
  });

  it("retains dirty text on a newer candidate and saves from the original artifact", async () => {
    const editor = createAskCanonEditor("book:base-regression");
    editor.load(candidate("ask-v1", "original"));
    editor.change("hand edit");
    expect(editor.load(candidate("ask-v2", "another candidate"))).toBe(false);
    expect(editor.snapshot).toMatchObject({ body: "hand edit", editBaseId: "ask-v1", dirty: true });
    const write = vi.fn().mockResolvedValue({ artifactId: "ask-v3" });
    expect(await editor.save(write)).toBe("ask-v3");
    expect(write).toHaveBeenCalledExactlyOnceWith("ask-v1", "hand edit");
    expect(editor.snapshot).toMatchObject({ body: "hand edit", editBaseId: "ask-v3", pendingSavedId: "ask-v3", dirty: false });
    expect(editor.load(candidate("ask-v2", "late stale response"))).toBe(false);
    expect(await editor.save(write)).toBe("ask-v3");
    expect(write).toHaveBeenCalledTimes(1);
    expect(editor.load(candidate("ask-v3", "hand edit\n"))).toBe(true);
    expect(editor.snapshot.body).toBe("hand edit\n");
  });

  it("restores a route-unmounted draft, isolated by book and pre-book session", () => {
    const key = askCanonScopeKey(undefined, "draft-session-a");
    const first = createAskCanonEditor(key);
    first.load(candidate("ask-draft-v1", "saved"));
    first.change("not yet saved");
    const remounted = createAskCanonEditor(key);
    expect(remounted.snapshot).toMatchObject({ body: "not yet saved", editBaseId: "ask-draft-v1", dirty: true });
    remounted.load(undefined);
    expect(remounted.snapshot.body).toBe("not yet saved");
    expect(createAskCanonEditor(askCanonScopeKey(undefined, "draft-session-b")).snapshot.dirty).toBe(false);
    expect(createAskCanonEditor(askCanonScopeKey("draft-session-a")).snapshot.dirty).toBe(false);
    expect(askCanonScopeKey("book-a", "one")).toBe(askCanonScopeKey("book-a", "two"));
    first.change("saved");
  });

  it("keeps the buffered draft when save fails and only clears it after success", async () => {
    const key = "book:save-failure";
    const editor = createAskCanonEditor(key);
    editor.load(candidate("original-id", "before"));
    editor.change("recover this");
    await expect(editor.save(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    const restored = createAskCanonEditor(key);
    expect(restored.snapshot).toMatchObject({ body: "recover this", editBaseId: "original-id", dirty: true });
    await restored.save(async () => ({ artifactId: "saved-id" }));
    expect(createAskCanonEditor(key).snapshot.dirty).toBe(false);
  });

  it("does not clear newer typing after an earlier mount's save finishes", async () => {
    const key = "book:late-save";
    const oldMount = createAskCanonEditor(key);
    oldMount.load(candidate("v1", "original"));
    oldMount.change("old edit");
    let resolve!: (saved: { artifactId: string }) => void;
    const saving = oldMount.save(() => new Promise((done) => { resolve = done; }));
    const newMount = createAskCanonEditor(key);
    newMount.change("new typing after navigation");
    resolve({ artifactId: "v2" });
    await saving;
    expect(createAskCanonEditor(key).snapshot).toMatchObject({ body: "new typing after navigation", editBaseId: "v1", dirty: true });
    await newMount.save(async () => ({ artifactId: "v3" }));
  });

  it("waits for the exact generated or restored candidate before replacing clean text", () => {
    const editor = createAskCanonEditor(undefined);
    editor.load(candidate("v1", "original"));
    editor.expectCandidate("v2");
    expect(editor.load(candidate("v1", "late response"))).toBe(false);
    expect(editor.load(candidate("v2", "new candidate"), true)).toBe(false);
    expect(editor.load(candidate("v2", "new candidate"))).toBe(true);
    expect(editor.snapshot).toMatchObject({ body: "new candidate", editBaseId: "v2", dirty: false });
    expect(editor.snapshot.pendingSavedId).toBeUndefined();
  });

  it("can load the newer candidate after the user undoes all local edits", () => {
    const editor = createAskCanonEditor("book:undo-local");
    editor.load(candidate("v1", "original"));
    editor.change("local change");
    const incoming = candidate("v2", "updated remotely");
    expect(editor.load(incoming)).toBe(false);
    editor.change("original");
    expect(editor.snapshot.dirty).toBe(false);
    expect(editor.load(incoming)).toBe(true);
    expect(editor.snapshot).toMatchObject({ body: "updated remotely", editBaseId: "v2", dirty: false });
  });

  it("keeps one unload guard for cached drafts after route changes and releases it after save", async () => {
    const addEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener });
    try {
      const key = "book:unload-buffer";
      const firstMount = createAskCanonEditor(key);
      createAskCanonEditor("book:another-mount");
      expect(addEventListener).toHaveBeenCalledTimes(1);
      expect(addEventListener.mock.calls[0]?.[0]).toBe("beforeunload");
      const onUnload = addEventListener.mock.calls[0]![1] as (event: { preventDefault: () => void; returnValue?: string }) => void;
      const event = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
      onUnload(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      firstMount.load(candidate("v1", "saved"));
      firstMount.change("retained after leaving");
      onUnload(event);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      const returningMount = createAskCanonEditor(key);
      await returningMount.save(async () => ({ artifactId: "v2" }));
      onUnload(event);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(addEventListener).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
});
