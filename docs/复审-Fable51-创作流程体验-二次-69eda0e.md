# 墨生万象（Inkborne）· 创作流程体验二次复审（PR-F 之后）

> 状态：**二次复审报告。** 基线 `work/authoring-next` @ `69eda0e`（已合 #127–#132；#132 = PR-F，对应上次复审 `docs/复审-Fable51-创作流程体验-c15095c.md` 的 F-a…F-e）。逐项以源码核实「意图是否落地」，行号一律以函数名判断。
> 本文**不改任何产品代码**，只提交这份报告。不涉及水墨 UI 方案、P1-7 / P2、视觉重设计，未跑真模型。

---

## 〇、结论（先读这里）

1. **创作流程轮收口，可进入水墨 UI 方案轮。** 上次判定「不能收口」的两条 P0 口径——「进程退出后重开面板锁死」与「唯一建书路径成书后丢聊天会话」——在 PR-F 里都已按意图落地，且有代码测试覆盖；日常动线「空聊 → 采用并建书 → 研墨 → 织卷 → 落笔」从源码逐段走了一遍，没有再发现会把作者卡住、或让流程自相矛盾的路径。
2. **F-a…F-e 五项全部通过**（对照表见「一」）。核心机制：`registerAuthoringRoutes` 记 `serverStartedAt`，`GET /authoring/runs/:id` 与 `GET /authoring/workspace` 读到 `running/pausing` 且 `updatedAt < serverStartedAt` 的记录时改写为 `failed`（中文原因「Studio 重启时这次运行已中断，请重新发起。」）并广播；`ask/adopt` 成书后 `migrateBookSession` + `book:created{stage:"ask"}`；面板按 stage/scope 挑「上一次运行」、按 operation 分派重试；所有 `wait=false` 路由先落 `running` 记录；过期测试改写并纳入 `pnpm test` 白名单。
3. **「写章中途进程退出 → 重开」不再锁死。** 推演与临时用例都确认：桌面壳 `window-all-closed → stopEngine(SIGTERM)` 杀掉引擎后，磁盘留下 `running`；重开后 `/authoring/workspace` 先把它改写为 `failed`，`AuthoringWritePanel` 的 `selectScopedAuthoringRun(runs,"write","chapter:N")` + `shouldAutoTakeoverAuthoringRun`（failed ≤10 分钟接管）只在**本章**显示「已中断 + 重试」，`locked = busy || authoringRun.active` 为假，编辑 / 审查 / 采用 / 创作本章全部可用；其他章不受影响。问心 / 研墨 / 织卷同理（织卷的 `failed` 还保留「继续剩余范围」）。
4. **仍有 B/C 级摩擦，不阻塞收口，可与 UI 轮并行或后置**（见「三」）。最值得先做的一小撮：(B-1) 「放弃这次运行」对问心 / 研墨 / 落笔的**活跃** run 是空操作（core 只有织卷读取 control 文件）；(B-2) 采用第 N 章后 N+1 立刻可写，若在 N 的状态整理（settle）结束前就「创作本章」，N+1 提示词会缺【上一章状态】，且 settle 失败 10 分钟后在界面上再无痕迹、也没有「重新整理状态」入口；(B-3) 研墨批量生成只在循环结束时落盘目录，中途退出会丢掉已生成条目的挂接。三项都是小改，合起来 < 150 行，建议作为 UI 轮的第一个并行小 PR（PR-G-lite），不作为收口条件。
5. 验证：`pnpm test`（CI 白名单，含 F-e 新增的 6 个文件）全绿：llm-compat 106 + core 315 + desktop 64 + studio 461 + authoring-ui 119 + build 1，共 1066 例；另单跑 `authoring-routes-prf`(6) / `authoring-routes-background`(14) / `authoring-run-selection`(7) / `use-authoring-run`(2) / `server.test`(174) / `authoring-rework`(44) 全部通过。真模型实机留给用户（见「四」建议路径）。

---

## 一、F-a…F-e 对照表

