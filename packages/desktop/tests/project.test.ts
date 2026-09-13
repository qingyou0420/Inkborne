import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  defaultProjectRoot,
  resolveSavedProjectRoot,
  isAbsoluteRoot,
  ensureProjectLayout,
  writeSecrets,
  writeProjectLlm,
  saveFirstRunLlm,
  listStudioCustomServices,
  customServiceId,
} = require("../lib/project.cjs") as {
  defaultProjectRoot: (documentsDir?: string) => string;
  resolveSavedProjectRoot: (savedRoot?: string) => string;
  isAbsoluteRoot: (root: string) => boolean;
  ensureProjectLayout: (root: string) => string;
  writeSecrets: (root: string, service: string, apiKey: string) => string;
  writeProjectLlm: (root: string, opts: { name?: string; baseUrl: string; model: string }) => {
    configPath: string;
    serviceId: string;
    name: string;
  };
  saveFirstRunLlm: (root: string, opts: { name?: string; baseUrl: string; model: string; apiKey: string }) => {
    configPath: string;
    secretsPath: string;
    serviceId: string;
    name: string;
  };
  listStudioCustomServices: (
    llm: { services?: Array<{ service: string; name?: string }> },
    secrets: { services?: Record<string, { apiKey?: string }> },
  ) => Array<{ service: string; label: string; connected: boolean }>;
  customServiceId: (name?: string) => string;
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("defaultProjectRoot", () => {
  it("uses Documents/幻想作家 and never process.cwd()", () => {
    const root = defaultProjectRoot("/Users/me/Documents");
    expect(root).toBe(join("/Users/me/Documents", "幻想作家"));
    expect(root).not.toBe(process.cwd());
  });
});

describe("resolveSavedProjectRoot", () => {
  it("returns empty when the saved folder has no inkos.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-missing-inkos-"));
    temps.push(dir);
    expect(resolveSavedProjectRoot(dir)).toBe("");
    expect(resolveSavedProjectRoot("relative")).toBe("");
  });

  it("returns the folder when inkos.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-has-inkos-"));
    temps.push(dir);
    writeFileSync(join(dir, "inkos.json"), "{\"name\":\"x\"}\n", "utf8");
    expect(resolveSavedProjectRoot(dir)).toBe(dir);
  });
});

describe("ensureProjectLayout", () => {
  it("refuses a relative root", () => {
    expect(() => ensureProjectLayout("relative/path")).toThrow(/absolute/);
  });

  it("creates the standard InkOS layout", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-proj-"));
    temps.push(dir);
    const root = ensureProjectLayout(dir);
    const config = JSON.parse(readFileSync(join(root, "inkos.json"), "utf8")) as {
      language: string;
    };
    expect(config.language).toBe("zh");
    const written = writeProjectLlm(root, { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" });
    writeSecrets(root, written.serviceId, "sk-test");
    const secrets = JSON.parse(readFileSync(join(root, ".inkos", "secrets.json"), "utf8")) as {
      services: Record<string, { apiKey: string }>;
    };
    expect(written.serviceId).toBe("custom:自定义");
    expect(secrets.services["custom:自定义"].apiKey).toBe("sk-test");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".inkos/secrets.json");
    expect(isAbsoluteRoot(root)).toBe(true);
  });
});

describe("first-run Studio service listing", () => {
  it("writes inkos.json + secrets.json that Studio GET /api/v1/services would list", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-first-run-"));
    temps.push(dir);
    const root = ensureProjectLayout(dir);
    const written = saveFirstRunLlm(root, {
      name: "自定义",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "sk-test",
    });

    expect(written.serviceId).toBe(customServiceId("自定义"));
    expect(written.serviceId).toBe("custom:自定义");

    const inkos = JSON.parse(readFileSync(join(root, "inkos.json"), "utf8")) as {
      llm: {
        service: string;
        configSource: string;
        baseUrl: string;
        model: string;
        defaultModel: string;
        services: Array<{ service: string; name: string; baseUrl?: string; models?: string[] }>;
      };
    };
    const secrets = JSON.parse(readFileSync(join(root, ".inkos", "secrets.json"), "utf8")) as {
      services: Record<string, { apiKey: string }>;
    };

    expect(inkos.llm.service).toBe("custom:自定义");
    expect(inkos.llm.configSource).toBe("studio");
    expect(inkos.llm.services).toEqual([
      {
        service: "custom",
        name: "自定义",
        baseUrl: "https://api.deepseek.com",
        models: ["deepseek-v4-pro"],
      },
    ]);
    expect(secrets.services["custom:自定义"]?.apiKey).toBe("sk-test");
    expect(secrets.services.custom).toBeUndefined();

    const listed = listStudioCustomServices(inkos.llm, secrets);
    expect(listed).toEqual([
      { service: "custom:自定义", label: "自定义", connected: true },
    ]);

    expect(existsSync(join(root, ".env"))).toBe(false);
    expect(JSON.stringify(inkos)).not.toMatch(/INKOS_LLM_/);
  });

  it("uses a wizard name in the Studio secret id", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-named-"));
    temps.push(dir);
    const root = ensureProjectLayout(dir);
    saveFirstRunLlm(root, {
      name: "我家网关",
      baseUrl: "https://llm.example.com/v1",
      model: "local-chat",
      apiKey: "sk-home",
    });
    const inkos = JSON.parse(readFileSync(join(root, "inkos.json"), "utf8"));
    const secrets = JSON.parse(readFileSync(join(root, ".inkos", "secrets.json"), "utf8"));
    expect(listStudioCustomServices(inkos.llm, secrets)).toEqual([
      { service: "custom:我家网关", label: "我家网关", connected: true },
    ]);
  });

  it("appends a named custom service without dropping existing ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-append-"));
    temps.push(dir);
    const root = ensureProjectLayout(dir);
    writeFileSync(
      join(root, "inkos.json"),
      `${JSON.stringify({
        name: "幻想作家",
        language: "zh",
        llm: {
          services: [{ service: "custom", name: "内网GPT", baseUrl: "https://llm.internal.corp/v1" }],
        },
      }, null, 2)}\n`,
      "utf8",
    );
    saveFirstRunLlm(root, {
      name: "自定义",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      apiKey: "sk-test",
    });
    const inkos = JSON.parse(readFileSync(join(root, "inkos.json"), "utf8"));
    const secrets = JSON.parse(readFileSync(join(root, ".inkos", "secrets.json"), "utf8"));
    expect(inkos.llm.services.map((svc: { name: string }) => svc.name)).toEqual(["内网GPT", "自定义"]);
    expect(listStudioCustomServices(inkos.llm, secrets)).toEqual([
      { service: "custom:内网GPT", label: "内网GPT", connected: false },
      { service: "custom:自定义", label: "自定义", connected: true },
    ]);
  });

  it("does not treat a bare llm.service=custom secret as listable", () => {
    const listed = listStudioCustomServices(
      { service: "custom", configSource: "studio" } as never,
      { services: { custom: { apiKey: "sk-hidden" } } },
    );
    expect(listed).toEqual([]);
  });
});
