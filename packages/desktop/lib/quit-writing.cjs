/**
 * Plain-language quit prompt when a book lock or atomic commit is still running.
 */

function formatHeld(heldMs) {
  if (typeof heldMs !== "number" || heldMs < 0) return "";
  if (heldMs < 60_000) return `${Math.max(1, Math.round(heldMs / 1000))} 秒`;
  return `${Math.round(heldMs / 60_000)} 分钟`;
}

function writingStatusBusy(status) {
  if (!status || typeof status !== "object") return false;
  const locks = Array.isArray(status.locks) ? status.locks.length : 0;
  const atomicWrites = Number(status.atomicWrites) || 0;
  return locks > 0 || atomicWrites > 0;
}

function writingStatusMessage(status) {
  const lock = status && Array.isArray(status.locks) ? status.locks[0] : null;
  if (lock) {
    const stage = lock.stage ? String(lock.stage) : "";
    const held = formatHeld(lock.heldMs);
    const detail = [stage, held ? `已 ${held}` : ""].filter(Boolean).join("，");
    const suffix = detail ? `（${detail}）` : "";
    return `这本书正在写入${suffix}。等它写完再退出，或立即中止。中止可能丢掉还没写完的这一次；已经开始的落盘会先写完。`;
  }
  if (status && Number(status.atomicWrites) > 0) {
    return "有内容正在落盘。等它写完再退出，或立即中止。";
  }
  return "";
}

module.exports = {
  formatHeld,
  writingStatusBusy,
  writingStatusMessage,
};
