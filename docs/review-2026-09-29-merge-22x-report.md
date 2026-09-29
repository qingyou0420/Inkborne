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

## 第一轮审查返工

版本仍是 2.2.10。没有打 tag，没有改 master。五件事都在 `integrate/2.2x-into-master` 上修完。

### 1. 后台落盘改走同一把写锁

问心、研墨、织卷、影响审查改清单（研墨还改设定目录）时，不再在锁外整份覆盖 `manifest.json`。长的模型调用仍在锁外；只有落盘进 `withBackgroundBookWrite`（`packages/core/src/authoring/book-lock.ts`）。它调用原来的 `withBookWriteLock`，`waitMs` 仍是 0，没有第二把锁。进锁后重新读取最新清单或目录，只改自己那一栏再写回。

锁被占用时，后台落盘按次数和时间重试（默认 25 次、间隔 200 毫秒），可用 `AbortSignal` 取消。到上限仍拿不到锁，就抛出原来的 `BookWriteLockError`。落笔和手改继续走 `withBookWriteLock`，锁被占用立刻失败。

影响审查若是从「采用」里调用的，当时已经拿着这把锁，用 `locked: true` 直接改自己的 `watches` / `impactBaseline`，避免同一把锁重入。

涉及：`book-lock.ts`，`stages/ask.ts`，`stages/ground.ts`，`stages/weave.ts`，`stages/impact.ts`。

测试：`packages/core/src/__tests__/authoring-background-lock.test.ts`。锁被占用时落笔立刻失败、后台落盘会重试并在锁放开后成功；重试途中取消则不写入；超过次数上限抛出锁错误。问心生成与落笔采用交错时，已采用的章节不会被问心落盘盖掉。

### 2. 失败原因先打码

织卷、研墨写入 run 的 `error`，实时事件 `authoring:run` 里的 `run.error`，以及 `recordRunFailure` 打到 `console.error` 的失败原因，都先经过 `redactSecrets`。问心失败路径同样打码。打码是幂等的，不含密钥的原文不会被改掉。

涉及：`stages/weave.ts`，`stages/ground.ts`，`stages/ask.ts`，`packages/studio/src/api/authoring-routes.ts`。

测试：`authoring-run-abort.test.ts` 里假密钥 `sk-` 不会出现在织卷、研墨的 run 文件中，文件里是「已隐藏」。`authoring-routes-prf.test.ts` 覆盖推送事件、run 文件，以及 run 文件无法读取时的日志。

### 3. 取消会中止这次模型调用

`packages/core/src/authoring/run-abort.ts` 按「书 + run」登记一个 `AbortController`。取消路由先 `abortAuthoringRun` 中止该书该 run 的信号；没有登记时仍走原来的 `requestWriteRunCancel`（按 run id 中止，落笔流式任务还在用这条）。run 结束时 `endAuthoringRun` 清掉登记。

落笔流式和整理状态都登记并传入模型调用。问心生成、修订和研墨生成把同一信号传进模型调用；保存候选前再看一次信号和取消标记，已取消就不写候选。

涉及：`run-abort.ts`，`stages/write.ts`，`stages/ask.ts`，`stages/ground.ts`，`authoring-routes.ts`，`packages/core/src/index.ts`（对外导出登记函数和后台落盘）。

测试：`authoring-run-abort.test.ts` 覆盖问心、研墨在信号中止后不保存新候选，以及研墨在取消标记写下之后、模型已经返回时不保存该条。`authoring-routes-prf.test.ts` 覆盖取消路由会把已登记的信号中止。原有研墨用例改为：已经落盘的条目保留，后一条在保存前被取消则不写入。

### 4. 缺失密钥的中文提示

`API key not found for service "..."` 加进 `packages/studio/src/lib/error-copy.ts`。界面提示：还没有保存该接口的密钥，请打开「模型配置」保存密钥。

测试：`packages/studio/src/lib/error-copy.test.ts`。

### 5. 删掉没人读的上次章节

去掉 `App.tsx` 里对 `rememberLastChapter` 的写入，并删除已无调用方的 `packages/studio/src/lib/last-chapter.ts`。刷新后停在哪一章，仍只由偏好里的 `lastChapters` 决定（`BookDetail.tsx`）。`serial-cockpit` 里「上一章状态」的用例与这个文件无关，保留。

### CI 上的锁重试时间竞争

