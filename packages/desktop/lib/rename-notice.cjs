/**
 * One-time "renamed to 轻光之集" notice. Pure helpers; the dialog stays in main.cjs.
 * Old users (FW_FIRST_RUN_DONE=1, notice not yet recorded) see it once.
 * Fresh installs do not. The shell writes FW_RENAME_NOTICE_SHOWN=1 either way.
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

module.exports = {
  NOTICE_KEY,
  shouldShowRenameNotice,
  renameNoticeCopy,
};