判定口径：「通过」= 上次复审「四」表中该项的验收意图在代码路径上成立且有代码测试；「通过·备注」= 成立但有不影响收口的边角；「未通过」= 意图未成立。

| 项 | 上次要求（摘要） | 源码核实 | 测试证据 | 判定 |
|---|---|---|---|---|
| **F-a** 孤儿 `running` 回收 + 放弃按钮 | `serverStartedAt`；`/runs/:id` 与 `/workspace` 读时把 `running/pausing && updatedAt < serverStartedAt` 改写为 `failed` + 中文原因 + SSE；进程内活跃表，cancel 对表外 run 直接标 `cancelled`；问心 / 研墨 / 落笔加「放弃这次运行」，织卷加「取消」 | `authoring-routes.ts`：`registerAuthoringRoutes` 首行 `serverStartedAt = new Date().toISOString()`、`activeRunIds = new Set<string>()`；`reclaimOrphanRun` 用 ISO 字符串比较（`saveRun` 总以 `nowIso()` 盖写 `updatedAt`，所以比较可靠），改写后 `saveRun` + `emitAuthoringRun`；`/workspace` 对 `listRuns` 每条 `reclaimOrphanRun`，`/runs/:runId` 同样；`watchAuthoringWork` / `awaitAuthoringWork` 在 `finally` 删除活跃表项；`/runs/:id/cancel`：表内写 control，表外 `running/pausing` 直接 `cancelled` 并广播。前端：`AskCanonPanel` / `AuthoringGroundPanel` / `AuthoringWritePanel` 在 `authoringRun.active` 时渲染 `data-testid="authoring-abandon-run"`「放弃这次运行」→ `POST /runs/:id/cancel`；`AuthoringWeavePanel` 在 `running && activeRunId` 时加「取消」。桌面壳 `packages/desktop/main.cjs` `window-all-closed / before-quit → stopEngine`，确认关窗即产生孤儿场景 | `authoring-routes-prf.test.ts`：pre-start running → GET 返 failed + 原因 + SSE；workspace 读时改写（pausing）；dead run cancel → cancelled + SSE。`authoring-ia.test.ts` 断言四个面板含放弃 / 取消按钮。本文另用临时用例（已删除，不入库）验证：3 小时前的 `running` + 一条更新的 `completed`（第 2 章）同时存在时，第 1 章选中 failed 且 `shouldAutoTakeover=true`、`isAuthoringRunActive=false`，第 2 章不受影响；二次读取不再改写 | **通过·备注**。备注：「放弃」对**活跃**的问心 / 研墨 / 落笔 run 只写 control 文件，而 core 只有 `weave.ts`（`generateWeaveRange` 循环、`reviseWeave`）读取 `loadRunControl`，`ask.ts / ground.ts / write.ts` 不读 → 活跃 run 会跑到模型返回为止，按钮无可见效果（B-1）。孤儿场景（本项的 P0 目标）不受此影响 |
| **F-b** 采用并建书迁移会话并广播 | `ask/adopt` 在 `created` 且草稿有 `sessionId` 时 `migrateBookSession`（忽略 `SessionAlreadyMigratedError`）+ 广播 `book:created`；`bookCreatedRoute` 落到问心 | `authoring-routes.ts` `ask/adopt`：`result.created && body.draftId` → `loadDraft` → `draft.sessionId` → `migrateBookSession(deps.root, sessionId, bookId)`（catch 仅放过 `SessionAlreadyMigratedError`）→ `deps.broadcast("book:created", { sessionId, bookId, canonCandidate:false, stage:"ask" })`；`server.ts` 注册时传入 `broadcast`。`AskCanonPanel.adoptCurrent` 的请求体 `{...scope}` 含 `draftId`；`ensureAuthoringDraft` 持久化 `sessionId`（`drafts.ts`）。`use-session-events.ts` `bookCreatedRoute(page,bookId,canonCandidate,stage)`：`stage==="ask" || canonCandidate → book-ask`；store 侧把 session 迁到新 `bookKey`、`sessionKind:"book"`。`ChatPage` `mode="book"` 进入新书时 `loadSessionList(bookId,true)` 从服务端读，迁移在 HTTP 响应前已落盘，`isAskSession(session,bookId)` 对 `sessionKind:"book"` 为真 → 对话原样出现；`App.tsx` `onAdopted → nav.toAsk(id)` 与 SSE 路由目标一致，无双跳 | `authoring-routes-prf.test.ts`：adopt created → `migrateBookSession(root,"sess-1","新书")` 被调 + `book:created{stage:"ask"}`；已迁移异常被忽略仍广播。`use-session-events.test.ts`：`bookCreatedRoute("book-create",id,false,"ask") → book-ask` | **通过** |
| **F-c** 「上一次运行」按 scope/operation 收窄；重试按 operation 分派 | 落笔只认 `scope==="chapter:N"`；重挂载只自动接管 `running/pausing`（failed 限本会话或 10 分钟内）；重试 settle → `/write/settle`、review → 重新审查、其他 → 重新生成；问心 / 研墨同法 | 新增 `lib/authoring-run-selection.ts`：`selectScopedAuthoringRun(runs,stage,scope?)`、`shouldAutoTakeoverAuthoringRun`（live 恒真；failed/partial 仅 `updatedAt` 在 10 分钟内）、`writeRetryAction / askRetryAction / groundRetryAction`、`producedArtifactForScope`。`AuthoringWritePanel`：`lastWriteRun = selectScopedAuthoringRun(data.runs,"write",\`chapter:${n}\`)`；`retryFailedRun` 按 operation 分派，settle 取 `run.producedArtifactIds[0] ?? settleArtifactId`；`pendingSavedId` 前用 `producedArtifactForScope` 校验 scope。`AskCanonPanel` / `AuthoringGroundPanel` 同样接入。`BookDetail` 以 `key=${bookId}:${activeChapter}` 挂载写面板，切章即重挂载，settle run（scope `chapter:N`）不再锁 N+1。core `write.ts` 的 generate / review / revise / settle 记录均带 `scope` | `authoring-run-selection.test.ts`（7）：第 5 章 review 失败不出现在第 7 章；仅接管 live 与近期失败；三阶段分派；产物 scope 校验。`authoring-routes-background.test.ts`：adopt 起后台 settle、settle 重试返 runId | **通过·备注**。备注：① 路由层 `emptyRun` 对 `write/review|revise|adopt|settle` 未填 `scope` 与 `producedArtifactIds`，core 在数十毫秒后自己的 `persistRun` 才补上；若恰在这一窗口失败（如「找不到要审查的正文」），失败记录无 scope，重挂载后不会显示（本会话内仍经 `activeRunId` 轮询显示）——边角（C）。② 与 F-6 的关系见 B-2 |
| **F-d** `wait=false` 路由先落 `running`；空 targets 直接 completed；连续 404 停轮询并显示 | 所有 `wait=false` 路由返回前 `saveRun(running)`；`generateGroundEntries` 空 targets → completed；`useAuthoringRun` 连续 N 次 404 停止并显示 | `authoring-routes.ts`：`emptyRun()` 工厂 + `persistStartingRun()`（saveRun + 广播），`ask/generate|review|revise`、`ground/catalog|generate|review|revise`、`weave/structure|generate|review|revise`、`write/generate|review|revise|adopt|settle` 全部先落记录；`startAuthoringWork` 用 `Promise.resolve().then(workFactory)` 把同步抛错转为拒绝再 `recordRunFailure`。`ground.ts`：循环后 `if (targets.length === 0) await persistRun("completed")`。`use-authoring-run.ts`：`AUTHORING_RUN_NOT_FOUND_LIMIT = 10`、`keepPollingAuthoringRunError`；`pollWeaveRun` 新增 `keepPollingOnError`；三面板渲染 `authoringRun.error`（落笔并入 `error` 行，问心 / 研墨 `role="alert"`） | `authoring-routes-prf.test.ts`「saves a running record before a wait=false core throw…」；`authoring-routes-background.test.ts` 断言 `wait=false` 后磁盘已有 `running`；`authoring-ground.test.ts` 空 targets → completed；`use-authoring-run.test.ts` 10×404 停止、其他错误继续 | **通过** |
| **F-e** 过期测试清理并纳入 CI | `server.test.ts`、`authoring-rework.test.ts` 全绿并进入 `pnpm test` | 根 `package.json` `test` 白名单新增 `authoring-rework`、`server.test`、`authoring-routes-background`、`authoring-routes-prf`、`use-authoring-run`、`authoring-run-selection`。`authoring-rework.test.ts` R13-01 / R15-* / R16-01 改为 volume-first（先 `generateWeaveStructure` 再章概要，手工把作者备注与范围节点种回结构候选）；`server.test.ts` 夹具补 `canon.md` + `candidates.ask`，使遗留 confirmed `create_book` 路径被识别为四阶段书 | 本机 `pnpm test` 全绿（数字见「〇·5」）；单跑 `server.test`(174/174)、`authoring-rework`(44/44) | **通过** |

