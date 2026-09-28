# 合并审查：2.2.x 进 master（2026-09-29）

工作树：`D:\Grisia Studio\Inkborne-merge-22x`  
分支：`integrate/2.2x-into-master`（基于 `origin/master` @ `5db36bf`，合入 `origin/work/authoring-next` @ `6b6d389`）  
产品版本保持 **2.2.10**（根 / desktop / `product-version.ts`；core 与 studio 包版本仍为 1.8.0）。未打 tag、未发 release。

## 原则怎么落地

- **落笔路径以 master 为底**：单一写锁 `withBookWriteLock`、一次性采用、跨章记忆、手改自动保存、流式落笔、本章依据全部保留。
- **后台 run 接在同一把锁上**：`authoring:run` / `use-authoring-run`、取消、收尾 `settle`、卡住的 run 恢复、引擎断线恢复都走 master 的锁。上一章 `settle` 仍在跑时，先在锁外抛「正在整理第 N-1 章状态」，避免 N+1 误报 `BOOK_BUSY`。
- **界面以 2.2.x 水墨为底**：首页、书法四阶段、内置字体、阅读/历史抽屉、设置分页保留。master 的流式进度、本章依据、番茄导出、审查分组与按行对比、章节表按卷折叠与搜索、用量、退出前写入提醒接到新界面。
- **重叠机制不并存**：写下一章打开落笔页，不再从 `SerialCockpitStrip` 直接 POST 旧管线；八角色面板只出现在模型配置页。

## 冲突文件怎么解

冲突来自「两边都改过」的约 72 个路径，其中约 48 个有冲突标记。按组说明：

### 落笔 / 工作流核心

| 文件 | 解法 |
|---|---|
| `packages/core/src/authoring/stages/write.ts` | master 写锁 + 流式落笔 + 一次性采用；接入分支 `runId` / 取消 / `deferSettle` / `settleAdoptedChapter`。织卷门禁恢复为：未采用分卷则拒绝自动写正文。 |
| `packages/core/src/authoring/store.ts` | 分支 `replaceJsonFile`（同目录 tmp+rename）；列表读取改用 `loadWorkflowIndex`，**GET 不建** `story/workflow`。写入路径仍 `ensureWorkflowIndex`。 |
| `packages/core/src/authoring/context.ts` | master 跨章记忆 / 上一章状态始终加载；分支 `serializeCanonBrief` + 正典全文 + 影响审查注记。 |
| `packages/core/src/authoring/stages/{ask,ground,weave}.ts` | 逐段并集：分支问心/织卷加深 + master 审查与锁。 |
| `packages/core/src/authoring/index.ts`、`packages/core/src/index.ts` | 两边新增导出并集（含 `impact`）。 |
| `packages/core/src/llm/provider.ts` | master `jsonObjectFormatHook` + 分支 Claude 采样省略。 |
| `packages/core/src/authoring/types.ts` | 分支影响审查 schema + master 用量 / 流式 `onTextDelta` / `dimension` / `rawExcerpt`。 |
| `packages/core/src/authoring/book-create.ts` | 分支篇幅确认 + master 原子写 `book.json`。 |
| `packages/core/src/models/book.ts` | 每章字数下限取 **100**（2.2.x 短章），默认仍 3000。 |

### Studio API / 客户端

| 文件 | 解法 |
|---|---|
| `packages/studio/src/api/authoring-routes.ts` | 分支后台 `watchAuthoringWork` / run overlay / 卡住 run 恢复 + master 写锁与手改保存。工作区 GET 只读。 |
| `packages/studio/src/api/server.ts` | 下载头统一走分支 `attachmentDisposition`（含导出与 `.tar.gz`）。 |
| `packages/studio/src/hooks/use-api.ts` | 分支 `mergeInflightGet` + 温和网络错误；master `silentBookBusy` 继续下传。 |
| `packages/studio/src/lib/error-copy.ts` | 分支短暂失败中文提示 + master 写锁/密钥中文。 |
| `packages/studio/src/lib/authoring-workspace.ts` | 分支 impact 摘要 + master `workspaceQuery({ chapter, summary })` 与用量。 |
| `packages/studio/src/hooks/use-authoring-run.ts` | 保留分支后台进度。 |

### 界面（水墨为底）

