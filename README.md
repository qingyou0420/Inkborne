# 墨生万象 / Inkborne 2.0

Windows 向的**本机桌面**长篇连载工作台（原名幻想作家 / FantaWriter）。2.0 是一次**重建**：InkOS 内核 + Electron 壳，不是把 1.7.x Next.js Studio 迁过来。

内核与 Studio UI fork 自 [InkOS](https://github.com/Narcooo/inkos) v1.8.x（AGPL-3.0）。Electron 壳负责单实例、钉端口、窗口、首启向导和退出杀引擎。稿件落在你选的项目根目录（默认 `%USERPROFILE%\Documents\幻想作家\`），标准 InkOS 布局：`inkos.json`、`books/`、`.inkos/secrets.json`。密钥只写在本机项目里，**不进 git、不进安装包**。

当前源码版本：**2.2.7**。本地构建安装包：`Inkborne-Setup-2.2.7.exe`（同时提供 `FantaWriter-Setup-*` 与 `Fantasy-Writer-Setup-*` 别名）。已公开发布的安装包见 [Releases](https://github.com/qingyou0420/Inkborne/releases)。

**[更新日志](./CHANGELOG.md)** · **[2.0 蓝图](./docs/2.0重构蓝图-InkOS内核桌面重建方案.md)** · **[上游说明](./docs/UPSTREAM.md)**

## 2.0 对作者意味着什么

- 打开书先进**连载书房**（今天写哪章、卷进度、到期/逾期伏笔），不再是 1.x Next 向导。
- **防跑偏闸**：写前大纲、正典 diff、审稿队列、伏笔逾期。
- 书锁卡死时可**强制释放**，不必为了一把锁重启整个应用。
- 双击安装包即可用；从源码则走 `pnpm start`（Electron → InkOS Studio 引擎）。

## 系统要求

- **安装包**：Windows 64 位。未签名，SmartScreen 可能拦截，选「仍要运行」。
- **从源码跑**：Node.js ≥ 22（InkOS / `node:sqlite`）、pnpm ≥ 9。桌面引擎实际跑在 Electron 自带的 Node 上（`ELECTRON_RUN_AS_NODE`）。
- **模型接口**：自备 OpenAI 兼容 API。密钥只写在项目根 `.inkos/secrets.json`。

## 从源码运行

```bash
git clone https://github.com/qingyou0420/Inkborne.git
cd Inkborne
pnpm install
pnpm build          # 编译 @actalk/inkos-core + Studio dist/
pnpm test           # CI 会跑的子集
pnpm start          # Electron；首次打开走首启向导
# 或
pnpm dev            # 缺 dist 时先 build，再开 Electron
```

引擎冒烟（无窗口）：

```bash
pnpm engine:smoke
```

打 Windows 安装包（**必须在 Windows 上**，或 CI `windows-latest`；Linux 上 electron-builder 打 NSIS 需要 wine，本仓发版不走这条路）：

```bash
pnpm dist:win
```

产物在 `dist-installer/Inkborne-Setup-2.2.7.exe`（另有 `FantaWriter-Setup-2.2.7.exe` 与 `Fantasy-Writer-Setup-2.2.7.exe` 别名）。更新扫描同时接受三套前缀。打包前会预构建 Studio、`INKOS_DISABLE_VITE_BUILD=1`，把 `packages/studio/dist` + core 装进 extraResources，并拒绝把 `.env` / `secrets.json` 打进安装包。

调试 CLI（显式根，不要靠 cwd）：

```bash
INKOS_PROJECT_ROOT=/abs/path/to/project pnpm --filter @actalk/inkos exec inkos status
```

完整上游 `packages/core` 测试套件依赖 SQLite **FTS5**。系统 Node 的 `node:sqlite` 可能没有 FTS5；**Electron 37 的 `ELECTRON_RUN_AS_NODE` 有 FTS5**（蓝图 H1）。CI 因此跑锁/桌面/引擎绑定子集；发版机再探测 Electron FTS5。有 FTS5 的 Node 上可再跑 `pnpm test:core:full`。

## 上游

见 [docs/UPSTREAM.md](./docs/UPSTREAM.md)。加 remote：

```bash
git remote add inkos-upstream https://github.com/Narcooo/inkos.git
```

## 许可证

[AGPL-3.0-only](LICENSE)。1.x 已发布的 MIT 安装包不受影响。关于页与 `NOTICE` 保留 InkOS 署名。

## 常见问题

**升级后桌面 / 任务栏仍是旧图标？** 安装包会把 Inkborne 圆标写进 `Inkborne.exe`。Windows 可能缓存同一路径 exe 的旧图（`IconCache.db`）；运行 `ie4uinit.exe -show` 或重启资源管理器即可。之前「固定到任务栏」的图钉不会随升级自动换标，取消固定再固定一次。