PR #132 自述的三处偏离（failed/partial 10 分钟接管、rework 用例改 volume-first、遗留 `create_book` 路径保留）都在上次复审给出的选项内或不影响意图，本文接受。

---

## 二、日常写作动线复扫

按「空聊 → 采用并建书 → 研墨 → 织卷 → 落笔」逐段核对，只记录与上次相比有变化、或本次重点验证的部分。

| 段 | 关键路径 | 判定 |
|---|---|---|
| **空聊** | `#/book/new` → `ChatPage mode="book-create"` 复用或新建 `book-create` 会话并 `setBookCreateSessionId`；右栏 `AskCanonPanel` `ensureDraft({sessionId})` 拿到 `draftId`。聊天只讨论（P0-1 未变） | 正常 |
| **整理正典 → 采用并建书** | 「整理正典」→ `ask/generate`（先落 running，返 runId，面板轮询）；「采用并建书」缺篇幅弹「确认全书篇幅」（P0-1 未变）→ `ask/adopt{draftId}` → `createLightweightBook + bindDraft` → **迁移会话 + 广播**（F-b）→ 响应 → `onAdopted → nav.toAsk(bookId)`；SSE 同步把 store 里的 session 挪到新书并（若仍在 `book-create` 页）跳 `book-ask`。新书问心页 `loadSessionList` 从服务端拿到已迁移的会话 → **对话还在**；`#/book/new` 列表不再有 `bookId=null` 的孤儿 | 正常（上次 F-3 已闭合） |
| **研墨** | 「根据正典拟定设定目录」/「补全剩余 N 项」→ `ground/catalog|generate`（先落 running）；`blocked = busy || authoringRun.active || …`；失败 / partial 显示原因 + 「重试」（按 operation：review → 审查、无条目 → 目录、否则生成）。中途退出 → 重开：workspace 读时改写 failed → 不再 `blocked`，显示「Studio 重启时这次运行已中断」+ 重试 | 正常。备注 B-3：`generateGroundEntries` 只在循环**结束**后 `saveSettingsCatalog`，中途退出时已生成条目的 artifact 在盘上但目录未挂接，重试会把这些条目再生成一遍 |
| **织卷** | 门禁 `lengthMissing`（P0-4 未变）；「生成分卷规划」→ `weave/structure`；「生成本卷章概要」→ `weave/generate`（候选或已采用任一含合法卷即可，P1-1 未变）；审查仍 `wait:true`（#131 止血，未后台化，F-7 为 B）。中途退出 → 重开：`lastWeave` 为 failed → `running=false`、`canResume=true`（failed 也可「继续剩余范围」，checkpoint 的 `missingChapters` 在记录里） | 正常。备注：`canResume` 不看 operation，failed 的 review run 也会显示「继续剩余范围」，点了得到 400「没有可恢复的范围」（C） |
| **落笔** | 目录合并规划章与候选状态（P1-3 未变）；「创作本章」→ `write/generate`（先落 running，scope `chapter:N`）；采用 → 同步写盘 + 后台 settle（scope `chapter:N`）→ toast「写下一章」→ 切章重挂载。**写章中途进程退出 → 重开**：详见下段 | 正常。备注 B-2 |

