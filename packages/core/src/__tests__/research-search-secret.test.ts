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
    expect(JSON.stringify(view)).not.toContain("tvly-secret-key-1234");
    const inkos = await readFile(join(root, "inkos.json"), "utf-8");
    expect(inkos).not.toContain("tvly-secret-key-1234");
    const runtime = await loadResearchSearchRuntime(root);
    expect(runtime.apiKey).toBe("tvly-secret-key-1234");
    const kept = await saveResearchSearchSettings(root, { enabled: true, provider: "tavily" });
    expect(kept.last4).toBe("1234");
    expect((await loadResearchSearchRuntime(root)).apiKey).toBe("tvly-secret-key-1234");
  });

  it("leaves inkos.json unchanged when the user data folder cannot be written", async () => {
    const root = await project();
    const blocker = join(root, "not-a-dir");
    await writeFile(blocker, "nope", "utf-8");
    process.env.INKOS_USER_DATA = join(blocker, "child");
    const before = await readFile(join(root, "inkos.json"), "utf-8");
    await expect(readResearchSearchPublic(root)).resolves.toMatchObject({ configured: true, last4: "1234" });
    expect(await readFile(join(root, "inkos.json"), "utf-8")).toBe(before);
  });
});
