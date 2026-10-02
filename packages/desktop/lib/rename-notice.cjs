/**
 * One-time "renamed to 轻光之集" notice.
 * Old users (FW_FIRST_RUN_DONE=1, notice not yet recorded) see it once.
 * Fresh installs only record the key. The key is written after the window
 * exists; a failure is logged and never blocks startup.
 */
const NOTICE_KEY = "FW_RENAME_NOTICE_SHOWN";
const FIRST_RUN_KEY = "FW_FIRST_RUN_DONE";

function configValue(config, key) {
  if (!config) return "";
  if (typeof config.get === "function") {
    const value = config.get(key);
    return value == null ? "" : String(value);
  }
  if (typeof config === "object" && Object.prototype.hasOwnProperty.call(config, key)) {
    const value = config[key];
    return value == null ? "" : String(value);
  }
  return "";
}

/** True only for an existing user who has not been shown the rename notice. */
function shouldShowRenameNotice(config) {
  const firstRunDone = configValue(config, FIRST_RUN_KEY) === "1";
  const alreadyShown = configValue(config, NOTICE_KEY) === "1";
  return firstRunDone && !alreadyShown;
}

function renameNoticeCopy(projectRoot) {
  const root = String(projectRoot || "");
  return {
    title: "已更名为轻光之集",
    message: `墨生万象已更名为轻光之集（Lightbound）。你的书稿、设置和模型配置都原样保留，书稿仍在：${root}。如果你之前把应用固定在任务栏，请取消固定后重新固定。`,
    button: "知道了",
  };
}

function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function safeLog(appendLog, line) {
  if (typeof appendLog !== "function") return;
  try {
    appendLog(line);
  } catch {
    /* logging must not break startup */
  }
}

/** Snapshot notice state before the engine starts. Never writes. */
function readRenameNoticePlan(deps) {
  let appendLog;
  try {
    appendLog = deps.appendLog;
    const priorShell = deps.loadShellConfig();
    const priorMap = deps.readConfigMap(deps.getConfigPath());
    if (configValue(priorMap, NOTICE_KEY) === "1") {
      return { show: false, record: false };
    }
    const show = Boolean(priorShell && priorShell.firstRunDone === true)
      && shouldShowRenameNotice(priorMap);
    return { show, record: true };
  } catch (error) {
    safeLog(appendLog, `rename notice: read failed: ${errorText(error)}`);
    return { show: false, record: false };
  }
}

/** Show and/or record the notice after the window exists. Never throws. */
function applyRenameNotice(deps) {
  let appendLog;
  try {
    appendLog = deps && deps.appendLog;
    const plan = (deps && deps.plan) || {};
    const show = plan.show === true;
    const record = plan.record === true;
    if (!show && !record) return;
    if (show) {
      const copy = renameNoticeCopy(deps.projectRoot);
      try {
        const pending = deps.dialog.showMessageBox(deps.mainWindow || undefined, {
          type: "info",
          title: copy.title,
          message: copy.message,
          buttons: [copy.button],
          defaultId: 0,
          cancelId: 0,
        });
        if (pending && typeof pending.catch === "function") {
          void pending.catch((error) => {
            safeLog(appendLog, `rename notice: dialog failed: ${errorText(error)}`);
          });
        }
      } catch (error) {
        safeLog(appendLog, `rename notice: dialog failed: ${errorText(error)}`);
        return;
      }
    }
    try {
      deps.saveShellConfig({ [NOTICE_KEY]: "1" });
    } catch (error) {
      safeLog(appendLog, `rename notice: save failed: ${errorText(error)}`);
    }
  } catch (error) {
    safeLog(appendLog, `rename notice: apply failed: ${errorText(error)}`);
  }
}

module.exports = {
  NOTICE_KEY,
  shouldShowRenameNotice,
  renameNoticeCopy,
  readRenameNoticePlan,
  applyRenameNotice,
};
