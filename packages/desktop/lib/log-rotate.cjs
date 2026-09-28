/**
 * Rotate a log file once it reaches maxBytes.
 * Keeps `keep` older copies plus the new empty current file: 3 files when keep is 2.
 */
const fs = require("fs");

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
  for (let index = copies - 1; index >= 1; index -= 1) {
    const src = `${filePath}.${index}`;
    const dest = `${filePath}.${index + 1}`;
    if (!fs.existsSync(src)) continue;
    try { fs.renameSync(src, dest); } catch { /* ignore */ }
  }
  try {
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    return false;
  }
  return true;
}

module.exports = { rotateLogIfNeeded };
