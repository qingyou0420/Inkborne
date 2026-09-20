/**
 * 幻想作家 desktop shell: single-instance Electron + InkOS Studio engine child.
 * Modified 2026-09-01 for FantaWriter 2.0 P0 (AGPL-3.0).
 */
const { app, BrowserWindow, shell, dialog, ipcMain, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const { defaultProjectRoot, ensureProjectLayout, resolveSavedProjectRoot, saveFirstRunLlm } = require("./lib/project.cjs");
const { HOST, SCAN_START, normalizePinnedPort, pickListenPort, canBindPort } = require("./lib/port.cjs");
const {
  emptyEngineHandle,
  hasLiveEngine,
  engineKillPid,
  adoptEngine,
  attachSpawnedEngine,
  clearEngineHandle,
} = require("./lib/engine-handle.cjs");
const { versionFromSetupName, setupFileNameForVersion } = require("./lib/setup-artifact.cjs");
const {
  DEFAULT_GITHUB_REPO,
  githubLatestApiUrl,
  githubApiHeaders,
  githubAssetHeaders,
  isGithubApiHost,
  isAllowedDownloadUrl,
  parseGithubLatestRelease,
  setupFileNameFromUrl,
  githubCheckErrorMessage,
} = require("./lib/github-release.cjs");
const {
  collectUpdateSearchDirs,
  parseCheckUpdateRequest,
  checkUpdateSources,
} = require("./lib/update-search.cjs");
const { resolveStudioEntry, resolveEngineRoot } = require("./lib/studio-entry.cjs");

app.setName("fantawriter");
app.setPath("userData", path.join(app.getPath("appData"), "fantawriter"));
if (process.platform === "win32") {
  app.setAppUserModelId("com.fantawriter.app");
}

const GITHUB_UPDATE_TOKEN_KEY = "GITHUB_UPDATE_TOKEN";
const LOG_MAX_BYTES = 512 * 1024;

/** @type {import('child_process').ChildProcess | null} */
let engineProcess = null;
/** @type {{ child: import('child_process').ChildProcess | null, pid: number, port: number, token: string }} */
let engineHandle = emptyEngineHandle();
/** @type {BrowserWindow | null} */
let mainWindow = null;
let quitting = false;
let instanceToken = "";
let projectRoot = "";
let enginePort = 0;
/** @type {string[]} */
const serverLog = [];

function isDev() {
  return !app.isPackaged;
}

function workspaceRoot() {
  return path.resolve(__dirname, "..", "..");
}

function getConfigPath() {
  return path.join(app.getPath("userData"), "config.env");
}

function getLogPath() {
  return path.join(app.getPath("userData"), "server.log");
}

function appendLog(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  serverLog.push(text);
  if (serverLog.length > 500) serverLog.shift();
  try {
    fs.appendFileSync(getLogPath(), `${text}\n`, "utf8");
  } catch {
    /* ignore */
  }
  console.log(line);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readConfigMap(filePath) {
  const map = new Map();
  if (!filePath || !fs.existsSync(filePath)) return map;
  try {
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
    }
  } catch {
    /* ignore */
  }
  return map;
}

function writeConfigMap(filePath, map) {
  ensureDir(path.dirname(filePath));
  const lines = [
    "# FantaWriter · 本机壳配置（由应用写入，请勿分享）",
    ...[...map.entries()].map(([k, v]) => `${k}=${v}`),
    "",
  ];
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  if (process.platform === "win32") {
    const user = process.env.USERNAME || process.env.USER || "";
    if (user) {
      execFile("icacls", [filePath, "/inheritance:r", "/grant:r", `${user}:F`], { windowsHide: true }, () => {});
    }
  }
}

function applyConfigFile(filePath) {
  for (const [key, value] of readConfigMap(filePath)) {
    process.env[key] = value;
  }
}

function loadShellConfig() {
  applyConfigFile(getConfigPath());
  const map = readConfigMap(getConfigPath());
  return {
    projectRoot: (map.get("INKOS_PROJECT_ROOT") || process.env.INKOS_PROJECT_ROOT || "").trim(),
    enginePort: normalizePinnedPort(map.get("APP_DATA_PORT") || process.env.APP_DATA_PORT),
    instanceToken: (map.get("FW_INSTANCE_TOKEN") || "").trim(),
    firstRunDone: map.get("FW_FIRST_RUN_DONE") === "1",
  };
}

function saveShellConfig(partial) {
  const map = readConfigMap(getConfigPath());
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined || value === null || value === "") map.delete(key);
    else map.set(key, String(value));
  }
  writeConfigMap(getConfigPath(), map);
  applyConfigFile(getConfigPath());
}

