/**
 * 安装包文件名合同：品牌前缀非捕获，group 1 永远是 semver。
 * 新前缀 Lightbound-Setup；仍识别已发布的 Inkborne-Setup、FantaWriter-Setup 与 Fantasy-Writer-Setup。
 * 必须放在 packages/desktop/lib，以便打进 app.asar。
 */
const path = require("path");

const CURRENT_SETUP_PREFIX = "Lightbound-Setup";

const SETUP_RE =
  /^(?:Lightbound|Inkborne|FantaWriter|Fantasy-Writer)-Setup-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.exe$/i;

function versionFromSetupName(name) {
  const m = String(name).match(SETUP_RE);
  return m ? m[1] : null;
}

function setupFileNameForVersion(version) {
  const v = String(version || "").replace(/^v/i, "");
  return `${CURRENT_SETUP_PREFIX}-${v}.exe`;
}

/** 同版本时优先新前缀（0 优于 1 优于 2 优于 3）。 */
function preferSetupRank(name) {
  const n = String(name);
  if (/^Lightbound-Setup-/i.test(n)) return 0;
  if (/^Inkborne-Setup-/i.test(n)) return 1;
  if (/^FantaWriter-Setup-/i.test(n)) return 2;
  return 3;
}

/** 版本高者在前；同版本按文件名 preferSetupRank 升序；rank 相同再按 mtime 降序。 */
function compareSetupCandidates(a, b, compareVersionsFn) {
  const byVersion = compareVersionsFn(b.version, a.version);
  if (byVersion !== 0) return byVersion;
  const byRank =
    preferSetupRank(path.basename(a.path)) - preferSetupRank(path.basename(b.path));
  if (byRank !== 0) return byRank;
  return b.mtime - a.mtime;
}

module.exports = {
  SETUP_RE,
  CURRENT_SETUP_PREFIX,
  versionFromSetupName,
  setupFileNameForVersion,
  preferSetupRank,
  compareSetupCandidates,
};
