import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioServer } from "./server.js";

const projectConfig = {
  name: "test",
  version: "0.1.0",
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

const SECRET = "sk-live_abcDEF1234567890";
const SNAPSHOT_KEY = "sk-secretkeyvalue1234";

function runRecord(): Record<string, unknown> {
  return {
    runId: "run-secret",
    stage: "weave",
    operation: "generate",
    roleId: "weave.main",
    status: "failed",
    modelSnapshot: {
      serviceRef: "custom:内网",
      modelId: "m",
      apiKey: SNAPSHOT_KEY,
      token: "tok-should-vanish",
      authorization: "Bearer sent-from-snapshot",
      headers: { Authorization: "Bearer header-secret" },
      extra: {
        temperature: 0.2,
        apiKey: SNAPSHOT_KEY,
        token: "nested-token-value",
        authorization: "Bearer nested",
        headers: { Authorization: "Bearer nested-header" },
      },
    },
    error: `上游拒绝 ${SECRET}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("authoring run responses", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  async function setup(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), "authoring-run-"));
    await mkdir(join(root, "books", "demo", "story", "workflow", "runs"), { recursive: true });
    await writeFile(join(root, "inkos.json"), JSON.stringify(projectConfig, null, 2), "utf-8");
    await writeFile(
      join(root, "books", "demo", "story", "workflow", "runs", "run-secret.json"),
      `${JSON.stringify(runRecord(), null, 2)}\n`,
      "utf-8",
    );
  }

  it("strips secret fields from a single run and redacts sk- text in the error", async () => {
    await setup();
    const app = createStudioServer(projectConfig, root);
    const response = await app.request("/api/v1/authoring/runs/run-secret?bookId=demo");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      modelSnapshot: Record<string, unknown>;
      error?: string;
    };
    expect(body.modelSnapshot).toMatchObject({
      serviceRef: "custom:内网",
      modelId: "m",
      extra: { temperature: 0.2 },
    });
    const snapshot = JSON.stringify(body.modelSnapshot);
    expect(snapshot).not.toMatch(/apiKey|headers|authorization|token|sk-|Bearer|tok-should|nested-token/);
    expect(body.error).toContain("已隐藏");
    expect(body.error).not.toContain(SECRET);
    const stored = await readFile(join(root, "books", "demo", "story", "workflow", "runs", "run-secret.json"), "utf-8");
    expect(stored).toContain(SNAPSHOT_KEY);
    expect(stored).toContain(SECRET);
  });

  it("does not return secret fields when weave continue has nothing left to resume", async () => {
    await setup();
    const app = createStudioServer(projectConfig, root);
    const response = await app.request("/api/v1/authoring/runs/run-secret/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: "demo" }),
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("没有可恢复的范围");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(SNAPSHOT_KEY);
    expect(text).not.toContain("tok-should-vanish");
    expect(text).not.toContain("Bearer header-secret");
    expect(text).not.toContain("nested-token-value");
  });
});