function studioEntry() {
  return resolveStudioEntry({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    desktopDir: __dirname,
    workspaceRoot: workspaceRoot(),
  });
}

function engineEnv(listenPort, root) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: app.isPackaged ? "production" : (process.env.NODE_ENV || "development"),
    INKOS_DESKTOP: "1",
    FW_REQUIRE_EXPLICIT_ROOT: "1",
    INKOS_PROJECT_ROOT: root,
    INKOS_STUDIO_PORT: String(listenPort),
    FW_INSTANCE_TOKEN: instanceToken,
    INKOS_DISABLE_VITE_BUILD: "1",
    INKOS_PACKAGED: app.isPackaged ? "1" : "0",
  };
}

function waitForHealth(baseUrl, token, timeoutMs = 90000) {
  const start = Date.now();
  const healthUrl = `${baseUrl.replace(/\/$/, "")}/api/v1/health`;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (engineProcess && engineProcess.exitCode !== null) {
        reject(new Error(`引擎已退出（代码 ${engineProcess.exitCode}）`));
        return;
      }
      const req = http.get(healthUrl, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          try {
            const data = JSON.parse(body);
            if (data && data.ok === true) {
              if (token && data.instanceToken && data.instanceToken !== token) {
                reject(new Error("PORT_TOKEN_MISMATCH"));
                return;
              }
              resolve(data);
              return;
            }
          } catch {
            /* retry */
          }
          retry(`健康检查未通过（HTTP ${res.statusCode}）`);
        });
      });
      req.on("error", () => retry("连接未就绪"));
      req.setTimeout(1500, () => {
        req.destroy();
        retry("健康检查超时");
      });
    };
    const retry = (why) => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`等待引擎超时：${healthUrl}\n${why}\n日志：${getLogPath()}`));
        return;
      }
      setTimeout(tryOnce, 400);
    };
    tryOnce();
  });
}

function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${port}/api/v1/health`, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(null);
    });
  });
}

function startEngine(listenPort, root) {
  const entry = studioEntry();
  if (!entry) {
    throw new Error(
      "找不到墨生万象引擎入口 packages/studio/dist/api/index.js。请先运行 pnpm build。",
    );
  }
  const engineRoot = resolveEngineRoot(entry) || path.dirname(entry);
  appendLog(`engine entry=${entry}`);
  appendLog(`engineRoot=${engineRoot}`);
  appendLog(`projectRoot=${root}`);
  appendLog(`enginePort=${listenPort}`);

  const child = spawn(process.execPath, [entry, root], {
    cwd: engineRoot,
    env: engineEnv(listenPort, root),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  engineProcess = child;
  attachSpawnedEngine(engineHandle, child, listenPort, instanceToken);
  child.stdout?.on("data", (d) => appendLog(`[engine] ${d.toString().trim()}`));
  child.stderr?.on("data", (d) => appendLog(`[engine] ${d.toString().trim()}`));
  child.on("exit", (code, signal) => {
    appendLog(`engine exited code=${code} signal=${signal}`);
    if (engineProcess === child) engineProcess = null;
    if (engineHandle.child === child) clearEngineHandle(engineHandle);
    if (!quitting && code && code !== 0) {
      dialog.showErrorBox("引擎已退出", `墨生万象引擎子进程退出（${code}）。\n日志：${getLogPath()}`);
    }
  });
  return `http://${HOST}:${listenPort}`;
}

