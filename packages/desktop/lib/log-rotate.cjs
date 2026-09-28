/**
 * Rotate a log file once it reaches maxBytes.
 * Keeps `keep` older copies plus the new empty current file: 3 files when keep is 2.
 */
const fs = require("fs");

const warned = new Set();

function warnOnce(filePath, error) {
  if (warned.has(filePath)) return;
  warned.add(filePath);
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[inkos] 日志轮转失败，已停止往超大日志追加：${filePath}（${detail}）`);
}

function copyThenTruncate(filePath, dest) {
  fs.copyFileSync(filePath, dest);
  fs.truncateSync(filePath, 0);
}

/** Park the live log beside an unsaved `.1`. An existing overflow is left untouched. */
function spillCurrentToOverflow(filePath) {
  const overflow = `${filePath}.overflow`;
  if (fs.existsSync(overflow)) {
    warnOnce(filePath, new Error("已有 overflow 备份，不再覆盖"));
    return false;
  }
  copyThenTruncate(filePath, overflow);
  return true;
}

function rotateLogIfNeeded(filePath, maxBytes, keep = 2) {
  const limit = Number(maxBytes);
  const copies = Math.max(1, Number(keep) || 2);
  if (!filePath || !Number.isFinite(limit) || limit <= 0) return false;
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return false;
  }
  if (size < limit) return false;
  const oldest = `${filePath}.${copies}`;
  try { fs.rmSync(oldest, { force: true }); } catch { /* ignore */ }
  let shiftFailed = false;
  for (let index = copies - 1; index >= 1; index -= 1) {
    const src = `${filePath}.${index}`;
    const dest = `${filePath}.${index + 1}`;
    if (!fs.existsSync(src)) continue;
    try {
      fs.renameSync(src, dest);
    } catch {
      shiftFailed = true;
      break;
    }
  }
  const primaryBackup = `${filePath}.1`;
  if (shiftFailed && fs.existsSync(primaryBackup)) {
    try {
      return spillCurrentToOverflow(filePath);
    } catch (error) {
      warnOnce(filePath, error);
      return false;
    }
  }
  try {
    fs.renameSync(filePath, primaryBackup);
    return true;
  } catch (error) {
    if (fs.existsSync(primaryBackup)) {
      try {
        return spillCurrentToOverflow(filePath);
      } catch (copyError) {
        warnOnce(filePath, copyError);
        return false;
      }
    }
    try {
      copyThenTruncate(filePath, primaryBackup);
      return true;
    } catch {
      warnOnce(filePath, error);
      return false;
    }
  }
}

module.exports = { rotateLogIfNeeded };
