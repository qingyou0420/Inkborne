const { contextBridge, ipcRenderer } = require("electron");

const desktopBridge = {
  isDesktop: true,
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke("app:getInfo"),
  getFirstRunState: () => ipcRenderer.invoke("app:getFirstRunState"),
  pickProjectRoot: () => ipcRenderer.invoke("app:pickProjectRoot"),
  saveFirstRun: (payload) => ipcRenderer.invoke("app:saveFirstRun", payload),
  testModel: (payload) => ipcRenderer.invoke("app:testModel", payload),
  restartEngine: () => ipcRenderer.invoke("app:restartEngine"),
  getEngineStatus: () => ipcRenderer.invoke("app:engineStatus"),
  probeEngine: () => ipcRenderer.invoke("app:probeEngine"),
  onEngineStatus: (listener) => {
    const wrapped = (_event, detail) => listener(detail);
    ipcRenderer.on("engine:status", wrapped);
    return () => ipcRenderer.removeListener("engine:status", wrapped);
  },
  getUpdateSettings: () => ipcRenderer.invoke("app:getUpdateSettings"),
  setGithubUpdateToken: (token) => ipcRenderer.invoke("app:setGithubUpdateToken", token),
  checkUpdate: (opts) => ipcRenderer.invoke("app:checkUpdate", opts),
  downloadUpdate: (opts) => ipcRenderer.invoke("app:downloadUpdate", opts),
  installUpdate: (installerPath) => ipcRenderer.invoke("app:installUpdate", installerPath),
  pickInstaller: () => ipcRenderer.invoke("app:pickInstaller"),
  openPath: (target) => ipcRenderer.invoke("app:openPath", target),
  openUpdateDir: () => ipcRenderer.invoke("app:openUpdateDir"),
  showAbout: () => ipcRenderer.invoke("app:showAbout"),
  openUpdatePanel: () => ipcRenderer.invoke("app:openUpdatePanel"),
};

contextBridge.exposeInMainWorld("fantaWriter", desktopBridge);
contextBridge.exposeInMainWorld("fantasyWriter", desktopBridge);