function postJson(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.request(url, { method: "POST", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.end();
  });
}

async function stopEngine({ graceful = true } = {}) {
  if (!hasLiveEngine(engineHandle) && !engineProcess) return;
  const child = engineHandle.child || engineProcess;
  const port = engineHandle.port || enginePort;
  const pid = engineKillPid(engineHandle) || child?.pid || 0;
  if (graceful && port) {
    try {
      await postJson(`http://${HOST}:${port}/api/v1/engine/shutdown`, 4000);
      await new Promise((resolve) => setTimeout(resolve, 600));
    } catch {
      /* still kill */
    }
  }
  try {
    if (process.platform === "win32" && pid) {
      spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true });
    } else if (child && child.kill) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (child.exitCode === null) child.kill("SIGKILL");
    } else if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* ignore */
  }
  engineProcess = null;
  enginePort = 0;
  clearEngineHandle(engineHandle);
}

function provisionProjectRoot(cfg) {
  const existing = resolveSavedProjectRoot(cfg.projectRoot);
  if (existing) return existing;
  const root = ensureProjectLayout(defaultProjectRoot(tryAppPath("documents") || undefined));
  saveShellConfig({
    INKOS_PROJECT_ROOT: root,
    FW_FIRST_RUN_DONE: "1",
  });
  appendLog(`auto projectRoot=${root}`);
  return root;
}

async function resolveEngineUrl() {
  const shellCfg = loadShellConfig();
  projectRoot = provisionProjectRoot(shellCfg);
  ensureProjectLayout(projectRoot);
  if (!shellCfg.instanceToken) {
    instanceToken = crypto.randomUUID();
    saveShellConfig({ FW_INSTANCE_TOKEN: instanceToken });
  } else {
    instanceToken = shellCfg.instanceToken;
  }

  let port = shellCfg.enginePort;
  if (port) {
    const existing = await probeHealth(port);
    if (existing?.ok && existing.instanceToken === instanceToken) {
      appendLog(`接管已有引擎 port=${port} pid=${existing.pid}`);
      enginePort = port;
      adoptEngine(engineHandle, existing, port);
      engineProcess = null;
      return `http://${HOST}:${port}`;
    }
    if (existing?.ok && existing.instanceToken !== instanceToken) {
      appendLog(`端口 ${port} 被其它引擎占用，改钉新端口`);
      port = await pickListenPort(SCAN_START);
      saveShellConfig({ APP_DATA_PORT: String(port) });
    } else if (!(await canBindPort(port))) {
      throw new Error(`已固定端口 ${port} 被占用。请关闭占用程序后重试。`);
    }
  } else {
    port = await pickListenPort(SCAN_START);
    saveShellConfig({ APP_DATA_PORT: String(port) });
  }
  enginePort = port;
  const url = startEngine(port, projectRoot);
  await waitForHealth(url, instanceToken);
  return url;
}

