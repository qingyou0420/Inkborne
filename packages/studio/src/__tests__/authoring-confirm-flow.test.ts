import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioServer } from "../api/server.js";
import { createAndPersistBookSession, loadBookSession, loadStoryGraph } from "@actalk/inkos-core";

// Studio 会把缺 service 的旧配置收成 service "custom"。custom 没有预置
// baseUrl，解析模型时就会抛 "no baseUrl available"。这里写成带地址的命名
// custom 服务，并在 secrets 里放一把假钥匙，让解析走完；真正的模型调用仍由
// INKOS_AGENT_LLM_STUB 拦住，不会打到 example.invalid。
const INKOS_CONFIG = JSON.stringify({
  name: "test-project",
  version: "0.1.0",
  language: "zh",
  llm: {
    provider: "openai",
    service: "custom:Stub",
    configSource: "studio",
    baseUrl: "https://example.invalid/v1",
    model: "test-model",
    apiFormat: "chat",
    stream: true,
    services: [
      { service: "custom", name: "Stub", baseUrl: "https://example.invalid/v1" },
    ],
  },
  notify: [],
});

describe("retired interactive-film-authoring confirmations", () => {
  let root: string;
  const prev = process.env.INKOS_AGENT_LLM_STUB;
  beforeAll(() => { process.env.INKOS_AGENT_LLM_STUB = "1"; });
  afterAll(() => {
    if (prev === undefined) delete process.env.INKOS_AGENT_LLM_STUB;
    else process.env.INKOS_AGENT_LLM_STUB = prev;
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "if-confirm-"));
    await writeFile(join(root, "inkos.json"), INKOS_CONFIG, "utf-8");
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(
      join(root, ".inkos", "secrets.json"),
      JSON.stringify({ services: { "custom:Stub": { apiKey: "sk-test-not-real" } } }),
      "utf-8",
    );
    await mkdir(join(root, "interactive-films", "p"), { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("rejects free-text and saved confirmations without producing a graph or changing history", async () => {
    const app = createStudioServer({} as never, root);
    const sessionId = "1000000000-test";
    const bookId = "p";

    // Historical sessions remain readable even though new production is retired.
    await createAndPersistBookSession(root, bookId, sessionId, "interactive-film-authoring");
    const originalSession = await loadBookSession(root, sessionId);

    const propose = await app.request("/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "帮我搭一个三幕结构",
        activeBookId: bookId,
        sessionKind: "interactive-film-authoring",
        actionSource: "free-text",
        sessionId,
      }),
    });
    expect(propose.status).toBe(410);
    await expect(propose.json()).resolves.toMatchObject({ error: { code: "FEATURE_RETIRED" } });

    // A confirmation card saved before retirement cannot restart the old task.
    const confirm = await app.request("/api/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "搭建三幕分支结构",
        activeBookId: bookId,
        sessionKind: "interactive-film-authoring",
        actionSource: "button",
        requestedIntent: "draft_structure",
        actionPayload: { draftStructure: { instruction: "三幕分支结构", projectId: bookId } },
        sessionId,
      }),
    });
    expect(confirm.status).toBe(410);
    await expect(confirm.json()).resolves.toMatchObject({ error: { code: "FEATURE_RETIRED" } });

    expect(await loadStoryGraph(root, bookId)).toBeNull();
    expect(await loadBookSession(root, sessionId)).toEqual(originalSession);
    const history = await app.request(`/api/v1/sessions/${sessionId}`);
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toMatchObject({ session: { sessionId, bookId, sessionKind: "interactive-film-authoring" } });
  });
});
