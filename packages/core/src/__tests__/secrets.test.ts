import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { loadSecrets, loadSecretsSync, maskApiKey, saveSecrets, getServiceApiKey } from "../llm/secrets.js";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("secrets", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-secrets-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("loadSecrets", () => {
    it("returns empty when .inkos/secrets.json does not exist", async () => {
      const secrets = await loadSecrets(root);
      expect(secrets).toEqual({ services: {} });
    });

    it("reads existing secrets file", async () => {
      await mkdir(join(root, ".inkos"), { recursive: true });
      await writeFile(
        join(root, ".inkos", "secrets.json"),
        JSON.stringify({ services: { moonshot: { apiKey: "sk-test" } } }),
      );
      const secrets = await loadSecrets(root);
      expect(secrets.services.moonshot.apiKey).toBe("sk-test");
    });
  });

  describe("saveSecrets", () => {
    it("creates .inkos dir and writes secrets file", async () => {
      await saveSecrets(root, {
        services: { deepseek: { apiKey: "sk-deep" } },
      });
      const raw = await readFile(join(root, ".inkos", "secrets.json"), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.services.deepseek.apiKey).toBe("sk-deep");
    });

    it("overwrites existing secrets file", async () => {
      await mkdir(join(root, ".inkos"), { recursive: true });
      await writeFile(
        join(root, ".inkos", "secrets.json"),
        JSON.stringify({ services: { old: { apiKey: "old-key" } } }),
      );
      await saveSecrets(root, {
        services: { new: { apiKey: "new-key" } },
      });
      const secrets = await loadSecrets(root);
      expect(secrets.services.new.apiKey).toBe("new-key");
      expect(secrets.services.old).toBeUndefined();
    });
  });

  describe("getServiceApiKey", () => {
    it("returns key from secrets.json first", async () => {
      await mkdir(join(root, ".inkos"), { recursive: true });
      await writeFile(
        join(root, ".inkos", "secrets.json"),
        JSON.stringify({ services: { moonshot: { apiKey: "sk-from-file" } } }),
      );
      const key = await getServiceApiKey(root, "moonshot");
      expect(key).toBe("sk-from-file");
    });

    it("falls back to environment variable", async () => {
      vi.stubEnv("MOONSHOT_API_KEY", "sk-from-env");
      const key = await getServiceApiKey(root, "moonshot");
      expect(key).toBe("sk-from-env");
      vi.unstubAllEnvs();
    });

    it("returns null when neither secrets nor env exists", async () => {
      const key = await getServiceApiKey(root, "moonshot");
      expect(key).toBeNull();
    });

    it("handles custom service with colon key format", async () => {
      await mkdir(join(root, ".inkos"), { recursive: true });
      await writeFile(
        join(root, ".inkos", "secrets.json"),
        JSON.stringify({
          services: { "custom:内网GPT": { apiKey: "sk-custom" } },
        }),
      );
      const key = await getServiceApiKey(root, "custom:内网GPT");
      expect(key).toBe("sk-custom");
    });
  });

  describe("user-data migration", () => {
    let userDir: string;

    beforeEach(async () => {
      delete process.env.INKOS_USER_DATA;
      userDir = await mkdtemp(join(tmpdir(), "inkos-user-secrets-"));
      await mkdir(join(root, ".inkos"), { recursive: true });
    });

    afterEach(async () => {
      await rm(userDir, { recursive: true, force: true });
    });

    async function seedLegacy(data: unknown): Promise<void> {
      await writeFile(join(root, ".inkos", "secrets.json"), `${JSON.stringify(data, null, 2)}\n`, "utf-8");
    }

    it("moves a project key into the user data file and clears the project copy", async () => {
      await seedLegacy({ services: { deepseek: { apiKey: "sk-move" } } });
      const loaded = await loadSecrets(root, { userDataDir: userDir });
      expect(loaded.services.deepseek?.apiKey).toBe("sk-move");

      const userRaw = await readFile(join(userDir, "secrets.json"), "utf-8");
      expect(JSON.parse(userRaw).services.deepseek.apiKey).toBe("sk-move");
      const legacyRaw = await readFile(join(root, ".inkos", "secrets.json"), "utf-8");
      expect(JSON.parse(legacyRaw).services).toEqual({});
      expect(legacyRaw).not.toContain("sk-move");

      const again = loadSecretsSync(root, { userDataDir: userDir });
      expect(again.services.deepseek?.apiKey).toBe("sk-move");
    });

    it("keeps the user-data key when the project file still has an older copy", async () => {
      await writeFile(
        join(userDir, "secrets.json"),
        `${JSON.stringify({ services: { moonshot: { apiKey: "sk-user" } } }, null, 2)}\n`,
        "utf-8",
      );
      await seedLegacy({
        services: {
          moonshot: { apiKey: "sk-old" },
          deepseek: { apiKey: "sk-legacy" },
        },
      });
      const loaded = await loadSecrets(root, { userDataDir: userDir });
      expect(loaded.services.moonshot?.apiKey).toBe("sk-user");
      expect(loaded.services.deepseek?.apiKey).toBe("sk-legacy");
      const legacyRaw = await readFile(join(root, ".inkos", "secrets.json"), "utf-8");
      expect(legacyRaw).not.toContain("sk-old");
      expect(legacyRaw).not.toContain("sk-legacy");
    });

    it("remaps siliconflow while moving the key out of the project", async () => {
      await seedLegacy({ services: { siliconflow: { apiKey: "sk-sf" } } });
      const loaded = await loadSecrets(root, { userDataDir: userDir });
      expect(loaded.services.siliconcloud?.apiKey).toBe("sk-sf");
      expect(loaded.services.siliconflow).toBeUndefined();
      const userRaw = await readFile(join(userDir, "secrets.json"), "utf-8");
      expect(JSON.parse(userRaw).services.siliconcloud.apiKey).toBe("sk-sf");
      const legacyRaw = await readFile(join(root, ".inkos", "secrets.json"), "utf-8");
      expect(legacyRaw).not.toContain("sk-sf");
    });

    it("does not drop the project key when the user-data folder cannot be written", async () => {
      await seedLegacy({ services: { moonshot: { apiKey: "sk-keep" } } });
      const blocker = join(root, "not-a-directory");
      await writeFile(blocker, "nope", "utf-8");
      const loaded = await loadSecrets(root, { userDataDir: join(blocker, "child") });
      expect(loaded.services.moonshot?.apiKey).toBe("sk-keep");
      const legacyRaw = await readFile(join(root, ".inkos", "secrets.json"), "utf-8");
      expect(legacyRaw).toContain("sk-keep");
      expect(existsSync(join(blocker, "child", "secrets.json"))).toBe(false);
    });

    it("does not overwrite a corrupt project file", async () => {
      const legacyPath = join(root, ".inkos", "secrets.json");
      await writeFile(legacyPath, "{not json", "utf-8");
      await writeFile(
        join(userDir, "secrets.json"),
        `${JSON.stringify({ services: { deepseek: { apiKey: "sk-user" } } }, null, 2)}\n`,
        "utf-8",
      );
      const loaded = await loadSecrets(root, { userDataDir: userDir });
      expect(loaded.services.deepseek?.apiKey).toBe("sk-user");
      expect(await readFile(legacyPath, "utf-8")).toBe("{not json");
    });

    it("saves into the user data file and clears a project copy that was fully kept", async () => {
      await seedLegacy({ services: { moonshot: { apiKey: "sk-old" } } });
      await saveSecrets(root, {
        services: {
          moonshot: { apiKey: "sk-old" },
          deepseek: { apiKey: "sk-new" },
        },
      }, { userDataDir: userDir });
      const userRaw = await readFile(join(userDir, "secrets.json"), "utf-8");
      expect(JSON.parse(userRaw).services.deepseek.apiKey).toBe("sk-new");
      expect(JSON.parse(userRaw).services.moonshot.apiKey).toBe("sk-old");
      const legacyRaw = await readFile(join(root, ".inkos", "secrets.json"), "utf-8");
      expect(JSON.parse(legacyRaw).services).toEqual({});
      expect(legacyRaw).not.toContain("sk-old");
    });

    it("masks a stored key down to the last four characters", () => {
      expect(maskApiKey("sk-moon")).toEqual({ configured: true, last4: "moon" });
      expect(maskApiKey("")).toEqual({ configured: false, last4: "" });
    });
  });
});