function createWindow(targetUrl) {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    title: "墨生万象 / Inkborne",
    icon: path.join(__dirname, process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.loadURL(targetUrl.startsWith("http") || targetUrl.startsWith("file:")
    ? targetUrl
    : `file://${targetUrl}`);
  mainWindow.webContents.on("did-finish-load", () => {
    const url = mainWindow?.webContents.getURL() || "";
    if (!url.startsWith("http")) return;
    studioHasUpdateBridge().then((has) => {
      appendLog(has
        ? "Studio 页可访问 window.fantaWriter.checkUpdate"
        : "Studio 页没有 fantaWriter 桥；请用菜单「帮助 → 检查更新」打开独立更新窗");
    }).catch(() => undefined);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function firstRunFileUrl() {
  return `file://${path.join(__dirname, "first-run.html")}`;
}

/** @type {Electron.BrowserWindow | null} */
let updatePanelWindow = null;

function updatePanelFileUrl() {
  return `file://${path.join(__dirname, "update-panel.html")}`;
}

function openUpdatePanel() {
  if (updatePanelWindow && !updatePanelWindow.isDestroyed()) {
    updatePanelWindow.focus();
    return { ok: true };
  }
  updatePanelWindow = new BrowserWindow({
    width: 540,
    height: 580,
    parent: mainWindow || undefined,
    modal: false,
    autoHideMenuBar: true,
    title: "检查更新",
    icon: path.join(__dirname, process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  updatePanelWindow.loadURL(updatePanelFileUrl());
  updatePanelWindow.on("closed", () => {
    updatePanelWindow = null;
  });
  return { ok: true };
}

async function studioHasUpdateBridge() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const url = mainWindow.webContents.getURL() || "";
  if (!url.startsWith("http")) return false;
  try {
    return Boolean(await mainWindow.webContents.executeJavaScript(
      "Boolean((window.fantaWriter||window.fantasyWriter)&& (window.fantaWriter||window.fantasyWriter).checkUpdate)",
    ));
  } catch {
    return false;
  }
}

async function openCheckUpdateUi() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const hasBridge = await studioHasUpdateBridge();
    if (hasBridge) {
      try {
        await mainWindow.webContents.executeJavaScript("window.location.hash='#/update'");
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        return { ok: true, via: "studio" };
      } catch {
        /* fall through to overlay */
      }
    }
  }
  return openUpdatePanel();
}

function showAbout() {
  dialog.showMessageBox(mainWindow || undefined, {
    type: "info",
    title: "关于墨生万象",
    icon: path.join(__dirname, process.platform === "win32" ? "icon.ico" : "icon.png"),
    message: "墨生万象 / Inkborne 2.0",
    detail: [
      "内核与工作台 fork 自 InkOS (https://github.com/Narcooo/inkos) v1.8.x。",
      "许可证：GNU Affero General Public License v3.0。",
      "源码：https://github.com/qingyou0420/Inkborne",
      `版本：${app.getVersion()}`,
      "检查更新：工作台「系统 → 检查更新」，或本对话框 / 菜单「帮助 → 检查更新」。",
    ].join("\n"),
    buttons: ["检查更新", "关闭"],
    defaultId: 1,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) openCheckUpdateUi();
  });
}

function buildMenu() {
  const template = [
    {
      label: "墨生万象",
      submenu: [
        { label: "关于墨生万象", click: () => showAbout() },
        { label: "检查更新", click: () => { openCheckUpdateUi(); } },
        { type: "separator" },
        { label: "重启引擎", click: () => restartEngine().catch((e) => dialog.showErrorBox("重启失败", String(e))) },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    { role: "editMenu", label: "编辑" },
    { role: "viewMenu", label: "查看" },
    {
      label: "帮助",
      submenu: [
        { label: "检查更新", click: () => { openCheckUpdateUi(); } },
        { type: "separator" },
        { label: "关于墨生万象", click: () => showAbout() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function restartEngine() {
  appendLog("restart engine requested");
  await stopEngine({ graceful: true });
  const url = await resolveEngineUrl();
  mainWindow?.loadURL(url);
}

function parseSemver(v) {
  if (!v || typeof v !== "string") return null;
  const m = v.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function getGithubUpdateToken() {
  applyConfigFile(getConfigPath());
  return (process.env.GITHUB_UPDATE_TOKEN || process.env.UPDATE_GITHUB_TOKEN || "").trim();
}

function setGithubUpdateToken(token) {
  const map = readConfigMap(getConfigPath());
  const t = String(token || "").trim();
  if (t) {
    map.set(GITHUB_UPDATE_TOKEN_KEY, t);
    process.env.GITHUB_UPDATE_TOKEN = t;
  } else {
    map.delete(GITHUB_UPDATE_TOKEN_KEY);
    delete process.env.GITHUB_UPDATE_TOKEN;
  }
  writeConfigMap(getConfigPath(), map);
}

function getGithubUpdateRepo() {
  applyConfigFile(getConfigPath());
  return (process.env.UPDATE_GITHUB_REPO || DEFAULT_GITHUB_REPO).trim();
}

function getPrimaryUpdateDir() {
  if (process.env.UPDATE_DIR && process.env.UPDATE_DIR.trim()) return process.env.UPDATE_DIR.trim();
  return path.join(path.dirname(app.getPath("exe")), "updates");
}

function tryAppPath(name) {
  try {
    return app.getPath(name);
  } catch {
    return "";
  }
}

function getUpdateSearchDirs(kind) {
  const desktop = tryAppPath("desktop");
  return collectUpdateSearchDirs(kind, {
    env: process.env.UPDATE_DIR?.trim() || "",
    exeUpdates: path.join(path.dirname(app.getPath("exe")), "updates"),
    userDataUpdates: path.join(app.getPath("userData"), "updates"),
    desktopUpdatesFolder: desktop
      ? [
          path.join(desktop, "Inkborne-Updates"),
          path.join(desktop, "FantaWriter-Updates"),
          path.join(desktop, "Fantasy-Writer-Updates"),
        ]
      : [],
    desktop,
    downloads: tryAppPath("downloads"),
    documents: tryAppPath("documents"),
    exeDir: path.dirname(app.getPath("exe")),
    devDist: !app.isPackaged ? path.join(workspaceRoot(), "dist-installer") : "",
  });
}

async function scanInstallersInDir(dir) {
  const found = [];
  if (!dir) return found;
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    const ver = versionFromSetupName(name);
    if (!ver) continue;
    const full = path.join(dir, name);
    try {
      const s = await fs.promises.stat(full);
      if (!s.isFile()) continue;
      found.push({ path: full, version: ver, mtime: s.mtimeMs });
    } catch {
      /* ignore */
    }
  }
  return found;
}

async function findLatestInstaller(currentVersion, kind = "manual") {
  const searched = getUpdateSearchDirs(kind);
  const all = [];
  for (const dir of searched) {
    for (const item of await scanInstallersInDir(dir)) {
      all.push({ ...item, source: dir });
    }
  }
  const newer = all.filter((x) => compareVersions(x.version, currentVersion) > 0);
  const pool = newer.length ? newer : all;
  pool.sort((a, b) => compareVersions(b.version, a.version) || b.mtime - a.mtime);
  return { candidates: pool, searchedDirs: searched, allCount: all.length };
}

function isAllowedOpenPath(target) {
  const resolved = path.resolve(String(target || ""));
  const roots = [app.getPath("userData"), getPrimaryUpdateDir(), path.join(app.getPath("userData"), "updates")];
  return roots.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

function stripAuthIfLeavingGithub(headers, hostname) {
  const next = { ...headers };
  if (!isGithubApiHost(hostname)) {
    delete next.Authorization;
    delete next.authorization;
  }
  return next;
}

function httpGet(url, options = {}) {
  const headers = options.headers || {};
  const timeout = options.timeout || 20000;
  const maxRedirects = options.maxRedirects ?? 5;
  return new Promise((resolve, reject) => {
    let req = null;
    let settled = false;
    const timer = setTimeout(() => fail(new Error("请求超时")), timeout);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req?.destroy(); } catch { /* ignore */ }
      reject(err);
    };
    const ok = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const go = (current, left) => {
      let u;
      try { u = new URL(current); } catch (e) { fail(e); return; }
      const lib = u.protocol === "https:" ? require("https") : http;
      const reqHeaders = stripAuthIfLeavingGithub(headers, u.hostname);
      req = lib.get(current, { headers: reqHeaders, timeout }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (left <= 0) { fail(new Error("重定向过多")); return; }
          go(new URL(res.headers.location, current).toString(), left - 1);
          return;
        }
        if (code >= 400) {
          res.resume();
          fail(new Error(`HTTP ${code}`));
          return;
        }
        ok(res);
      });
      req.on("error", fail);
      req.on("timeout", () => fail(new Error("请求超时")));
    };
    go(String(url), maxRedirects);
  });
}

function fetchJson(url, headers) {
  return httpGet(url, { headers: headers || {}, timeout: 15000 }).then(
    (res) => new Promise((resolve, reject) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(e); }
      });
      res.on("error", reject);
    }),
  );
}

function fetchText(url, headers) {
  return httpGet(url, { headers: headers || {}, timeout: 15000 }).then(
    (res) => new Promise((resolve, reject) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    }),
  );
}

function downloadFile(url, dest, headers) {
  return httpGet(url, { headers: headers || {}, timeout: 60000 }).then(
    (res) => new Promise((resolve, reject) => {
      const tmp = `${dest}.part`;
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
      const ws = fs.createWriteStream(tmp);
      res.pipe(ws);
      ws.on("finish", () => {
        try { fs.renameSync(tmp, dest); resolve(); }
        catch (e) { reject(e); }
      });
      ws.on("error", reject);
      res.on("error", reject);
    }),
  );
}

function parseSha256Sidecar(text) {
  const first = String(text || "").trim().split(/\s+/)[0] || "";
  return /^[a-f0-9]{64}$/i.test(first) ? first.toLowerCase() : "";
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function checkGithubLatest(current) {
  const repo = getGithubUpdateRepo();
  const token = getGithubUpdateToken();
  const data = await fetchJson(githubLatestApiUrl(repo), githubApiHeaders(token));
  const parsed = parseGithubLatestRelease(data);
  if (!parsed) throw new Error("latest release 没有 Inkborne-Setup-x.y.z.exe / FantaWriter-Setup-x.y.z.exe 安装包");
  const hasUpdate = compareVersions(parsed.version, current) > 0;
  return {
    ok: true,
    current,
    latest: parsed.version,
    hasUpdate,
    downloadUrl: parsed.downloadUrl || undefined,
    assetApiUrl: parsed.assetApiUrl || undefined,
    sha256DownloadUrl: parsed.sha256DownloadUrl || undefined,
    sha256AssetApiUrl: parsed.sha256AssetApiUrl || undefined,
    source: `github:${repo}`,
    message: hasUpdate
      ? `GitHub 发现新版本 ${parsed.version}（当前 ${current}）`
      : `已是最新（GitHub ${parsed.version}）`,
  };
}

function isAllowedFeedDownloadUrl(url) {
  if (isAllowedDownloadUrl(url)) return true;
  const feed = process.env.UPDATE_FEED_URL?.trim();
  if (!feed) return false;
  try {
    const feedHost = new URL(feed).hostname.toLowerCase();
    const u = new URL(String(url || ""));
    return u.protocol === "https:" && u.hostname.toLowerCase() === feedHost;
  } catch {
    return false;
  }
}

async function testOpenAiCompatible({ baseUrl, apiKey, model }) {
  const root = String(baseUrl || "").trim().replace(/\/$/, "");
  if (!root) return { ok: false, message: "Base URL 不能为空" };
  const key = String(apiKey || "").trim();
  if (!key) return { ok: false, message: "API Key 不能为空" };
  const usedModel = String(model || "").trim();
  if (!usedModel) return { ok: false, message: "模型名不能为空" };
  const url = `${root}/chat/completions`;
  try {
    const res = await new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === "https:" ? require("https") : http;
      const req = lib.request(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }, resolve);
      req.on("error", reject);
      req.on("timeout", () => reject(new Error("请求超时")));
      req.write(JSON.stringify({
        model: usedModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
      }));
      req.end();
    });
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    if ((res.statusCode || 0) >= 400) {
      return { ok: false, message: `上游返回 HTTP ${res.statusCode}：${body.slice(0, 240)}` };
    }
    return { ok: true, message: "连接成功，上游已响应。" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function registerIpc() {
  ipcMain.handle("app:getInfo", () => ({
    version: app.getVersion(),
    isDesktop: true,
    isPackaged: app.isPackaged,
    platform: process.platform,
    projectRoot,
    enginePort,
    updateDir: getPrimaryUpdateDir(),
  }));

  ipcMain.handle("app:showAbout", () => {
    showAbout();
    return { ok: true };
  });
  ipcMain.handle("app:openUpdatePanel", () => openUpdatePanel());

  ipcMain.handle("app:getFirstRunState", () => {
    const cfg = loadShellConfig();
    const root = cfg.projectRoot || defaultProjectRoot(tryAppPath("documents") || undefined);
    let baseUrl = "https://api.deepseek.com";
    let model = "deepseek-v4-pro";
    let name = "自定义";
    try {
      if (cfg.projectRoot && fs.existsSync(path.join(cfg.projectRoot, "inkos.json"))) {
        const raw = JSON.parse(fs.readFileSync(path.join(cfg.projectRoot, "inkos.json"), "utf8"));
        const llm = raw?.llm && typeof raw.llm === "object" ? raw.llm : {};
        const selected = typeof llm.service === "string" && llm.service.startsWith("custom:")
          ? llm.service.slice("custom:".length)
          : "";
        const listed = Array.isArray(llm.services)
          ? llm.services.find((svc) => svc && svc.service === "custom" && svc.name === (selected || svc.name))
          : null;
        baseUrl = listed?.baseUrl || llm.baseUrl || baseUrl;
        model = (Array.isArray(listed?.models) && listed.models[0]) || llm.defaultModel || llm.model || model;
        name = listed?.name || selected || name;
      }
    } catch {
      /* ignore */
    }
    return { projectRoot: root, baseUrl, model, name, firstRunDone: cfg.firstRunDone };
  });

  ipcMain.handle("app:pickProjectRoot", async () => {
    const res = await dialog.showOpenDialog(mainWindow || undefined, {
      title: "选择墨生万象项目根目录",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: defaultProjectRoot(tryAppPath("documents") || undefined),
    });
    if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  });

  ipcMain.handle("app:testModel", async (_e, payload) => testOpenAiCompatible(payload || {}));

  ipcMain.handle("app:saveFirstRun", async (_e, payload) => {
    const root = String(payload?.projectRoot || "").trim();
    if (!path.isAbsolute(root)) return { ok: false, message: "项目根必须是绝对路径" };
    try {
      ensureProjectLayout(root);
      saveFirstRunLlm(root, {
        name: payload?.name,
        baseUrl: payload?.baseUrl,
        model: payload?.model,
        apiKey: payload?.apiKey,
      });
      saveShellConfig({
        INKOS_PROJECT_ROOT: root,
        FW_FIRST_RUN_DONE: "1",
      });
      projectRoot = root;
      const url = await resolveEngineUrl();
      mainWindow?.loadURL(url);
      return { ok: true, projectRoot: root, url };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("app:restartEngine", async () => {
    await restartEngine();
    return { ok: true };
  });

  ipcMain.handle("app:getUpdateSettings", () => {
    const token = getGithubUpdateToken();
    return { hasGithubToken: Boolean(token), tokenPrefix: token ? token.slice(0, 4) : "", repo: getGithubUpdateRepo() };
  });
  ipcMain.handle("app:setGithubUpdateToken", (_e, token) => {
    setGithubUpdateToken(token);
    return { ok: true, hasGithubToken: Boolean(String(token || "").trim()) };
  });
  ipcMain.handle("app:checkUpdate", async (_e, payload) => {
    const { kind } = parseCheckUpdateRequest(payload);
    const current = app.getVersion();
    return checkUpdateSources({
      kind,
      readLocal: async () => {
        const { candidates, searchedDirs, allCount } = await findLatestInstaller(current, kind);
        if (!candidates.length) {
          return {
            ok: true,
            current,
            latest: null,
            hasUpdate: false,
            message: `未找到安装包。主目录：${getPrimaryUpdateDir()}`,
            searchedDirs,
          };
        }
        const best = candidates[0];
        return {
          ok: true,
          current,
          latest: best.version,
          hasUpdate: compareVersions(best.version, current) > 0,
          installerPath: best.path,
          source: best.source,
          searchedDirs,
          allCount,
        };
      },
      readRemote: () => checkGithubLatest(current),
      onRemoteError: (error) => appendLog(`GitHub latest 失败: ${error}`),
    });
  });
  ipcMain.handle("app:downloadUpdate", async (_e, payload) => {
    const opts = payload && typeof payload === "object" ? payload : { downloadUrl: payload };
    const token = getGithubUpdateToken();
    const url = String(opts.assetApiUrl || opts.downloadUrl || "").trim();
    if (!url || !isAllowedFeedDownloadUrl(url)) return { ok: false, message: "没有可下载的安装包地址" };
    const fileName = setupFileNameFromUrl(url) || (opts.version ? setupFileNameForVersion(opts.version) : null);
    if (!fileName || !versionFromSetupName(fileName)) return { ok: false, message: "安装包文件名不符合 Inkborne-Setup-x.y.z.exe 或 FantaWriter-Setup-x.y.z.exe" };
    const destDir = path.join(app.getPath("temp"), "Inkborne-Updates");
    ensureDir(destDir);
    const dest = path.join(destDir, fileName);
    await downloadFile(url, dest, githubAssetHeaders(token));
    return { ok: true, path: dest, version: versionFromSetupName(fileName) || undefined };
  });
  ipcMain.handle("app:installUpdate", async (_e, installerPath) => {
    const target = String(installerPath || "");
    if (!target || !fs.existsSync(target) || !/\.exe$/i.test(target)) {
      return { ok: false, message: "安装包不存在" };
    }
    const openErr = await shell.openPath(target);
    if (openErr) return { ok: false, message: openErr };
    setTimeout(async () => {
      quitting = true;
      await stopEngine({ graceful: true });
      app.quit();
    }, 800);
    return { ok: true };
  });
  ipcMain.handle("app:pickInstaller", async () => {
    const res = await dialog.showOpenDialog(mainWindow || undefined, {
      title: "选择墨生万象安装包",
      filters: [{ name: "安装程序", extensions: ["exe"] }],
      properties: ["openFile"],
    });
    if (res.canceled || !res.filePaths?.[0]) return { ok: false };
    return { ok: true, path: res.filePaths[0], version: versionFromSetupName(path.basename(res.filePaths[0])) };
  });
  ipcMain.handle("app:openPath", async (_e, target) => {
    const t = String(target || "");
    if (!isAllowedOpenPath(t)) return { ok: false, message: "拒绝打开非用户数据/更新目录的路径" };
    const err = await shell.openPath(t);
    return err ? { ok: false, message: err } : { ok: true };
  });
  ipcMain.handle("app:openUpdateDir", async () => {
    const dir = getPrimaryUpdateDir();
    ensureDir(dir);
    const err = await shell.openPath(dir);
    return { ok: !err, path: dir, message: err || undefined };
  });
}

async function boot() {
  registerIpc();
  buildMenu();
  try {
    const url = await resolveEngineUrl();
    createWindow(url);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("启动失败", `${msg}\n\n日志：${getLogPath()}`);
    app.quit();
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(boot);
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stopEngine({ graceful: true }).finally(() => app.quit());
  });
  app.on("window-all-closed", () => {
    quitting = true;
    stopEngine({ graceful: true }).finally(() => app.quit());
  });
}