### 「写章中途进程退出 → 重开」逐步推演

1. 点「创作本章」→ `POST /authoring/write/generate`（`wait` 缺省 false）→ 路由 `persistStartingRun(emptyRun{stage:"write", operation:"generate", scope:"chapter:N", status:"running"})` → 返回 `{runId, status:"running"}` → 面板 `setActiveRunId`，`locked=true`，状态栏「正在写第 N 章 · 已 Xs」+「放弃这次运行」。
2. core `generateChapterDraft` 自己再 `writeRun(running)`（`saveRun` 盖写 `updatedAt=now`），随后进入模型调用，期间**不再更新** `updatedAt`。
3. 关窗 / 崩溃 / 断电：桌面壳 `window-all-closed → stopEngine(SIGTERM/SIGKILL)`，引擎进程结束；磁盘留下 `status:"running"`，`updatedAt = T_run`。
4. 重开：新引擎进程 `registerAuthoringRoutes` 记 `serverStartedAt = T_boot > T_run`。落笔页挂载 → `GET /authoring/workspace?bookId=…` → `listRuns` → `reclaimOrphanRun`：`running && updatedAt < serverStartedAt` → 改写 `failed`、`error="Studio 重启时这次运行已中断，请重新发起。"`、`saveRun` + `authoring:run` SSE → 响应里的 `runs[]` 已是 failed。
5. 面板：`lastWriteRun = selectScopedAuthoringRun(runs,"write","chapter:N")` 命中；`shouldAutoTakeoverAuthoringRun`（failed 且 `updatedAt` 刚被盖写为 now → ≤10 分钟）→ `setActiveRunId`；`useAuthoringRun` 首次轮询即得 failed → `settled` → `setFailure(error)`；`authoringRun.active=false` → `locked=false`。状态栏显示中文原因 + 「重试」，编辑 / 审查 / 采用 / 创作本章全部可用；「重试」→ `writeRetryAction("generate")` → 重新生成本章。
6. 其他章：`scope` 不匹配 → 不接管、不显示。研墨 / 问心 / 织卷同一条路径。
7. 兜底：即使某条 `running` 因任何原因没被改写（例如时钟回拨使 `updatedAt > serverStartedAt`），作者仍可点「放弃这次运行」→ `/runs/:id/cancel` → 该 runId 不在活跃表 → 直接标 `cancelled` + 广播 → 面板解锁。上次「只能手删 `runs/*.json`」的死局已不存在。

