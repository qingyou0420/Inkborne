import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBookStage } from "./book-stage-io";

async function seedBook(root: string): Promise<string> {
  const bookDir = join(root, "old-book");
  await mkdir(join(bookDir, "story", "outline"), { recursive: true });
  await mkdir(join(bookDir, "story", "roles", "主要角色"), { recursive: true });
  await writeFile(join(bookDir, "story", "author_intent.md"), "保持冷调。\n", "utf-8");
  await writeFile(
    join(bookDir, "story", "outline", "story_frame.md"),
    ["## 世界铁律", "不可飞升。", "## 人物", "苏绻。", "## 核心冲突", "德与兵。", "## 终局", "书院重开。"].join("\n"),
    "utf-8",
  );
  await writeFile(join(bookDir, "story", "roles", "主要角色", "苏绻.md"), "# 苏绻\n", "utf-8");
  await writeFile(
    join(bookDir, "story", "outline", "volume_map.md"),
    ["## 第1卷 书院（1–10章）", "", "### 第 1 章 倒叙冷开", "落回春日。"].join("\n"),
    "utf-8",
  );
  return bookDir;
}

describe("resolveBookStage migration", () => {
  it("uses manifest adoption facts before compatibility text or old timestamps", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkborne-candidate-stage-"));
    try {
      const bookDir = join(root, "candidate-book");
      const storyDir = join(bookDir, "story");
      await mkdir(join(storyDir, "workflow"), { recursive: true });
      await writeFile(join(storyDir, "author_intent.md"), "作者的完整构思。", "utf-8");
      await writeFile(join(storyDir, "story_card.md"), "确认卡只是创作约定。", "utf-8");
      await writeFile(join(storyDir, "workflow.json"), JSON.stringify({
        lastStage: "weave", askConfirmedAt: "old", groundConfirmedAt: "old", weaveLockedAt: "old",
      }), "utf-8");
      const manifestPath = join(storyDir, "workflow", "manifest.json");
      await writeFile(manifestPath, JSON.stringify({ candidates: { ask: "ask-first" }, adopted: {} }), "utf-8");
      const input = { bookDir, bookExists: true, nextChapter: 1, chaptersWritten: 0 };
      const pending = await resolveBookStage(input);
      expect(pending).toEqual({
        stage: "ask", steps: { ask: "current", ground: "todo", weave: "todo", write: "todo" }, workflow: { lastStage: "ask" },
      });
      expect(JSON.parse(await readFile(join(storyDir, "workflow.json"), "utf-8"))).toEqual({ lastStage: "ask" });
      await writeFile(join(storyDir, "canon.md"), "# 已采用正典\n\n作者采用的内容。", "utf-8");
      // Older canon files may lack an adopted.ask record; their stages must not rewind.
      const legacyCanon = await resolveBookStage(input);
      expect(legacyCanon.stage).toBe("ground");
      await writeFile(manifestPath, JSON.stringify({ candidates: { ask: "ask-first" }, adopted: { ask: "ask-first" } }), "utf-8");
      const adopted = await resolveBookStage(input);
      expect(adopted.stage).toBe("ground");
      expect(adopted.steps.ask).toBe("done");
      expect(adopted.steps.weave).toBe("todo");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes workflow.json for an old book and does not rewind to 问心", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkborne-stage-"));
    const bookDir = await seedBook(root);
    const first = await resolveBookStage({
      bookDir,
      bookExists: true,
      bookStatus: "active",
      targetChapters: 200,
      nextChapter: 1,
      chaptersWritten: 0,
    });
    expect(first.stage).toBe("write");
    expect(first.steps.ask).toBe("done");
    expect(first.workflow.groundConfirmedAt).toBeTruthy();
    const saved = JSON.parse(await readFile(join(bookDir, "story", "workflow.json"), "utf-8")) as {
      lastStage?: string;
    };
    expect(saved.lastStage).toBe("write");

    const second = await resolveBookStage({
      bookDir,
      bookExists: true,
      bookStatus: "active",
      targetChapters: 200,
      nextChapter: 1,
      chaptersWritten: 0,
    });
    expect(second.stage).toBe("write");
    expect(second.workflow.groundConfirmedAt).toBe(first.workflow.groundConfirmedAt);
  });
});