`09517e8` 的 push 测试里，`authoring-background-lock.test.ts`「前台立即失败、后台重试」失败：`expected true to be false`。该用例给后台落盘 6 次、间隔 15 毫秒，重试窗口大约 75 毫秒，却固定等 80 毫秒再断言 `done()` 仍为 false。机器一快，次数在等待结束前用完，promise 已经 reject。这是用例自己的时间竞争，产品代码没有改。

修法：后台在锁被占用期间的重试改为 200 次、间隔仍是 15 毫秒，窗口远长于观察时间；不再 `sleep` 固定毫秒，而是 `vi.waitFor` 等到 `acquireBookLock` 已被再次调用，再断言仍未结束、回调还没进去。取消用例同样先等到已经重试再 `abort`。问心落盘和采用交错的用例去掉 80 毫秒和 40 毫秒的固定等待，改为模型返回后、以及 `saveManifest` 之后，都等到下一次抢锁且 promise 仍未结束。放锁后仍要成功，且回调只进一次。`authoring-run-abort.test.ts` 本来就是 `vi.waitFor` 等到模型拿到信号再中止，没有这种窗口，未改。

## 第二轮审查返工

版本仍是 2.2.10。没有打 tag，没有改 master。三个低优先级问题都在 `integrate/2.2x-into-master` 上修完。

### 1. 落笔持锁时，后台保存会等到锁放开

`withBackgroundBookWrite` 不再对所有持锁者使用固定的 25 次 × 200 毫秒（大约 5 秒）。抢锁失败时看持锁信息里的 `stage`：落笔、审查本章、按意见修改、采用正文、整理状态、保存手改、选择稿件、恢复正文，以及带「落笔」或 `write` 前缀的阶段，改用大约两小时的上限（36000 次，默认间隔仍是 200 毫秒）。其它阶段仍是原来的短预算。锁陈旧或持锁进程已死，仍由 `StateManager` 在下一次抢锁时处理。这次 run 的 `AbortSignal` 在每次重试前和等待期间都会检查，中止时抛 `AuthoringRunCancelledError`。模型调用仍在锁外。

`withBookWriteLock` 的 `waitMs` 仍是 0。落笔和手改遇到忙立刻失败，没有改成等待。同一把锁也不变成可重入：已经持锁时再调用 `withBookWriteLock` 仍然马上失败。

到了上限并且持锁者仍是上述写作阶段时，抛 `BackgroundSaveDeferredError`，错误码 `BACKGROUND_SAVE_DEFERRED`。这个码不会被 `isBookWriteLockError` 或锁文案的模糊匹配认成普通写锁错误。`packages/studio/src/lib/error-copy.ts` 只按这个码替换成：「落笔还在进行，这次后台保存没写上，落笔写完后可以再试」。工作区、单条 run 和 `authoring:run` 事件在把失败原因交给界面前走这层映射。其它持锁者到了短预算，仍抛原来的 `BookWriteLockError`。

织卷选了方案 (a)：草稿文件先落盘，改指针失败时删掉这份还没挂上清单的草稿，并从工作流索引里去掉它。指针更新本身已经在 `withBackgroundBookWrite` 里重试；只有这次更新抛错才清理。若清单已经指向这份稿，就不删。没有选 (b) 认领：放弃之后再去认领，要额外证明目录里的稿就是这一次生成的，还要处理中止和半截索引；删掉未挂上的稿更短，下一次生成会写一份新的。

测试在 `packages/core/src/__tests__/authoring-background-lock.test.ts`：落笔持锁时，重试次数超过旧的 25 次（间隔 5 毫秒）后后台保存仍未结束，放锁后成功；这段等待里 abort 立刻以取消结束，回调不进入；不是写作阶段时默认仍在 25 次后抛 `BookWriteLockError`；落笔持锁且到了显式上限时抛 `BACKGROUND_SAVE_DEFERRED`，且不会被锁错误的模糊匹配认走。织卷改指针失败后，清单不指向新稿，工件目录里也不留 `weave-` 草稿。前台写立刻失败的原断言还在。文案映射在 `packages/studio/src/lib/error-copy.test.ts`。等待都用 `vi.waitFor` 盯着抢锁次数，不用固定 sleep 和重试窗口赛跑。

### 2. 绑定已有书时，只在锁内补问心字段

