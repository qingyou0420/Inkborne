import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "@actalk/inkos-core";
import { createStudioServer } from "./server.js";

const projectConfig = {
  name: "test",
  language: "zh",
  llm: {
    provider: "custom",
    service: "custom",
    configSource: "studio",
    baseUrl: "https://example.invalid",
    model: "test-model",
    apiFormat: "chat",
    stream: true,
  },
} as never;

describe("P0 lock + truth PUT", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fw-lock-"));
    await mkdir(join(root, "books", "demo-book", "story"), { recursive: true });
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(
      join(root, "inkos.json"),
      JSON.stringify({
        name: "test",
        language: "zh",
        llm: {
          provider: "openai",
          service: "custom",
          configSource: "studio",
          baseUrl: "https://example.invalid",
          model: "test-model",
          apiFormat: "chat",
          stream: true,
        },
      }, null, 2),
      "utf-8",
    );
    await writeFile(
      join(root, ".inkos", "secrets.json"),
      JSON.stringify({ services: { custom: { apiKey: "sk-test" } } }, null, 2),
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("exposes health and refuses a busy truth PUT until force-release", async () => {
    const app = createStudioServer(projectConfig, root);
    const health = await app.request("/api/v1/health");
    expect(health.status).toBe(200);
    const healthBody = await health.json() as { ok: boolean; projectRoot: string };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.projectRoot).toBe(root);

    const first = await app.request("/api/v1/books/demo-book/truth/author_intent.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# intent\n" }),
    });
    expect(first.status).toBe(200);

    const state = new StateManager(root);
    const release = await state.acquireBookLock("demo-book", {
      taskId: "hung-write",
      stage: "write",
    });
    try {
      const busy = await app.request("/api/v1/books/demo-book/truth/author_intent.md", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# stolen\n" }),
      });
      expect(busy.status).toBe(409);
      const body = await busy.json() as {
        error: { code: string; message: string; owner?: { taskId?: string } };
      };
      expect(body.error.code).toBe("BOOK_BUSY");
      expect(body.error.message).toContain("写入被占用");
      expect(body.error.owner?.taskId).toBe("hung-write");

      const forced = await app.request("/api/v1/books/demo-book/truth/../lock".replace("truth/../", ""), {
        method: "GET",
      });
      void forced;
      const inspect = await app.request("/api/v1/books/demo-book/lock");
      expect(inspect.status).toBe(200);
      expect((await inspect.json() as { locked: boolean }).locked).toBe(true);

      const released = await app.request("/api/v1/books/demo-book/lock/force-release", {
        method: "POST",
      });
      expect(released.status).toBe(200);
      expect((await released.json() as { released: boolean }).released).toBe(true);

      const retry = await app.request("/api/v1/books/demo-book/truth/author_intent.md", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# after release\n" }),
      });
      expect(retry.status).toBe(200);
    } finally {
      await release();
    }
  });

  it("write-next returns BOOK_BUSY naming the holder", async () => {
    const app = createStudioServer(projectConfig, root);
    const state = new StateManager(root);
    const release = await state.acquireBookLock("demo-book", {
      taskId: "other-write",
      stage: "draft",
    });
    try {
      const busy = await app.request("/api/v1/books/demo-book/write-next", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(busy.status).toBe(409);
      const body = await busy.json() as {
        error: { code: string; message: string; owner?: { taskId?: string; stage?: string } };
      };
      expect(body.error.code).toBe("BOOK_BUSY");
      expect(body.error.owner?.taskId).toBe("other-write");
      expect(body.error.owner?.stage).toBe("draft");
      expect(body.error.message).toContain("写入被占用");
    } finally {
      await release();
    }
  });

  it("draft returns BOOK_BUSY naming the holder", async () => {
    const app = createStudioServer(projectConfig, root);
    const state = new StateManager(root);
    const release = await state.acquireBookLock("demo-book", {
      taskId: "other-draft",
      stage: "write-next",
    });
    try {
      const busy = await app.request("/api/v1/books/demo-book/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(busy.status).toBe(409);
      const body = await busy.json() as {
        error: { code: string; message: string; owner?: { taskId?: string; stage?: string } };
      };
      expect(body.error.code).toBe("BOOK_BUSY");
      expect(body.error.owner?.taskId).toBe("other-draft");
      expect(body.error.owner?.stage).toBe("write-next");
      expect(body.error.message).toContain("写入被占用");
    } finally {
      await release();
    }
  });

  it("clears leftover in-process lock on delete so a recreated book can write", async () => {
    const app = createStudioServer(projectConfig, root);
    const state = new StateManager(root);
    const release = await state.acquireBookLock("demo-book", {
      taskId: "leftover-after-delete",
      stage: "write-next",
    });
    try {
      const deleted = await app.request("/api/v1/books/demo-book", { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(state.inspectBookLock("demo-book")).toBeNull();

      await mkdir(join(root, "books", "demo-book", "story"), { recursive: true });
      const retry = await app.request("/api/v1/books/demo-book/truth/author_intent.md", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# after recreate\n" }),
      });
      expect(retry.status).toBe(200);
    } finally {
      await release();
    }
  });

  it("restores a chapter version under the real book lock and binds the candidate", async () => {
    const app = createStudioServer(projectConfig, root);
    const bookDir = join(root, "books", "demo-book");
    await mkdir(join(bookDir, "chapters", ".versions", "0003"), { recursive: true });
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: "demo-book",
      title: "试",
      language: "zh",
      genre: "general",
      platform: "other",
      status: "writing",
      targetChapters: 10,
      chapterWordCount: 3000,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }), "utf-8");
    await writeFile(join(bookDir, "chapters", "0003_雨.md"), "现在的正文\n", "utf-8");
    await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([{
      number: 3,
      title: "雨",
      status: "approved",
      wordCount: 5,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]), "utf-8");
    const versionId = `${Date.now()}_restore_${randomUUID()}`;
    await writeFile(join(bookDir, "chapters", ".versions", "0003", `${versionId}.md`), "恢复的正文\n", "utf-8");

    const restored = await app.request(
      `/api/v1/books/demo-book/chapters/3/versions/${versionId}/restore`,
      { method: "POST" },
    );
    const restoredBody = await restored.json() as { error?: unknown; ok?: boolean };
    expect(restored.status, JSON.stringify(restoredBody)).toBe(200);
    expect(await readFile(join(bookDir, "chapters", "0003_雨.md"), "utf-8")).toContain("恢复的正文");
    const workflow = await readdir(join(bookDir, "story", "workflow", "artifacts"));
    expect(workflow.length).toBeGreaterThan(0);

    const state = new StateManager(root);
    const release = await state.acquireBookLock("demo-book", {
      taskId: "held-during-restore",
      stage: "落笔",
      abort: new AbortController(),
    });
    try {
      const busy = await app.request(
        `/api/v1/books/demo-book/chapters/3/versions/${versionId}/restore`,
        { method: "POST" },
      );
      const busyBody = await busy.json() as { error?: { message?: string; code?: string } | string };
      expect(busy.status).toBe(409);
      const message = typeof busyBody.error === "string" ? busyBody.error : busyBody.error?.message ?? "";
      expect(message).toContain("写入被占用");
      expect(message).not.toMatch(/BookWriteLockError|locked by an active/);
    } finally {
      await release();
    }
  });

  it("autosaves chapter text without marking it audit-failed and keeps the original version", async () => {
    const app = createStudioServer(projectConfig, root);
    const bookDir = join(root, "books", "demo-book");
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await mkdir(join(bookDir, "story", "runtime"), { recursive: true });
    await writeFile(join(bookDir, "story", "runtime", "chapter-0004.plan.md"), "不要清掉\n", "utf-8");
    await writeFile(join(bookDir, "chapters", "0004_雪.md"), "旧雪\n", "utf-8");
    await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([{
      number: 4,
      title: "雪",
      status: "approved",
      wordCount: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]), "utf-8");
    const first = await app.request("/api/v1/books/demo-book/chapters/4", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "第一次停笔", autosave: true }),
    });
    expect(first.status).toBe(200);
    const second = await app.request("/api/v1/books/demo-book/chapters/4", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "第二次停笔", autosave: true }),
    });
    expect(second.status).toBe(200);
    const index = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8")) as Array<{
      status: string;
      auditIssues: string[];
    }>;
    expect(index[0]?.status).toBe("approved");
    expect(JSON.stringify(index)).not.toContain("Manual chapter replacement");
    expect(await readFile(join(bookDir, "chapters", "0004_雪.md"), "utf-8")).toContain("第二次停笔");
    expect(await readFile(join(bookDir, "story", "runtime", "chapter-0004.plan.md"), "utf-8")).toContain("不要清掉");
    const versions = await readdir(join(bookDir, "chapters", ".versions", "0004"));
    const files = versions.filter((file) => file.endsWith(".md"));
    expect(files).toHaveLength(2);
    const baseline = files.find((file) => file.includes("_manual_"));
    expect(baseline).toBeTruthy();
    expect(await readFile(join(bookDir, "chapters", ".versions", "0004", baseline!), "utf-8")).toBe("旧雪\n");
    const saved = await app.request("/api/v1/books/demo-book/chapters/4", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "显式保存" }),
    });
    expect(saved.status).toBe(200);
    const reviewed = JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf-8")) as Array<{
      status: string;
      auditIssues: string[];
    }>;
    expect(reviewed[0]?.status).toBe("audit-failed");
    expect(reviewed[0]?.auditIssues.join("\n")).toContain("Manual chapter replacement");
    await expect(readFile(join(bookDir, "story", "runtime", "chapter-0004.plan.md"), "utf-8")).rejects.toThrow();
  });
});
