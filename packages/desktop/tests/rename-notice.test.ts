import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { shouldShowRenameNotice, renameNoticeCopy } = require("../lib/rename-notice.cjs") as {
  shouldShowRenameNotice: (config: Map<string, string>) => boolean;
  renameNoticeCopy: (projectRoot: string) => { title: string; message: string; button: string };
};

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
});
