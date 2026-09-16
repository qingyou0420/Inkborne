/** SPDX-License-Identifier: AGPL-3.0-only */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createGroundCandidateEditor, createGroundMaterialDrafts, hasPendingGroundDrafts, pendingGroundEntry, saveGroundFrameZone } from "./ground-drafts";
import { extractStoryFrameZone } from "./story-frame-sections";
import { loadArtifact, loadSettingsCatalog, saveArtifact, saveHandEditedArtifact, saveSettingsCatalog } from "../../../core/src/authoring/store";

describe("研墨 candidate draft lifecycle", () => {
  it("restores a route-unmounted draft by book and entry, then saves from its original artifact without adopting", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "inkborne-ground-draft-"));
    const root = { projectRoot, bookId: "ground-test" };
    const editor = createGroundCandidateEditor(projectRoot, "world");
    try {
      const story = join(projectRoot, "books", root.bookId, "story", "settings");
      await mkdir(story, { recursive: true });
      await writeFile(join(story, "world.md"), "Adopted world", "utf8");
      await saveArtifact(root, { artifactId: "ground-v1", stage: "ground", scope: "world", version: 1, status: "adopted", source: "generate", bodyPath: "story/settings/world.md", inputRefs: [], createdAt: "2026-09-15T00:00:00Z" }, "Original world");
      await saveArtifact(root, { artifactId: "ground-v2", stage: "ground", scope: "world", version: 2, status: "candidate", source: "generate", bodyPath: "story/settings/world.md", inputRefs: [], createdAt: "2026-09-15T00:00:01Z" }, "Generated elsewhere");
      await saveSettingsCatalog(root, { categories: ["世界"], entries: [{ id: "world", category: "世界", name: "世界", file: "story/settings/world.md", adoptedArtifactId: "ground-v1", candidateArtifactId: "ground-v2", archived: false }] });
      editor.load("ground-v1", "Original world");
      editor.change("Retain my hand edit");
      expect(pendingGroundEntry(projectRoot)).toBe("world");
      expect(createGroundCandidateEditor(projectRoot, "person").snapshot.dirty).toBe(false);
      expect(createGroundCandidateEditor(`${projectRoot}-other`, "world").snapshot.dirty).toBe(false);
      const returned = createGroundCandidateEditor(projectRoot, "world");
      expect(returned.load("ground-v2", "Generated elsewhere")).toBe(false);
      expect(returned.load(undefined, "")).toBe(false);
      expect(returned.snapshot).toMatchObject({ body: "Retain my hand edit", baseId: "ground-v1", dirty: true });
      const savedId = await returned.save((baseId, body) => saveHandEditedArtifact(root, baseId, body));
      const saved = await loadArtifact(root, savedId!);
      expect(saved?.meta).toMatchObject({ parentArtifactId: "ground-v1", status: "candidate", source: "hand" });
      expect(saved?.body).toBe("Retain my hand edit\n");
      expect((await loadSettingsCatalog(root)).entries[0]).toMatchObject({ adoptedArtifactId: "ground-v1", candidateArtifactId: savedId });
      expect(await readFile(join(story, "world.md"), "utf8")).toBe("Adopted world");
      expect((await loadArtifact(root, "ground-v2"))?.body).toBe("Generated elsewhere\n");
      expect(createGroundCandidateEditor(projectRoot, "world").snapshot.dirty).toBe(false);
      expect(returned.load("ground-v2", "Late response")).toBe(false);
      expect(returned.load(savedId, "Retain my hand edit")).toBe(true);
      expect(returned.load("ground-v4", "Next explicit generation")).toBe(true);
    } finally { await rm(projectRoot, { recursive: true, force: true }); }
  });

  it("retains a failed save and clears only on success", async () => {
    const editor = createGroundCandidateEditor("ground-failed", "entry");
    editor.load("v1", "saved"); editor.change("unsaved");
    await expect(editor.save(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    const restored = createGroundCandidateEditor("ground-failed", "entry");
    expect(restored.snapshot).toMatchObject({ baseId: "v1", body: "unsaved", dirty: true });
    const write = vi.fn().mockResolvedValue({ artifactId: "v2" });
    await restored.save(write);
    expect(write).toHaveBeenCalledExactlyOnceWith("v1", "unsaved");
    expect(pendingGroundEntry("ground-failed")).toBeUndefined();
    restored.generated();
    expect(restored.load("v3", "Next generation")).toBe(true);
  });

  it("can load the new pointer after the user reverts the retained text to its saved body", () => {
    const editor = createGroundCandidateEditor("ground-revert", "entry");
    editor.load("v1", "saved"); editor.change("hand edit");
    expect(editor.load("v2", "generated")).toBe(false);
    editor.change("saved");
    expect(editor.snapshot.dirty).toBe(false);
    expect(editor.load("v2", "generated")).toBe(true);
    expect(editor.snapshot.body).toBe("generated");
  });

  it("does not clear typing in a later mount when the previous save completes", async () => {
    const oldMount = createGroundCandidateEditor("ground-late", "entry");
    oldMount.load("v1", "saved"); oldMount.change("first edit");
    let finish!: (result: { artifactId: string }) => void;
    const saving = oldMount.save(() => new Promise((resolve) => { finish = resolve; }));
    const newMount = createGroundCandidateEditor("ground-late", "entry");
    newMount.change("later typing");
    finish({ artifactId: "v2" }); await saving;
    expect(createGroundCandidateEditor("ground-late", "entry").snapshot).toMatchObject({ baseId: "v1", body: "later typing", dirty: true });
    await newMount.save(async () => ({ artifactId: "v3" }));
  });

  it("keeps typing made during a save in the same editor and advances its base", async () => {
    const editor = createGroundCandidateEditor("ground-same-mount", "entry");
    editor.load("v1", "saved"); editor.change("first edit");
    let finish!: (result: { artifactId: string }) => void;
    const saving = editor.save(() => new Promise((resolve) => { finish = resolve; }));
    editor.change("second edit"); finish({ artifactId: "v2" }); await saving;
    expect(createGroundCandidateEditor("ground-same-mount", "entry").snapshot).toMatchObject({ baseId: "v2", body: "second edit", savedBody: "first edit", dirty: true });
    await editor.save(async () => ({ artifactId: "v3" }));
  });
});