`createLightweightBook` 在「书已存在且草稿已经绑到这本书、并且带了 `fromArtifact`」这条路上，原先在锁外 `loadManifest` 再整份 `saveManifest`。现在这段包进 `withBookWriteLock`（阶段名「绑定已有书」）。这是用户前台动作：锁被占用就立刻失败，不改成后台那种长时间等待，避免建书把落笔堵住，也避免落笔把建书拖住却不给用户失败。

进锁后重新 `loadManifest`，只改 `adopted.ask`、`candidates.ask`、随之算出的 `watches` / `impactBaseline`，以及 `bookId` / `draftId`。锁外读到的旧清单不会整份覆盖回去。正典文件仍先写好；工件和清单指针都在锁内，锁被别人占用时这两样都不写。

测试在 `packages/core/src/__tests__/authoring-book-create.test.ts`：抢锁前把 weave / ground / 章数改成另一套值，绑定完成后这些字段仍是新值，问心指针换成带回的工件。另一例先占住书锁，绑定抛 `BookWriteLockError`，清单时间和 weave 指针不变，新的问心工件也不出现。

### 3. `locked: true` 必须已经持有这本书的锁

`book-lock.ts` 用 `AsyncLocalStorage` 记下 `withBookWriteLock` / `withBackgroundBookWrite` 回调里持有的 `projectRoot` + `bookId`。`bookWriteLockHeld` 只看当前异步调用栈，不把进程里别的任务持有的锁算成自己的。

`saveImpactManifest(..., { locked: true })` 在有 `bookId` 但当前上下文没持有该书锁时抛 `BookWriteLockNotHeldError`，不再直接写。没有改成「没有锁就再抢一次」：再抢一次会走 `withBookWriteLock`，而它在已经持锁时会马上失败，采纳路径就会把自己判成忙。抛错把「以为持着锁」暴露出来；`closeImpactItemsAfterAdopt` 仍接住这个错误，采纳本身不因此失败。没有书 id 时跟以前一样没有锁可拿，允许直接写。

`adoptWeave` 和 `adoptGroundEntries` 本来就是在 `withBookWriteLock` 的回调里调用 `closeImpactItemsAfterAdopt`（`weave.ts` 的 `adoptWeaveInner`、`ground.ts` 的 `adoptGroundEntriesInner`），不用改调用位置。

`closeImpactItemsAfterAdopt` 的 `console.warn` 改为只打 `redactSecrets` 之后的失败原因，不再把原始错误对象打出去。

测试仍在 `authoring-background-lock.test.ts`：持锁回调里 `locked: true` 能把影响项写成已再生，并且这次关闭不再抢锁；同一回调里再套一层 `withBookWriteLock` 仍然立刻失败。不在持锁上下文里 `locked: true` 抛 `BookWriteLockNotHeldError`，清单不被改写。采纳后的关闭失败时，警告里的 `sk-` 密钥会变成「已隐藏」。

### 4. Windows 上抢锁偶发 EPERM

释放书锁时，原先先从 `processBookLocks` 删掉本进程记录，再异步 `unlink` 删 `.write.lock`。这两步之间进程内已经没有持有者，后台重试会去独占创建锁文件。Windows 上正在删除（delete-pending）的文件再次 `open` 会报 `EPERM`（有时是 `EACCES` / `EBUSY`），不是 `EEXIST`。创建循环只把 `EEXIST` 当成锁被占用，其它错误直接抛出；`withBackgroundBookWrite` 只重试 `BookWriteLockError`，这次后台保存就失败。落笔放锁的那一瞬间后台正好重试时，产品里也会发生，不只是测试。

修法有两处，都在 `packages/core/src/state/manager.ts`。释放时先停心跳，按 token 校验后再删锁文件，然后才从 `processBookLocks` 移除本进程记录。下一个抢锁者要么仍看到持有者（`BookWriteLockError`，后台会重试，前台仍立即失败），要么看到文件已经删干净。token 对不上就不删文件，`ENOENT` 仍不告警。读文件或删除失败时在 `finally` 里移除本进程记录，避免记录永远留着把书锁死。创建锁文件的 4 次循环里，`EPERM` / `EACCES` / `EBUSY` 视为文件正在被删除或被占用，间隔 25 毫秒再试；次数用完仍失败就抛 `BookWriteLockError`，不再抛原始 `EPERM`，也不会在这一层无限重试。