| 文件 | 解法 |
|---|---|
| `AuthoringWritePanel.tsx` | 水墨文稿 + 本章依据、流式进度、复制本章、用量、`useAuthoringRun`。 |
| `BookDetail.tsx` | 水墨目录（按卷折叠/搜索）+ 落笔标题、「落笔 · 写下一章」打开本章、番茄字段、ExportMenu。写面板 `key={bookId:writeChapter ?? nextChapter}`。 |
| `BookStudy.tsx` | 水墨书房 + `summary: true`、今日一笔、用量、影响审查入口。四步网格保持 `3.5rem`。 |
| `Dashboard.tsx` | 水墨书架 + 署名 chip、`isInProgressBookStatus`、番茄导出。 |
| `ChapterReader.tsx` | 水墨阅读 + 始终可见「复制本章」。 |
| `ProjectSettings.tsx` / `ServiceListPage.tsx` | 设置分页为底；八角色与精简模型在模型配置页，项目设置只指路。 |
| `BookWorkspaceNav.tsx` | 书法四阶段 + 「设定档案」。 |
| `desktop/main.cjs` | 分支引擎断线恢复 + master 用户数据目录、日志轮转、退出前正在写入提醒。 |
| `desktop/preload.cjs` | 分支桥 + master `openLogDir` / `openProjectDir`。 |

### 版本与日志

- 四个 `package.json`、`product-version.ts`、desktop 版本断言：**2.2.10**。
- `CHANGELOG.md` / `docs/Changelog.md`：`[Unreleased]` 写合并摘要；2.2.10…2.2.1 与 master 的 2.1.10 及更早段落原样保留。

## 自动合并但双边都改过、已复查

| 文件 | 结论 |
|---|---|
| `App.tsx` | 水墨壳 + master `rememberLastChapter`。 |
| `agent-session.ts` | 分支会话恢复 + master `redirectNewChapters`（落笔不走旧写手）。 |
| `service-resolver.ts` | 分支输出预算 fallback + master 密钥中文错误。 |
| `preload.cjs` | 见上。 |

## 功能取舍与改接

1. **收尾暂停 vs 写锁**：锁语义完全用 master。上一章 settle 检查放在抢锁之前。
2. **写下一章**：打开落笔，不再 `SerialCockpitStrip.startWriteNext` 直接开写。
3. **每章字数下限**：100（短章）而不是 master 的 1000。`models.test` 改为拒绝 50、接受 300。
4. **正典上下文**：brief（含「每章字数：2800」）+ 全文 YAML。落笔测试里 `MARK-ONCE` 出现两次是预期。
5. **织卷门禁**：产品路径必须先采用分卷与章概要。master 写测试通过 `ensureAdoptedChapterPlan` 补最小织卷，不关闸。
6. **工作区 GET**：只读，不创建 `workflow`；问心 `prepare` 仍是显式 POST。
7. **八角色面板**：只在模型配置页；项目设置只保留「高级：八个角色」指路（避免与 copy-dedupe 双份）。
8. **偶发时间戳**：`action.ts` 切换模型提示用 `Math.max(Date.now(), streamTs + 1)`，并补「Date.now 刚好落到 streamTs」测试。

## 测试里改过、但不是删功能

- `p1-ia`：删掉与 master「落笔去 clutter」互斥的「header 仍要 draftOnly」重复用例；书房网格断言改为水墨的 `3.5rem`（原 master `8px` 色点列被水墨四步网格取代）。
- `authoring-ia`：落笔 panel key 与 master 表达式对齐；ProjectSettings 不再内嵌角色面板。
- 写阶段测试包装 `generateChapterDraft` 以采用最小织卷，产品闸仍在 `write.ts`。

## 还没接好 / 需要人工试

1. **真机水墨 + 流式落笔**：本章依据、边写边出字、取消、上一章 settle 未完时写下一章的提示。
2. **后台 run**：刷新页面后进度是否续上；卡住 run 恢复；取消后候选稿是否按 master「有字就留」。
3. **引擎断线**：关闭再开、唤醒慢健康、原端口被占时的 needs-attention（单测已覆盖链，未跑安装包）。
4. **正典影响审查**：改正典后书房「等你过目」与研墨/织卷入口。
5. **番茄导出**：落笔页字段、首页菜单、阅读页复制本章、中文 `filename*`。
6. **退出正在写入提醒**、密钥用户数据目录、坏 `book.json` 书架。
7. **Windows 带空格路径打包**：此次未打安装包。
8. 本环境无 Electron 窗口，界面只靠源码契约测试与 `pnpm build`，**没有浏览器点选验收**。

## 检查结果

| 命令 | 结果 |
|---|---|
| `pnpm install` | 通过（工作树内已有 node_modules） |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm test` | 通过（core / studio / cli / desktop） |
| `pnpm build` | 通过 |

未升版本、未打 tag、未推 master。原目录 `Inkborne`（`work/authoring-next`）与 `Inkborne-grok-p1`（`master`）未改分支。
