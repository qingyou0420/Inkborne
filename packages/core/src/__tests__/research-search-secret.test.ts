import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadResearchSearchRuntime,
  readResearchSearchPublic,
  saveResearchSearchSettings,
} from "../llm/research-search-secret.js";

const temps: string[] = [];

afterEach(async () => {
  delete process.env.INKOS_USER_DATA;
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "research-key-"));
  temps.push(root);
  await writeFile(join(root, "inkos.json"), `${JSON.stringify({
    name: "test",
    version: "0.1.0",
    researchSearch: {
      enabled: true,
      provider: "tavily",
      apiKey: "tvly-secret-key-1234",
      apiKeyEnv: "TAVILY_API_KEY",
    },
  }, null, 2)}\n`, "utf-8");
  return root;
}

describe("research search key", () => {
  it("moves the key out of inkos.json and only reports the last four characters", async () => {
    const root = await project();
    const userDir = await mkdtemp(join(tmpdir(), "research-user-"));
    temps.push(userDir);
    process.env.INKOS_USER_DATA = userDir;
    const view = await readResearchSearchPublic(root);
    expect(view.configured).toBe(true);
    expect(view.last4).toBe("1234");
    expect(view.keyStorage).toBe("user-data");
    expect(JSON.stringify(view)).not.toContain("tvly-secret-key-1234");
    const inkos = await readFile(join(root, "inkos.json"), "utf-8");
    expect(inkos).not.toContain("tvly-secret-key-1234");
    const runtime = await loadResearchSearchRuntime(root);
    expect(runtime.apiKey).toBe("tvly-secret-key-1234");
    const kept = await saveResearchSearchSettings(root, { enabled: true, provider: "tavily" });
    expect(kept.last4).toBe("1234");
    expect(kept.keyStorage).toBe("user-data");
    expect((await loadResearchSearchRuntime(root)).apiKey).toBe("tvly-secret-key-1234");
  });

  it("leaves inkos.json unchanged when the user data folder cannot be written", async () => {
    const root = await project();
    const blocker = join(root, "not-a-dir");
    await writeFile(blocker, "nope", "utf-8");
    process.env.INKOS_USER_DATA = join(blocker, "child");
    const before = await readFile(join(root, "inkos.json"), "utf-8");
    await expect(readResearchSearchPublic(root)).resolves.toMatchObject({
      configured: true,
      last4: "1234",
      keyStorage: "project",
    });
    expect(await readFile(join(root, "inkos.json"), "utf-8")).toBe(before);
  });

  it("keeps inkos.json bytes and does not claim the key was migrated when a save cannot write the user directory", async () => {
    const root = await project();
    const blocker = join(root, "not-a-dir");
    await writeFile(blocker, "nope", "utf-8");
    process.env.INKOS_USER_DATA = join(blocker, "child");
    const before = await readFile(join(root, "inkos.json"), "utf-8");
    const view = await saveResearchSearchSettings(root, { enabled: true });
    expect(await readFile(join(root, "inkos.json"), "utf-8")).toBe(before);
    expect(before).toContain("tvly-secret-key-1234");
    expect(view.keyStorage).toBe("project");
    expect(view.keyStorage).not.toBe("user-data");
    expect(view.last4).toBe("1234");
  });

  it("keeps the project apiKey when a non-key change cannot be migrated", async () => {
    const root = await project();
    const blocker = join(root, "not-a-dir");
    await writeFile(blocker, "nope", "utf-8");
    process.env.INKOS_USER_DATA = join(blocker, "child");
    const view = await saveResearchSearchSettings(root, { enabled: false });
    const inkos = await readFile(join(root, "inkos.json"), "utf-8");
    const parsed = JSON.parse(inkos) as { researchSearch: { enabled: boolean; apiKey: string } };
    expect(parsed.researchSearch.apiKey).toBe("tvly-secret-key-1234");
    expect(parsed.researchSearch.enabled).toBe(false);
    expect(view.enabled).toBe(false);
    expect(view.keyStorage).toBe("project");
    expect((await loadResearchSearchRuntime(root)).apiKey).toBe("tvly-secret-key-1234");
  });

  it("rejects a new key when the user directory cannot be written and leaves the old key in place", async () => {
    const root = await project();
    const blocker = join(root, "not-a-dir");
    await writeFile(blocker, "nope", "utf-8");
    process.env.INKOS_USER_DATA = join(blocker, "child");
    const before = await readFile(join(root, "inkos.json"), "utf-8");
    await expect(saveResearchSearchSettings(root, { apiKey: "新假key" })).rejects.toThrow("检索密钥没有写进用户数据目录");
    expect(await readFile(join(root, "inkos.json"), "utf-8")).toBe(before);
    expect(before).toContain("tvly-secret-key-1234");
    expect(before).not.toContain("新假key");
    expect((await loadResearchSearchRuntime(root)).apiKey).toBe("tvly-secret-key-1234");
  });

  it("does not delete a project key that differs from the key already in the user directory", async () => {
    const root = await project();
    const userDir = await mkdtemp(join(tmpdir(), "research-user-"));
    temps.push(userDir);
    process.env.INKOS_USER_DATA = userDir;
    const userKey = "user-dir-key-aaaa";
    await writeFile(join(userDir, "research-search.json"), `${JSON.stringify({ apiKey: userKey }, null, 2)}\n`, "utf-8");
    const before = await readFile(join(root, "inkos.json"), "utf-8");
    await readResearchSearchPublic(root);
    expect(await readFile(join(root, "inkos.json"), "utf-8")).toBe(before);
    expect(before).toContain("tvly-secret-key-1234");
    const stored = JSON.parse(await readFile(join(userDir, "research-search.json"), "utf-8")) as { apiKey: string };
    expect(stored.apiKey).toBe(userKey);
    const view = await saveResearchSearchSettings(root, { enabled: true });
    expect(await readFile(join(root, "inkos.json"), "utf-8")).toBe(before);
    expect(JSON.parse(await readFile(join(userDir, "research-search.json"), "utf-8"))).toMatchObject({ apiKey: userKey });
    expect(view.keyStorage).toBe("user-data");
    expect(view.last4).toBe("aaaa");
    expect((await loadResearchSearchRuntime(root)).apiKey).toBe(userKey);
  });
});
