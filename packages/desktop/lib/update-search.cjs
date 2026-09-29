/**
 * Where the desktop shell looks for Inkborne-Setup-*.exe and FantaWriter-Setup-*.exe.
 *
 * Silent startup checks must stay off the first-paint path:
 * - do not readdir() 桌面 / 下载 / 文档 (huge, often OneDrive)
 * - do not readdir() the install/exe directory (users may install onto Desktop)
 * - do not hit GitHub / UPDATE_FEED (Node socket timeout does not cover
 *   connect/DNS; a blackholed api.github.com can sit for minutes)
 *
 * A sync or long walk in the Electron main process makes the painted
 * homepage ignore clicks until it finishes.
 */

/** Keys that may point at large user home folders. */
const BULK_USER_DIR_KEYS = ["desktop", "downloads", "documents"];

/** Dedicated small folders only. Never the install dir or a whole home folder. */
const SILENT_DIR_KEYS = [
  "env",
  "exeUpdates",
  "userDataUpdates",
  "desktopUpdatesFolder",
];

const MANUAL_DIR_KEYS = [
  ...SILENT_DIR_KEYS,
  "exeDir",
  "devDist",
  ...BULK_USER_DIR_KEYS,
];

/**
 * @param {unknown} payload
 * @returns {{ silent: boolean, kind: "silent" | "manual" }}
 */
function parseCheckUpdateRequest(payload) {
  const silent = Boolean(
    payload && typeof payload === "object" && payload.silent === true
  );
  return { silent, kind: silent ? "silent" : "manual" };
}

/**
 * Silent startup must not open a socket. Manual "检查更新" still may.
 * @param {"silent" | "manual"} kind
 */
function shouldUseRemoteUpdateCheck(kind) {
  return kind !== "silent";
}

/** A ready local upgrade must not be hidden by an older GitHub release. */
async function checkUpdateSources({ kind, readLocal, readRemote, onRemoteError }) {
  const local = await readLocal();
  if (local.hasUpdate || !shouldUseRemoteUpdateCheck(kind)) return local;
  try {
    return await readRemote();
  } catch (error) {
    onRemoteError?.(error);
    return local;
  }
}

/**
 * @param {string[]} out
 * @param {unknown} d
 */
function pushDir(out, d) {
  if (Array.isArray(d)) {
    for (const item of d) pushDir(out, item);
    return;
  }
  if (typeof d === "string") {
    const trimmed = d.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
}

/**
 * @param {"silent" | "manual"} kind
 * @param {Record<string, string | string[] | undefined | null>} paths
 * @returns {string[]}
 */
function collectUpdateSearchDirs(kind, paths) {
  const keys = kind === "silent" ? SILENT_DIR_KEYS : MANUAL_DIR_KEYS;
  const src = paths && typeof paths === "object" ? paths : {};
  /** @type {string[]} */
  const out = [];
  for (const key of keys) {
    pushDir(out, src[key]);
  }
  return out;
}

module.exports = {
  BULK_USER_DIR_KEYS,
  SILENT_DIR_KEYS,
  MANUAL_DIR_KEYS,
  parseCheckUpdateRequest,
  shouldUseRemoteUpdateCheck,
  checkUpdateSources,
  collectUpdateSearchDirs,
};
