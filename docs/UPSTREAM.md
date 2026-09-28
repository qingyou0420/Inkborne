# InkOS fork / 上游

本仓 2.0 内核与 Studio 工作台 fork 自 [InkOS](https://github.com/Narcooo/inkos) **v1.8.0**。

## Pin

- 远程：`https://github.com/Narcooo/inkos`
- 标签：`v1.8.0`（见 `third_party/INKOS-UPSTREAM-TAG`）
- 提交：`52075bb97422a07315a27094c666dd87e60506b7`（见 `third_party/INKOS-UPSTREAM-COMMIT`）
- 许可证：AGPL-3.0-only（`third_party/INKOS-LICENSE`）

## 布局

| 本仓路径 | 上游 |
|---|---|
| `packages/core` | `packages/core`（`@actalk/inkos-core`） |
| `packages/studio` | `packages/studio`（`@actalk/inkos-studio`） |
| `packages/cli` | `packages/cli`（调试用 `inkos` CLI） |
| `packages/desktop` | 新：墨生万象 / Inkborne Electron 壳（原名幻想作家） |

文件版权头保持 InkOS 原样。P0 对 fork 的功能性改动（锁 TTL / force-release、显式项目根、拒绝默认 4567、truth PUT 取锁）已在对应文件中实现，并在本仓 CHANGELOG 记录。

## 合流

```bash
git remote add inkos-upstream https://github.com/Narcooo/inkos.git
git fetch inkos-upstream v1.8.0
```

后续按版本节奏择机合流。core 改动保持窄插口。

## 品牌更名

面向作者的产品名是 **墨生万象 / Inkborne**（原名幻想作家 / FantaWriter）。GitHub 仓库为 [`qingyou0420/Inkborne`](https://github.com/qingyou0420/Inkborne)（原 `qingyou0420/FantaWriter`）。内部 npm 包仍为 `@fantawriter/*`，`appId` 仍为 `com.fantawriter.app`，以免更新链路与 userData 路径断裂。安装包现名为 `Inkborne-Setup-x.y.z.exe`，检查更新同时识别旧的 `FantaWriter-Setup-*`。

## P0 hunches（2026-09-01 实测）

- **H1**：系统 Node 22.14 的 `node:sqlite` 可 `require`，FTS5 虚拟表不可用（`no such module: fts5`）。记忆检索相关测试会因此失败。同一台机器上 **Electron 37 `ELECTRON_RUN_AS_NODE` 的 `node:sqlite` 有 FTS5**。桌面引擎走 Electron 自带 Node 时记忆检索应可用。默认 `pnpm test` 排除整文件都要 FTS5 的少数用例，其余照跑；有 FTS5 时用 `pnpm test:core:full`。退路仍是捆一份带 FTS5 的 Node 22，或只换 `memory-db.ts` / `local-search.ts` 驱动。
- **H2**：Studio 生产必须预构建 `packages/studio/dist/`。桌面引擎设 `INKOS_DISABLE_VITE_BUILD=1`，缺 `index.html` 直接退出。
- **H3**：`scripts/assemble-engine.mjs` 把预构建的 `packages/studio/dist` 与 `packages/core`（dist/genres/skills/craft）装进 `dist-engine/`，再用 npm 只装引擎运行时（hono + `@actalk/inkos-core`）。`packages/desktop/electron-builder.yml` 把该树放进 `extraResources/engine`；afterPack 再整树同步一次（electron-builder 会丢掉 symlink `node_modules`，与 1.7.1 standalone 相同）。壳在 packaged 下从 `process.resourcesPath/engine/dist/api/index.js`（以及 `app.asar.unpacked` 回退）拉引擎。`pnpm dist:win` 在 Windows / `windows-latest` 上产 NSIS。
- **H4**：`@mariozechner/pi-agent-core` / `pi-ai@0.67.1` 可从 npm 装到（包已 deprecated），许可证需后续 `license-checker` 清单。