describe("研墨 adopted material drafts", () => {
  it("retains all seven sections, multiple role files, and unsubmitted questions across routes with book isolation", () => {
    const first = createGroundMaterialDrafts("ground-materials");
    const values = {
      "$basics": { platform: "other", genre: "现实", target: "3", words: "300", tone: "克制" },
      "$story-card": { workingTitle: "回信", oneLine: "一封迟到的信", synopsis: "保留梗概" },
      theme: "", "author_intent.md": "作者意图", world: "世界", "roles/major/a.md": "甲",
      "roles/major/b.md": "乙", conflict: "冲突", ending: "终局", "pending_hooks.md": "伏笔",
      "open_questions.md": "# 待定\n- [ ] 谁寄信", "$open-input": "尚未提交",
    };
    for (const [key, value] of Object.entries(values)) first.change(key, value);
    const returned = createGroundMaterialDrafts("ground-materials");
    expect(returned.keys()).toHaveLength(Object.keys(values).length);
    for (const [key, value] of Object.entries(values)) expect(returned.get(key)).toEqual(value);
    expect(returned.has("theme")).toBe(true); // Intentional deletion remains a draft.
    expect(createGroundMaterialDrafts("ground-another-book").keys()).toEqual([]);
    for (const key of returned.keys()) returned.discard(key);
  });

  it("does not clear a newer material draft after a late save acknowledgement", () => {
    const oldMount = createGroundMaterialDrafts("ground-material-late");
    oldMount.change("world", "submitted");
    const submitted = oldMount.capture("world");
    const newMount = createGroundMaterialDrafts("ground-material-late");
    newMount.change("world", "new typing");
    expect(oldMount.saved("world", submitted)).toBe(false);
    expect(createGroundMaterialDrafts("ground-material-late").get("world")).toBe("new typing");
    expect(newMount.saved("world", newMount.capture("world"))).toBe(true);
    expect(newMount.has("world")).toBe(false);
  });

  it("saves only the selected zone into the latest disk file, retaining another unsaved zone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inkborne-ground-frame-"));
    const file = join(dir, "story_frame.md");
    const drafts = createGroundMaterialDrafts(dir);
    try {
      await writeFile(file, "---\ngenreLock: 现实\n---\n\n## 世界铁律\n旧世界\n\n## 核心冲突\n生成后的新冲突\n", "utf8");
      drafts.change("world", "手改世界"); drafts.change("conflict", "未保存冲突");
      const submitted = drafts.capture("world");
      await saveGroundFrameZone("world", drafts.get("world")!, true, () => readFile(file, "utf8"), (next) => writeFile(file, next, "utf8"));
      drafts.saved("world", submitted);
      const saved = await readFile(file, "utf8");
      expect(extractStoryFrameZone(saved, "world").body).toBe("手改世界");
      expect(extractStoryFrameZone(saved, "conflict").body).toBe("生成后的新冲突");
      expect(saved).toContain("genreLock: 现实");
      expect(createGroundMaterialDrafts(dir).get("conflict")).toBe("未保存冲突");
      expect(drafts.has("world")).toBe(false);
    } finally { drafts.discard("conflict"); await rm(dir, { recursive: true, force: true }); }
  });

  it("never writes a frame if its latest read fails, and retains the draft on a rejected write", async () => {
    const drafts = createGroundMaterialDrafts("ground-frame-fail"); drafts.change("world", "保留");
    const write = vi.fn();
    await expect(saveGroundFrameZone("world", "保留", true, async () => { throw new Error("read failed"); }, write)).rejects.toThrow("read failed");
    expect(write).not.toHaveBeenCalled();
    await expect(saveGroundFrameZone("world", "保留", true, async () => "## 世界铁律\n旧文", async () => { throw new Error("write failed"); })).rejects.toThrow("write failed");
    expect(createGroundMaterialDrafts("ground-frame-fail").get("world")).toBe("保留");
    drafts.discard("world");
  });

  it("retains only the unfinished file after a partial ending/hooks save", () => {
    const drafts = createGroundMaterialDrafts("ground-partial");
    drafts.change("ending", "已写入结局"); drafts.change("pending_hooks.md", "尚未写入伏笔");
    const endingSubmitted = drafts.capture("ending");
    drafts.saved("ending", endingSubmitted);
    const returned = createGroundMaterialDrafts("ground-partial");
    expect(returned.has("ending")).toBe(false);
    expect(returned.get("pending_hooks.md")).toBe("尚未写入伏笔");
    returned.discard("pending_hooks.md");
  });

  it("warns about retained drafts after the editor route has unmounted, then clears after save", () => {
    expect(hasPendingGroundDrafts()).toBe(false);
    let onUnload: ((event: { preventDefault: () => void; returnValue: string }) => void) | undefined;
    vi.stubGlobal("window", { addEventListener: (type: string, listener: typeof onUnload) => { if (type === "beforeunload") onUnload = listener; } });
    try {
      const drafts = createGroundMaterialDrafts("ground-unload");
      drafts.change("world", "unsaved after navigation");
      const event = { preventDefault: vi.fn(), returnValue: "unchanged" };
      onUnload!(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.returnValue).toBe("");
      drafts.saved("world", drafts.capture("world"));
      expect(hasPendingGroundDrafts()).toBe(false);
      const clean = { preventDefault: vi.fn(), returnValue: "unchanged" };
      onUnload!(clean); expect(clean.preventDefault).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