本文用一个临时 vitest 用例（Hono 内存路由 + 真实文件系统）复现了第 4–6 步（含「第 1 章孤儿 + 第 2 章更新的 completed」并存的情形），通过后已删除，不入库。

---

## 三、不阻塞收口的剩余项

分级：**B 下一轮（可与 UI 轮并行）** / **C UI 轮顺手** / **D P2**。没有 A 级。

### B · 建议作为 UI 轮的第一个并行小 PR（PR-G-lite，全部小改）

- **B-1 「放弃这次运行」对活跃的问心 / 研墨 / 落笔 run 无可见效果。** 路由对活跃 run 只写 control 文件，而 `ask.ts / ground.ts / write.ts` 从不读 `loadRunControl`（只有 `weave.ts` 读）。单次模型调用的 run 会跑到返回为止（1–3 分钟），研墨批量生成会把剩余条目全部跑完。面板此时不变、仍锁定。修法：`generateGroundEntries` 每条之间读 control，`cancel → persistRun("cancelled")` 并 `return`；问心 / 落笔在 `completeRole` 返回后读一次 control，为 `cancel` 则不落 artifact、记录标 `cancelled`（模型花费已发生，但不产生候选、面板即刻解锁）。或者最省事的一版：路由对活跃 run 也**直接改写为 `cancelled` 并广播**，让 core 之后的 `persistRun` 盖写成 completed/failed 也无妨——面板已经解锁，多出来的候选作者可以忽略。
- **B-2 采用第 N 章后 N+1 立即可写，与 N 的状态整理（settle）竞态；settle 失败无长期痕迹。** PR-F 把落笔的「上一次运行」限定到本章 scope 后，切到 N+1 的面板不再被 N 的 settle run 锁住（上次 F-6 的过度锁定顺带消失），但 `assembleAuthoringContext(write, N+1)` 的【上一章状态】来自 `loadChapterState(N)`，settle 未完成时为空。toast「写下一章」→「创作本章」在 settle 的几十秒内点下去是正常操作节奏，因此 N+1 的提示词有一定概率缺这一段（仍有上一章结尾 2000 字与大纲，不是跑偏的充分条件，但与「百万字不跑偏」相悖）。另外 settle 失败时 `invalidateChapterState` 删掉状态文件并把 run 标 failed，10 分钟后 `shouldAutoTakeoverAuthoringRun` 不再接管，界面上再看不到、也没有「重新整理状态」的入口（「采用」在 `candidate.artifactId === adoptedId` 时禁用）。修法：① 落笔面板额外取 `selectScopedAuthoringRun(runs,"write",\`chapter:${N-1}\`)`，若其 `operation==="settle"` 且 active，仅禁用「创作本章 / 重新生成」并显示「正在整理第 N-1 章状态，完成后可写下一章」（编辑 / 阅读不锁，即上次 F-6 的建议）；② `mergeWriteDirectory` 或 workspace 增加「已采用但状态缺失」标记（`adopted.write[N]` 存在而 `story/state/chapter-N.ref.json` 缺失或不匹配），目录项显示「状态未整理」，「⋯」菜单加「整理状态」→ `/write/settle`。
- **B-3 研墨批量生成只在循环结束后落盘目录。** `generateGroundEntries` 每条成功后 `entry.candidateArtifactId = artifactId`，但 `saveSettingsCatalog` 在循环之后；中途退出（这类 run 常达数分钟，比写一章更容易被关窗打断）→ artifact 在盘、目录未挂接 → 重开后条目仍显示「未生成」，重试会重新调用模型。修法：把 `await saveSettingsCatalog(input.root, catalog)` 移入循环，每条之后写一次（一行移动）。
- **F-7 织卷审查仍是同步 `wait:true`**（上次止血保留）。后台化时按研墨模式接 `isBackgroundAuthoringStart`，并让 `canResume` 只对 `operation==="generate"` 的 partial/paused/failed 显示「继续剩余范围」。
- **织卷 resume 路径不进活跃表**：`/runs/:id/resume` 的 generate 分支同步 `await generateWeaveRange`、revise 分支 `void work.catch(...)`，都没有 `activeRunIds.add`；此时「取消」会走「表外 run 直接标 cancelled」路径，core 继续跑并在下一次 `persistRun` 盖回 running。让 resume 也经 `watchAuthoringWork` 即可。
- **P1-8 文案与 `inferGroundDone` 过早打勾**（上次已列，未动），随 UI 轮。

