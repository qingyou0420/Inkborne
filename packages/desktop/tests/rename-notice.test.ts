import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { shouldShowRenameNotice, renameNoticeCopy, readRenameNoticePlan, applyRenameNotice } = require("../lib/rename-notice.cjs") as {
  shouldShowRenameNotice: (config: Map<string, string>) => boolean;
  renameNoticeCopy: (projectRoot: string) => { title: string; message: string; button: string };
  readRenameNoticePlan: (deps: {
    loadShellConfig: () => { firstRunDone?: boolean };
    readConfigMap: (filePath: string) => Map<string, string>;
    getConfigPath: () => string;
    appendLog?: (line: string) => void;
  }) => { show: boolean; record: boolean };
  applyRenameNotice: (deps: {
    plan: { show: boolean; record: boolean };
    dialog: { showMessageBox: (parent: unknown, options: RenameDialogOptions) => unknown };
    mainWindow: unknown;
    projectRoot: string;
    saveShellConfig: (partial: Record<string, string>) => void;
    appendLog?: (line: string) => void;
  }) => void;
};

interface RenameDialogOptions {
  type?: string;
  title?: string;
  message?: string;
  buttons?: string[];
}

function configOf(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("rename notice", () => {
  it("shows for an existing user who has not seen it", () => {
    expect(shouldShowRenameNotice(configOf({ FW_FIRST_RUN_DONE: "1" }))).toBe(true);
  });

  it("does not show when the notice was already recorded", () => {
    expect(shouldShowRenameNotice(configOf({
      FW_FIRST_RUN_DONE: "1",
      FW_RENAME_NOTICE_SHOWN: "1",
    }))).toBe(false);
  });

  it("does not show on a fresh install", () => {
    expect(shouldShowRenameNotice(configOf({}))).toBe(false);
    expect(shouldShowRenameNotice(configOf({ FW_RENAME_NOTICE_SHOWN: "1" }))).toBe(false);
  });

  it("keeps the books in place and tells the user to re-pin the taskbar", () => {
    const root = "D:\\Users\\me\\Documents\\幻想作家";
    const copy = renameNoticeCopy(root);
    expect(copy.title).toBe("已更名为轻光之集");
    expect(copy.button).toBe("知道了");
    expect(copy.message).toContain("轻光之集");
    expect(copy.message).toContain("原样保留");
    expect(copy.message).toContain("任务栏");
    expect(copy.message).toContain(root);
  });

  it("records FW_RENAME_NOTICE_SHOWN and leaves the existing shell keys named as they are", () => {
    const main = readFileSync(join(here, "..", "main.cjs"), "utf8");
    expect(main).toContain("FW_RENAME_NOTICE_SHOWN");
    expect(main).toContain('FW_FIRST_RUN_DONE: "1"');
    expect(main).toContain("INKOS_PROJECT_ROOT");
    expect(main).toContain("FW_INSTANCE_TOKEN");
    expect(main).toContain("APP_DATA_PORT");
    expect(main).toMatch(/firstRunDone: map\.get\("FW_FIRST_RUN_DONE"\) === "1"/);
  });

  it("shows the dialog before recording the key for an existing user", () => {
    // PR-2 复审：老用户先弹窗，调用成功后才写 FW_RENAME_NOTICE_SHOWN。
    const order: string[] = [];
    const plan = readRenameNoticePlan({
      loadShellConfig: () => ({ firstRunDone: true }),
      readConfigMap: () => configOf({ FW_FIRST_RUN_DONE: "1" }),
      getConfigPath: () => "config.env",
      appendLog: () => undefined,
    });
    expect(plan).toEqual({ show: true, record: true });
    const mainWindow = { id: "main" };
    const root = "D:\\Users\\me\\Documents\\幻想作家";
    let seenParent: unknown;
    let seenOptions: RenameDialogOptions | undefined;
    const result = applyRenameNotice({
      plan,
      dialog: {
        showMessageBox: (parent, options) => {
          order.push("showMessageBox");
          seenParent = parent;
          seenOptions = options;
          return new Promise(() => undefined);
        },
      },
      mainWindow,
      projectRoot: root,
      saveShellConfig: (partial) => {
        order.push("saveShellConfig");
        expect(partial).toEqual({ FW_RENAME_NOTICE_SHOWN: "1" });
      },
      appendLog: () => undefined,
    });
    expect(result).toBeUndefined();
    expect(seenParent).toBe(mainWindow);
    expect(seenOptions?.type).toBe("info");
    expect(seenOptions?.title).toBe("已更名为轻光之集");
    expect(seenOptions?.buttons).toEqual(["知道了"]);
    expect(seenOptions?.message).toContain(root);
    expect(order).toEqual(["showMessageBox", "saveShellConfig"]);
  });

  it("logs and does not throw when saveShellConfig fails", () => {
    // PR-2 复审：写键失败只记日志，不向外抛。
    for (const plan of [{ show: true, record: true }, { show: false, record: true }]) {
      const logs: string[] = [];
      let dialogs = 0;
      expect(() => applyRenameNotice({
        plan,
        dialog: {
          showMessageBox: () => {
            dialogs += 1;
            return Promise.resolve({ response: 0 });
          },
        },
        mainWindow: { id: "main" },
        projectRoot: "D:\\books",
        saveShellConfig: () => {
          throw new Error("disk full");
        },
        appendLog: (line) => logs.push(line),
      })).not.toThrow();
      expect(logs.some((line) => line.includes("disk full"))).toBe(true);
      expect(dialogs).toBe(plan.show ? 1 : 0);
    }
  });

  it("does not record the key when the dialog throws", () => {
    // PR-2 复审：弹窗调用抛错则不写键，下次再试。
    const logs: string[] = [];
    let saved = false;
    expect(() => applyRenameNotice({
      plan: { show: true, record: true },
      dialog: {
        showMessageBox: () => {
          throw new Error("dialog down");
        },
      },
      mainWindow: { id: "main" },
      projectRoot: "D:\\books",
      saveShellConfig: () => {
        saved = true;
      },
      appendLog: (line) => logs.push(line),
    })).not.toThrow();
    expect(saved).toBe(false);
    expect(logs.some((line) => line.includes("dialog down"))).toBe(true);
  });

  it("records the key without a dialog on a fresh install", () => {
    // PR-2 复审：全新安装不弹窗，只静默写键。
    const plan = readRenameNoticePlan({
      loadShellConfig: () => ({ firstRunDone: false }),
      readConfigMap: () => configOf({}),
      getConfigPath: () => "config.env",
      appendLog: () => undefined,
    });
    expect(plan).toEqual({ show: false, record: true });
    let dialogs = 0;
    let saved: Record<string, string> | null = null;
    applyRenameNotice({
      plan,
      dialog: {
        showMessageBox: () => {
          dialogs += 1;
          return Promise.resolve({ response: 0 });
        },
      },
      mainWindow: { id: "main" },
      projectRoot: "D:\\books",
      saveShellConfig: (partial) => {
        saved = partial;
      },
      appendLog: () => undefined,
    });
    expect(dialogs).toBe(0);
    expect(saved).toEqual({ FW_RENAME_NOTICE_SHOWN: "1" });
  });

  it("does nothing when the notice key is already set", () => {
    // PR-2 复审：键已为 1 时不弹窗也不写。
    const plan = readRenameNoticePlan({
      loadShellConfig: () => ({ firstRunDone: true }),
      readConfigMap: () => configOf({
        FW_FIRST_RUN_DONE: "1",
        FW_RENAME_NOTICE_SHOWN: "1",
      }),
      getConfigPath: () => "config.env",
      appendLog: () => undefined,
    });
    expect(plan).toEqual({ show: false, record: false });
    let dialogs = 0;
    let saved = false;
    applyRenameNotice({
      plan,
      dialog: {
        showMessageBox: () => {
          dialogs += 1;
          return Promise.resolve({ response: 0 });
        },
      },
      mainWindow: { id: "main" },
      projectRoot: "D:\\books",
      saveShellConfig: () => {
        saved = true;
      },
      appendLog: () => undefined,
    });
    expect(dialogs).toBe(0);
    expect(saved).toBe(false);
  });

  it("treats a failed state read as no notice and does not throw", () => {
    // PR-2 复审：读状态失败视为不提示，不写键，下次再试。
    const logs: string[] = [];
    let plan = { show: true, record: true };
    expect(() => {
      plan = readRenameNoticePlan({
        loadShellConfig: () => {
          throw new Error("config locked");
        },
        readConfigMap: () => configOf({ FW_FIRST_RUN_DONE: "1" }),
        getConfigPath: () => "config.env",
        appendLog: (line) => logs.push(line),
      });
    }).not.toThrow();
    expect(plan).toEqual({ show: false, record: false });
    let dialogs = 0;
    let saved = false;
    expect(() => applyRenameNotice({
      plan,
      dialog: {
        showMessageBox: () => {
          dialogs += 1;
          return Promise.resolve({ response: 0 });
        },
      },
      mainWindow: { id: "main" },
      projectRoot: "D:\\books",
      saveShellConfig: () => {
        saved = true;
      },
      appendLog: () => undefined,
    })).not.toThrow();
    expect(dialogs).toBe(0);
    expect(saved).toBe(false);
    expect(logs.some((line) => line.includes("config locked"))).toBe(true);
  });

  it("reads the rename plan before the engine starts and applies it after the window exists", () => {
    // PR-2 复审：读在 resolveEngineUrl 之前，写在 createWindow 之后，调用本身另有 try/catch。
    const main = readFileSync(join(here, "..", "main.cjs"), "utf8");
    const bootStart = main.indexOf("async function boot()");
    const bootEnd = main.indexOf("const gotLock", bootStart);
    const boot = main.slice(bootStart, bootEnd);
    const readAt = boot.indexOf("readRenameNoticePlan(");
    const resolveAt = boot.indexOf("await resolveEngineUrl(");
    const windowAt = boot.indexOf("createWindow(");
    const applyAt = boot.indexOf("applyRenameNotice(");
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeLessThan(resolveAt);
    expect(windowAt).toBeGreaterThan(resolveAt);
    expect(applyAt).toBeGreaterThan(windowAt);
    expect(boot.indexOf("rename notice: read failed:")).toBeGreaterThanOrEqual(0);
    expect(boot.indexOf("rename notice: read failed:")).toBeLessThan(resolveAt);
    expect(boot.indexOf("rename notice: apply failed:")).toBeGreaterThan(applyAt);
    expect(boot).not.toContain("await applyRenameNotice");
    expect(boot).not.toContain("await dialog.showMessageBox");
    expect(boot.indexOf('dialog.showErrorBox("启动失败"')).toBeGreaterThan(applyAt);
  });
});
