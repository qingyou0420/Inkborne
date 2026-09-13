/**
 * Desktop project-root helpers. The engine must receive an explicit root;
 * this module never uses process.cwd() as the product root.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_FOLDER = "幻想作家";

function defaultProjectRoot(documentsDir) {
  const documents = documentsDir || path.join(os.homedir(), "Documents");
  return path.join(documents, DEFAULT_FOLDER);
}

/** Return a saved root only when inkos.json is already there. */
function resolveSavedProjectRoot(savedRoot) {
  const saved = String(savedRoot || "").trim();
  if (!isAbsoluteRoot(saved)) return "";
  const resolved = path.resolve(saved);
  try {
    if (fs.existsSync(path.join(resolved, "inkos.json"))) return resolved;
  } catch {
    return "";
  }
  return "";
}

function isAbsoluteRoot(root) {
  const value = String(root || "").trim();
  if (!value) return false;
  return path.isAbsolute(value);
}

function ensureProjectLayout(root) {
  if (!isAbsoluteRoot(root)) {
    throw new Error("Project root must be an absolute path");
  }
  const resolved = path.resolve(root);
  fs.mkdirSync(path.join(resolved, "books"), { recursive: true });
  fs.mkdirSync(path.join(resolved, ".inkos"), { recursive: true });

  const configPath = path.join(resolved, "inkos.json");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          name: path.basename(resolved) || "幻想作家",
          version: "0.1.0",
          language: "zh",
          llm: {
            provider: "openai",
            service: "custom",
            configSource: "studio",
            baseUrl: "",
            model: "",
            apiFormat: "chat",
            stream: true,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  const gitignorePath = path.join(resolved, ".gitignore");
  const required = [".env", ".inkos/secrets.json", "node_modules/", ".DS_Store"];
  let existing = "";
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, "utf8");
  }
  const have = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
  const missing = required.filter((entry) => !have.has(entry));
  if (!existing) {
    fs.writeFileSync(gitignorePath, `${required.join("\n")}\n`, "utf8");
  } else if (missing.length) {
    const sep = existing.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(gitignorePath, `${existing}${sep}${missing.join("\n")}\n`, "utf8");
  }
  return resolved;
}

const DEFAULT_CUSTOM_SERVICE_NAME = "自定义";

function customServiceName(name) {
  const trimmed = String(name || "").trim();
  return trimmed || DEFAULT_CUSTOM_SERVICE_NAME;
}

/** Studio lists custom endpoints as `custom:${name}` and looks up secrets by that id. */
function customServiceId(name) {
  return `custom:${customServiceName(name)}`;
}

function normalizeServicesArray(raw) {
  if (Array.isArray(raw)) {
    return raw.filter((entry) => entry && typeof entry === "object");
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([id, value]) => {
      const body = value && typeof value === "object" ? value : {};
      if (id.startsWith("custom:")) {
        return { ...body, service: "custom", name: id.slice("custom:".length) };
      }
      return { ...body, service: id };
    });
  }
  return [];
}

function upsertCustomService(services, entry) {
  const id = customServiceId(entry.name);
  const next = [];
  let replaced = false;
  for (const svc of services) {
    const svcId = svc.service === "custom" ? `custom:${svc.name ?? ""}` : String(svc.service || "");
    if (svcId === id) {
      next.push({ ...svc, ...entry });
      replaced = true;
    } else {
      next.push(svc);
    }
  }
  if (!replaced) next.push(entry);
  return next;
}

function writeSecrets(root, service, apiKey) {
  const dir = path.join(root, ".inkos");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "secrets.json");
  let data = { services: {} };
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data || typeof data !== "object" || !data.services) data = { services: {} };
    } catch {
      data = { services: {} };
    }
  }
  const id = String(service || "").trim() || customServiceId();
  const key = String(apiKey || "").trim();
  if (key) data.services[id] = { apiKey: key };
  else delete data.services[id];
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return file;
}

function writeProjectLlm(root, opts) {
  const configPath = path.join(root, "inkos.json");
  let raw = {};
  if (fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  const name = customServiceName(opts && opts.name);
  const serviceId = customServiceId(name);
  const baseUrl = String((opts && opts.baseUrl) || "").trim();
  const model = String((opts && opts.model) || "").trim();
  const previous = raw.llm && typeof raw.llm === "object" ? raw.llm : {};
  const entry = {
    service: "custom",
    name,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { models: [model] } : {}),
  };
  raw.name = raw.name || path.basename(root) || "幻想作家";
  raw.version = raw.version || "0.1.0";
  raw.language = raw.language || "zh";
  raw.llm = {
    ...previous,
    provider: "openai",
    service: serviceId,
    configSource: "studio",
    baseUrl,
    model,
    defaultModel: model,
    apiFormat: "chat",
    stream: true,
    services: upsertCustomService(normalizeServicesArray(previous.services), entry),
  };
  fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return { configPath, serviceId, name };
}

/**
 * First-run writes a Studio-listable custom service + project secret.
 * Does not write ~/.inkos/.env, project .env, or INKOS_LLM_* keys.
 */
function saveFirstRunLlm(root, opts) {
  const written = writeProjectLlm(root, opts);
  const secretsPath = writeSecrets(root, written.serviceId, opts && opts.apiKey);
  return { ...written, secretsPath };
}

/**
 * Mirrors Studio GET /api/v1/services custom-entry listing:
 * only named `llm.services[]` items appear, as `custom:${name}`,
 * and they are connected when secrets.services[that id] has an apiKey.
 */
function listStudioCustomServices(llm, secrets) {
  const services = Array.isArray(llm && llm.services) ? llm.services : [];
  const secretMap = secrets && secrets.services && typeof secrets.services === "object" ? secrets.services : {};
  const listed = [];
  for (const svc of services) {
    if (!svc || svc.service !== "custom") continue;
    const secretKey = `custom:${svc.name}`;
    listed.push({
      service: secretKey,
      label: svc.name ?? "Custom",
      connected: Boolean(secretMap[secretKey] && secretMap[secretKey].apiKey),
    });
  }
  return listed;
}

module.exports = {
  DEFAULT_FOLDER,
  DEFAULT_CUSTOM_SERVICE_NAME,
  defaultProjectRoot,
  resolveSavedProjectRoot,
  isAbsoluteRoot,
  ensureProjectLayout,
  customServiceName,
  customServiceId,
  writeSecrets,
  writeProjectLlm,
  saveFirstRunLlm,
  listStudioCustomServices,
};