### C · UI 轮顺手

- 路由层 `emptyRun` 对 `write/review|revise|adopt|settle` 补 `scope: loaded.meta.scope`（需先 `loadArtifact`）与 `producedArtifactIds: [artifactId]`，让核心层落记录前的失败也带 scope，settle 孤儿的「重试」在任何窗口都能走 `/write/settle` 而不是回落到「重新生成」。
- 研墨 `catalog` run 的 `operation` 与 generate 同为 `"generate"`，`groundRetryAction` 只能靠「是否已有条目」猜；给目录拟定单独的 operation 或 progressLabel 判定。
- 问心 `askRetryAction` 对 `revise` 失败回落为 `generate`，丢失修订意图；可在失败记录里带 `reportId` 时重开修订对话框。
- F-9 落笔目录数百章平铺、后台审查进行中抽屉显示「还没有审查报告」、后台 run 进度靠轮询——均为上次 C 项，未变。

### D · P2

- `SessionAlreadyMigratedError` 被忽略时仍按新 `bookId` 广播 `book:created`；若该会话此前已迁到别的书，store 会被误挪——仅在极端复用场景出现。
- `diffLines` 逐行位置比对、问心整理全量重发对话、`thinkingBudget` 无界面、`/books/:id/audit/:n` 未加四阶段门禁——上次 D 项未变。

