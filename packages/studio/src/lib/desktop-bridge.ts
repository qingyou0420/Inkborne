/**
 * Electron preload bridge (window.fantaWriter).
 * Studio is served from the engine HTTP origin; the shell still injects
 * preload on that BrowserWindow. Do not assume the old Next 1.x desktop globals.
 */

export type CheckUpdateResult = {
  readonly ok?: boolean;
  readonly current?: string;
  readonly latest?: string | null;
  readonly hasUpdate?: boolean;
  readonly message?: string;
  readonly downloadUrl?: string;
  readonly assetApiUrl?: string;
  readonly installerPath?: string;
  readonly source?: string;
  readonly searchedDirs?: ReadonlyArray<string>;
  readonly allCount?: number;
};

export type DownloadUpdateResult = {
  readonly ok?: boolean;
  readonly path?: string;
  readonly version?: string;
  readonly message?: string;
};

export type DesktopAppInfo = {
  readonly version?: string;
  readonly isDesktop?: boolean;
  readonly isPackaged?: boolean;
  readonly platform?: string;
  readonly updateDir?: string;
};

export type DesktopBridge = {
  readonly isDesktop?: boolean;
  readonly getAppInfo?: () => Promise<DesktopAppInfo>;
  readonly getUpdateSettings?: () => Promise<{ repo?: string; hasGithubToken?: boolean }>;
  readonly checkUpdate: (opts?: { silent?: boolean }) => Promise<CheckUpdateResult>;
  readonly downloadUpdate: (opts: {
    downloadUrl?: string;
    assetApiUrl?: string;
    version?: string;
  }) => Promise<DownloadUpdateResult>;
  readonly installUpdate: (installerPath: string) => Promise<{ ok?: boolean; message?: string }>;
  readonly pickInstaller?: () => Promise<{ ok?: boolean; path?: string; version?: string | null }>;
  readonly openUpdatePanel?: () => Promise<{ ok?: boolean }>;
  readonly showAbout?: () => Promise<{ ok?: boolean }>;
  readonly openLogDir?: () => Promise<{ ok?: boolean; message?: string; path?: string }>;
  readonly openProjectDir?: () => Promise<{ ok?: boolean; message?: string; path?: string }>;
};

export function readDesktopBridge(root: unknown): DesktopBridge | null {
  if (!root || typeof root !== "object") return null;
  const win = root as { fantaWriter?: unknown; fantasyWriter?: unknown };
  const raw = win.fantaWriter ?? win.fantasyWriter;
  if (!raw || typeof raw !== "object") return null;
  const api = raw as Partial<DesktopBridge>;
  if (typeof api.checkUpdate !== "function") return null;
  if (typeof api.downloadUpdate !== "function") return null;
  if (typeof api.installUpdate !== "function") return null;
  return api as DesktopBridge;
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return readDesktopBridge(window);
}

export function updateActionsFromCheck(result: CheckUpdateResult | null): {
  canDownload: boolean;
  canInstall: boolean;
  installerPath: string;
} {
  if (!result) return { canDownload: false, canInstall: false, installerPath: "" };
  const installerPath = String(result.installerPath || "").trim();
  return {
    canDownload: Boolean(result.hasUpdate && (result.downloadUrl || result.assetApiUrl)),
    canInstall: Boolean(installerPath),
    installerPath,
  };
}
