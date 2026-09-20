import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  BULK_USER_DIR_KEYS,
  SILENT_DIR_KEYS,
  parseCheckUpdateRequest,
  shouldUseRemoteUpdateCheck,
  collectUpdateSearchDirs,
  checkUpdateSources,
} = require("../lib/update-search.cjs") as {
  BULK_USER_DIR_KEYS: string[];
  SILENT_DIR_KEYS: string[];
  parseCheckUpdateRequest: (payload: unknown) => {
    silent: boolean;
    kind: "silent" | "manual";
  };
  shouldUseRemoteUpdateCheck: (kind: "silent" | "manual") => boolean;
  collectUpdateSearchDirs: (
    kind: "silent" | "manual",
    paths: Record<string, string | string[]>
  ) => string[];
  checkUpdateSources: (options: {
    kind: "silent" | "manual";
    readLocal: () => Promise<Record<string, unknown>>;
    readRemote: () => Promise<Record<string, unknown>>;
    onRemoteError?: (error: unknown) => void;
  }) => Promise<Record<string, unknown>>;
};

const PATHS = {
  env: "/custom/updates",
  exeUpdates: "/app/updates",
  userDataUpdates: "/data/updates",
  desktopUpdatesFolder: [
    "/Users/me/Desktop/Inkborne-Updates",
    "/Users/me/Desktop/FantaWriter-Updates",
    "/Users/me/Desktop/Fantasy-Writer-Updates",
  ],
  exeDir: "/app",
  devDist: "/src/dist-installer",
  desktop: "/Users/me/Desktop",
  downloads: "/Users/me/Downloads",
  documents: "/Users/me/Documents",
};

describe("parseCheckUpdateRequest", () => {
  it("defaults to a manual (full) scan", () => {
    expect(parseCheckUpdateRequest(undefined)).toEqual({
      silent: false,
      kind: "manual",
    });
    expect(parseCheckUpdateRequest({})).toEqual({
      silent: false,
      kind: "manual",
    });
  });

  it("treats { silent: true } as a bounded startup check", () => {
    expect(parseCheckUpdateRequest({ silent: true })).toEqual({
      silent: true,
      kind: "silent",
    });
  });
});

describe("shouldUseRemoteUpdateCheck", () => {
  it("skips GitHub / feed on silent startup", () => {
    expect(shouldUseRemoteUpdateCheck("silent")).toBe(false);
    expect(shouldUseRemoteUpdateCheck("manual")).toBe(true);
  });
});

describe("checkUpdateSources", () => {
  const localUpgrade = {
    ok: true, current: "2.1.9", latest: "2.2.2", hasUpdate: true,
    installerPath: "E:/桌面/Inkborne-Updates/Inkborne-Setup-2.2.2.exe",
  };
  const noLocalUpgrade = { ok: true, current: "2.1.9", latest: null, hasUpdate: false };

  it("returns a ready local upgrade without an older remote release masking it", async () => {
    const readRemote = vi.fn().mockResolvedValue({ latest: "2.1.9", hasUpdate: false });
    const result = await checkUpdateSources({
      kind: "manual", readLocal: async () => localUpgrade, readRemote,
    });
    expect(result).toEqual(localUpgrade);
    expect(readRemote).not.toHaveBeenCalled();
  });

  it("keeps silent startup offline even when no local upgrade exists", async () => {
    const readRemote = vi.fn();
    expect(await checkUpdateSources({
      kind: "silent", readLocal: async () => noLocalUpgrade, readRemote,
    })).toEqual(noLocalUpgrade);
    expect(readRemote).not.toHaveBeenCalled();
  });

  it("checks remote releases when the local installer is only the current version", async () => {
    const remote = { latest: "2.2.2", hasUpdate: true, downloadUrl: "https://github.com/setup.exe" };
    const result = await checkUpdateSources({
      kind: "manual",
      readLocal: async () => ({ ...noLocalUpgrade, latest: "2.1.9", installerPath: "old.exe" }),
      readRemote: async () => remote,
    });
    expect(result).toEqual(remote);
  });

  it("preserves local scan diagnostics if the remote check fails", async () => {
    const error = new Error("offline");
    const onRemoteError = vi.fn();
    const local = { ...noLocalUpgrade, searchedDirs: ["E:/桌面/Inkborne-Updates"] };
    expect(await checkUpdateSources({
      kind: "manual", readLocal: async () => local,
      readRemote: async () => { throw error; }, onRemoteError,
    })).toEqual(local);
    expect(onRemoteError).toHaveBeenCalledWith(error);
  });
});

describe("collectUpdateSearchDirs", () => {
  it("does not scan 桌面 / 下载 / 文档 / 安装目录 on silent startup", () => {
    const dirs = collectUpdateSearchDirs("silent", PATHS);
    expect(dirs).toEqual([
      PATHS.env,
      PATHS.exeUpdates,
      PATHS.userDataUpdates,
      ...PATHS.desktopUpdatesFolder,
    ]);
    for (const key of BULK_USER_DIR_KEYS) {
      expect(dirs).not.toContain(PATHS[key as keyof typeof PATHS]);
    }
    expect(dirs).not.toContain(PATHS.exeDir);
    expect(dirs).not.toContain(PATHS.devDist);
    expect(SILENT_DIR_KEYS).not.toContain("exeDir");
    expect(SILENT_DIR_KEYS).not.toContain("devDist");
  });

  it("still scans those folders on a manual check", () => {
    const dirs = collectUpdateSearchDirs("manual", PATHS);
    expect(dirs).toContain(PATHS.desktop);
    expect(dirs).toContain(PATHS.downloads);
    expect(dirs).toContain(PATHS.documents);
    expect(dirs).toContain(PATHS.exeDir);
    expect(dirs[0]).toBe(PATHS.env);
  });
});