---

## 四、验证方法与测试现状

- 静态阅读：`packages/studio/src/api/authoring-routes.ts`（全文）、`packages/studio/src/{lib/authoring-run-selection,hooks/use-authoring-run,hooks/use-session-events,lib/weave-editor-state}.ts`、`packages/studio/src/components/{AskCanonPanel,AuthoringGroundPanel,AuthoringWritePanel,AuthoringWeavePanel}.tsx`、`packages/studio/src/pages/{ChatPage,BookDetail}.tsx`（会话选取 / 面板挂载段）、`packages/core/src/authoring/{store,context,drafts}.ts`、`packages/core/src/authoring/stages/{write,ground}.ts`、`packages/core/src/interaction/book-session-store.ts`（`migrateBookSession`）、`packages/desktop/main.cjs`（引擎生命周期）。
- 提交历史：`git log 0549bb6..69eda0e`（#132 两个提交）与 PR 描述。
- 本地测试（`pnpm install --frozen-lockfile` + `pnpm --filter @actalk/inkos-core build` 后）：
  - `pnpm test`（CI 白名单）：全绿，llm-compat 106、core 315、desktop 64、studio 461、authoring-ui 119、build 1。
  - 单跑：`authoring-routes-prf`(6) / `authoring-routes-background`(14) / `authoring-run-selection`(7) / `use-authoring-run`(2) / `use-session-events`(3) / `authoring-ia`(5) / `weave-write-handoff`(8) / `weave-editor-state`(11) / `ask-page`(6) / `p2-ask-ground`(5) / `use-book-stage`(6) / `p1-5-deep-pages`(10)；`server.test`(174)；core `authoring-rework`(44) / `authoring-ground`(7) / `authoring-write`(4) / `authoring-weave`(44) / `authoring-ask`(3) / `authoring-book-create`(3) / `authoring-store`(1)。全部通过。
  - 临时用例（Hono + 真实文件系统，复现「孤儿 running + 更新的 completed 并存 → 重开」）通过后已删除。
- 未运行真模型。建议用户实机至少走一遍：新书从空聊到「采用并建书」→ 新书问心页仍有原对话、`#/book/new` 无孤儿 → 研墨补全 → 织卷分卷 + 两卷概要一次采用 → 落笔写第 1 章中途关窗 → 重开落笔页按钮可用、状态栏「Studio 重启时这次运行已中断」+ 重试。

---

## 附 · 收口判断依据

上次不收口的两条理由：「可离开的另一半——离开后（含进程退出）回来能恢复或放弃——没有」与「唯一建书路径成书后丢聊天上下文」。前者现在有两层兜底（读时回收 + 表外 cancel 直接标 cancelled），后者在路由层迁移并广播、前端沿服务端会话列表自然接上。P0-1 / P0-2 / P0-4 / P0-5 与 P1-1～P1-6 的判定与上次一致，PR-F 没有触碰它们的路径。剩余的 B 项都属于「运行更省、上下文更全、按钮更诚实」，没有一项会把作者卡住或让两条流程互相打架，因此创作流程轮收口，进入水墨 UI 方案轮；PR-G-lite（B-1～B-3）建议与 UI 轮并行，不设为前置条件。
