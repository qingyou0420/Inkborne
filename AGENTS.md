# 轻光之集 / Lightbound 2.0 agent notes

原名墨生万象 / Inkborne，更早为幻想作家 / FantaWriter。包名与环境变量名不因改名而改。

This repo is a **desktop product**: Electron shell (`packages/desktop`) + forked InkOS (`packages/core`, `packages/studio`, `packages/cli`).

Do **not** reintroduce the Next.js 1.7.x Studio, IndexedDB `fantawriter` storage, or `src/app/**`.

- Start path: `pnpm start` / `pnpm dev` → Electron → InkOS Studio engine.
- Project root is always explicit (`INKOS_PROJECT_ROOT` / argv). Never `process.cwd()`.
- Engine port is pinned by the shell (scan from 17831). Never default to 4567.
- License: AGPL-3.0-only. Keep InkOS copyright headers.
- See `docs/2.0重构蓝图-InkOS内核桌面重建方案.md` and `docs/UPSTREAM.md`.
