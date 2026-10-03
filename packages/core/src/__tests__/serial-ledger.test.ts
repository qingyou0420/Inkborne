import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyChapterMemory,
  formatSettleIdentity,
  loadSerialLedger,
  remapSettleNoteToIdentity,
  SerialLedgerCorruptError,
} from "../authoring/serial-ledger.js";

describe("serial ledger load", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function bookDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "serial-ledger-"));
    roots.push(root);
    await mkdir(join(root, "story", "state"), { recursive: true });
    return root;
  }

  it("starts empty when the ledger file does not exist", async () => {
    const dir = await bookDir();
    expect(await loadSerialLedger(dir)).toBeUndefined();
    const next = applyChapterMemory(undefined, {
      chapter: 1,
      artifactId: "w1",
      title: "起",
      summary: "开始",
      characters: [],
      openHooks: [],
      advanceHookIds: [],
      resolveHookIds: [],
    });
    expect(next.chapters).toHaveLength(1);
  });

  it("keeps truncated JSON on disk and refuses to treat it as an empty ledger", async () => {
    const dir = await bookDir();
    const path = join(dir, "story", "state", "serial-ledger.json");
    const original = '{"version":1,"updatedAt":"2026-10-01T00:00:00.000Z","chapters":[{"chapter":1,"artifactId":"w1","title":"起","summary":"早期伏笔","characters":[],"openHooks":[{"id":"h1","label":"旧线","note":""}],"advanceHookIds":[],"resolveHookIds":[]},{"chapter":2,"artifactId":"w2","title":"续","summary":"推进","characters":[],"openHooks":[],"advanceHookIds":["h1"],"resolveHookIds":[]}';
    await writeFile(path, original, "utf-8");
    await expect(loadSerialLedger(dir)).rejects.toBeInstanceOf(SerialLedgerCorruptError);
    expect(await readFile(path, "utf-8")).toBe(original);
  });

  it("refuses a readable file that fails schema validation", async () => {
    const dir = await bookDir();
    const path = join(dir, "story", "state", "serial-ledger.json");
    await writeFile(path, JSON.stringify({ version: 2, chapters: "nope" }), "utf-8");
    await expect(loadSerialLedger(dir)).rejects.toMatchObject({ name: "SerialLedgerCorruptError", path });
    expect(await readFile(path, "utf-8")).toContain('"version":2');
  });
});

describe("settle identity", () => {
  const origin = {
    chapter: 1,
    artifactId: "old-w1",
    title: "埋线",
    summary: "藏铜牌",
    characters: [{ name: "林", status: "藏了铜牌" }],
    openHooks: [{ id: "hook-badge", label: "抽屉里的铜牌", note: "尚未收回" }],
    advanceHookIds: [],
    resolveHookIds: [],
  };

  it("lists this chapter's old hook ids without treating character status as current fact", () => {
    const text = formatSettleIdentity(origin);
    expect(text).toContain("hook-badge");
    expect(text).toContain("抽屉里的铜牌");
    expect(text).toContain("本章上次伏笔身份");
    expect(text).not.toContain("藏了铜牌");
  });

  it("remaps a new id that keeps the old label, and does not reinsert an omitted hook", () => {
    const remapped = remapSettleNoteToIdentity({
      summary: "仍埋着",
      characters: [{ name: "林", status: "刚改错字" }],
      openHooks: [{ id: "hook-badge-new", label: "抽屉里的铜牌", note: "" }],
      advanceHookIds: [],
      resolveHookIds: [],
    }, origin);
    expect(remapped.openHooks).toEqual([
      expect.objectContaining({ id: "hook-badge", label: "抽屉里的铜牌" }),
    ]);
    const dropped = remapSettleNoteToIdentity({
      summary: "不再埋",
      characters: [],
      openHooks: [],
      advanceHookIds: [],
      resolveHookIds: [],
    }, origin);
    expect(dropped.openHooks).toEqual([]);
  });
});
