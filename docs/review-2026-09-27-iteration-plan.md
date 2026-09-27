# 墨生万象（Inkborne）2.1.9 后全面审查与迭代方案

> **本文性质：只审查、只规划，不改任何业务代码。** 面向作者本人。
>
> 审查对象：`master` 分支 `1d7187f`（2.1.9 已发版 + 尚未发版的「四 Agent 工作流」提交），审查日期 2026-09-27。
> 审查方法：通读 `docs/` 下全部规划与复查文档、`CHANGELOG.md`；逐文件读源码（core 的 `authoring/`、`state/`、`llm/`、`pipeline/`，studio 的页面/组件/API 路由，desktop 的 `main.cjs`/`lib/`）。**没有跑 GUI**，凡属推断处会写明「需实测」。
> 每条发现都给了文件锚点，方便后续实施代理直接定位。文中「旧通路」= InkOS 原生写章管线（`pipeline/runner.ts`，书房「落墨 · 写下一章」按钮走的那条）；「新通路」= 四 Agent 落笔（`authoring/stages/write.ts`，落笔页「开始写本章」走的那条）。

---

## 〇、一段话结论

2.x 的骨架是对的：数据在本地文件里、有写锁、有原子提交、有章级快照、四步页面文案已经很像给作者用的东西。**真正拖住《醉词》这种 260 章长篇的，是三件还没做完的事**：一、**落笔现在有两条并行通路**，一条有锁有审计、一条没锁没记忆，书房的「待收伏笔 / 等你过目」只认旧通路，作者用新通路写的章它看不见；二、**新通路给模型的上下文太薄**——只喂上一章末尾 2000 字和一份只根据上一章正文写出来的状态笔记，没有跨章滚动记忆，设定超过 8000 字时挑选逻辑基本失效，写到第 200 章时模型对第 50 章发生了什么一无所知；三、**几处会丢字的口子**：落笔编辑框里的手改在切章、点「开始写本章」时会被静默扔掉，采用正文不取书锁、不原子写，`manifest.json` 一旦被截断整本书的候选稿都找不到。把这三件事收口（对应下文 PR-1 ~ PR-3），再补上流式等待、番茄导出、大书性能三块（PR-4 ~ PR-7），这个工具就能稳稳当当陪着连载到完本。

---

## 一、已经做完、本文不再重提的事

以下内容在历史文档与 CHANGELOG 中已确认交付，本文默认它们可用，不再列为问题：

- 2.0 重建：Electron 壳 + fork InkOS 内核，项目根显式、端口从 17831 扫描、单实例、退出杀引擎、AGPL 合规、`NOTICE`/`third_party/`。
- 写锁三层恢复（中止任务 → 强制释放 → 重启引擎）、`BOOK_BUSY` 卡片、truth 写入补锁（G0）；写前预检 G1；正典提案卡 G3；审稿队列 + critical 阻断 G5；文风禁表 G6；钩子 `targetChapter` 逾期。
- 旧通路写章的原子提交（`utils/atomic-file-set.ts`）、章正文 `.versions/` 历史、`.trash/`、`story/snapshots/<n>/` 章级快照、索引为空时从 `.md` 重建而不是清空。
- 书房 + 问心 / 研墨 / 织卷 / 落笔 独立页，墨·宣·朱配色，StageDot，`copy-map.ts` 白话文案，LiteraryEmpty 空态。
- 五条安装后缺陷（故事卡同步、卷纲短题/提要、落笔空态、安装图标、「新书与短篇」分组）；问心去题材模版；章页重写后刷新正文；「等你过目」白话化。
- 四 Agent 八角色配置（独立保存、连接测试、从现有配置填充、复制到另一角色）、候选稿与正式正文分开、报告绑定稿件版本、织卷分批 + 暂停/续跑、上游变更「依据有更新」提示。
- 密钥不进 git（仓库与项目根两级 `.gitignore`、CI 拒绝 tracked secrets）、密钥不走命令行参数、错误信息不带密钥。
- LLM 层：超时三段（首包 300s / 空闲 180s / 总 900s）、429/5xx 重试两次、上下文超窗时报错而不是静默截断、MiniMax / Moonshot / Responses 接口兼容。
- GitHub Release 检测 + 应用内下载安装 + sha256 校验 + 本地目录回退。

---

## 二、术语对照（作者读法）

| 文中用词 | 意思 | 落在哪 |
|---|---|---|
| 正典 | 问心整理出来、作者点过「采用」的故事根本（一句话、命题、主角、冲突、文风、边界） | `books/<id>/story/canon.md` |
| 设定目录 | 研墨产出的人物 / 地点 / 规则条目 | `story/settings/index.json` + 各条目 `.md` |
| 全书纲 / 卷纲 / 章纲 | 织卷产出；全书方向、每卷概要、每章短题+提要 | `story/outline/volume_map.md` |
| 候选稿 | 模型写出来或作者手改、尚未采用的稿件版本 | `story/workflow/artifacts/<id>/body.md` |
| 采用 | 把某个候选稿定为正式正文 | 写入 `chapters/NNNN_标题.md` + `chapters/index.json` |
| 结算 / 状态笔记 | 采用后让模型整理「这章人物状态和伏笔怎么变了」 | 新通路：`story/state/chapter-N.md`；旧通路：`story/state/*.json` + `current_state.md` |
| 等你过目 | 待审稿队列（旧通路章状态 `ready-for-review`） | 落笔页「等你过目」区 |
| 写锁 | 同一本书同一时刻只允许一个写入者 | `books/<id>/.write.lock` |
| 清单文件 | 记录每章当前候选稿 / 已采用稿 ID 的总账 | `story/workflow/manifest.json` |

---

## 三、发现清单

每条格式：**现象** → **为什么重要** → **建议改法** → 影响范围 / 工作量（小：一两个文件；中：跨 core 与 studio 若干文件；大：涉及架构决策或多包联动）/ 优先级。

### A. 写作体验与流程（长篇连载、短篇、导出）

#### A1 · 两条写章通路并存，状态互不认账 —— **P0 · 大**

- **现象**：书房的「落墨 · 写下一章」（`BookStudy.tsx` L187–194，`SerialCockpitStrip.tsx` L125）和落笔页顶部主按钮（`BookDetail.tsx` L467–475）走旧通路 `POST /books/:id/write-next`：持书锁、规划→组包→写作→观察→结算→33+4 维审计→修订→原子落盘→`ready-for-review`。同一个落笔页里下方的「开始写本章」（`AuthoringWritePanel.tsx` L172–180）走新通路 `POST /authoring/write/generate`：不取锁、单次调用、不跑审计；采用后只写一份 `story/state/chapter-N.md` 笔记（`write.ts` L247–258），**不更新** `current_state.json`、`hooks.json`、`chapter_summaries`。
- **为什么重要**：书房「待收伏笔」「等你过目」「上一章未通过」都是读旧通路的账本（`/hooks/due`、`/review-queue`、`write-preflight`）。作者用新通路写的章，这些提示要么不出现、要么还在提上一章。两条通路还在互相争同一个 `chapters/NNNN_*.md` 和 `index.json`（见 C1）。名字也没统一：按钮叫「落墨」，页面叫「落笔」。
- **建议改法**：先做一个产品决策——**把新通路定为唯一的日常写章入口**（四 Agent 规划 M5 本来就要求「移除隐式自动审查的旧分支入口」）。旧通路的能力（书锁、审计维度、结算、钩子账本）作为**内部能力**接进新通路的「审查」「采用」两步，而不是作为另一颗按钮摆在旁边。书房 CTA 与落笔顶部按钮指向同一处；「落墨」统一改叫「落笔」。旧通路的自动连载（daemon）如保留，只在 `#/daemon` 页可见并明确标注「自动模式」。
- **影响范围**：`BookStudy.tsx`、`BookDetail.tsx`、`SerialCockpitStrip.tsx`、`stage-copy.ts`、`authoring/stages/write.ts`、`authoring-routes.ts`、`pipeline/runner.ts` 的可复用片段。

#### A2 · 落笔上下文太薄，没有跨章记忆 —— **P0 · 中**

- **现象**（`authoring/context.ts` L306–351，`write.ts` L58–77）：写第 N 章时模型能看到的只有：正典（而且注入了两遍：`serializeCanonBrief` + `serializeCanon`）、设定（上限 8000 字）、本章前后一章的章纲 + 本卷概要（上限 8000 字）、**第 N-1 章末尾 2000 字**（在 context 里一次、在 generate 提示词里又一次，重复）、**第 N-1 章的状态笔记**（上限 3000 字，而这份笔记只根据 N-1 章正文 8000 字生成，不带更早的状态）。没有任何「第 1 ~ N-2 章发生了什么」的滚动摘要，没有人物当前状态账本，没有待收伏笔清单。旧通路有 `chapter_summaries`（回看 4 章）、`current_state`、`hooks`、FTS 记忆库，新通路一样没接。
- **为什么重要**：这正是长篇「人物漂移、伏笔失踪、前后矛盾」的根源。写到第 200 章时，模型对第 50 章埋的线、第 120 章死掉的人一无所知，只能靠设定条目兜底；而设定一旦超 8000 字，`pickRelevantSettings`（`context.ts` L151–163）的「相关性挑选」实际上是把每行前 12 个字去 needle 里找——中文几乎不会命中，于是退化成「取前三分之一条目」，人物设定排在后面就被砍掉。另外 `write.ts` 的提示词里**没有目标字数**（`book.json` 存了 `chapterWordCount` 但落笔不用），5000 字一章全靠模型自觉。
- **建议改法**：（1）采用某章后，除本章状态笔记外，同时维护**累计版**「人物状态账本」和「待收伏笔清单」（可以直接复用旧通路的 `current_state` / `hooks` 结构，或者最少做成一份滚动更新的 Markdown），写下一章时注入这两份，而不是只注入上一章笔记；（2）保留最近 3~5 章的**一段话摘要**（采用时顺手生成，成本极低）注入；（3）设定挑选改成按「本章章纲 + 前一章正文中出现的人名/地名」精确匹配条目标题，命中优先、其余按目录顺序补足，而不是现在的前缀匹配；（4）去掉正典和上一章尾的重复注入；（5）把 `chapterWordCount` 写进提示词并在生成后校验字数偏差，偏差大时提示作者。
- **影响范围**：`authoring/context.ts`、`authoring/stages/write.ts`、`authoring/types.ts`（如加账本 schema）。

#### A3 · 导出不适合直接贴番茄 —— **P1 · 小~中**

- **现象**（`core/src/interaction/export-artifact.ts` L111–129）：TXT 导出 = 书名 + 每章 `.md` 文件**原样拼接**，`#` 标题、`**` 加粗、`---` 分隔全都保留；整本书一个文件；没有「只导出第 N 章」；没有「复制本章到剪贴板」（全仓只有代码块组件用了 clipboard）。`work-export.ts` 里有个 `manuscriptToPlainText` 去 Markdown 的函数，但**只给短篇用了**（`short-library.ts` L241），长篇没用。
- **为什么重要**：作者每天要把一章贴到番茄后台，现在得先导出整本 → 找到那章 → 手工删 Markdown 符号。这是每天都要付的摩擦成本。
- **建议改法**：加一个「番茄 / 平台纯文本」导出预设：去 Markdown 符号、每章第一行固定为「第N章 标题」、段落间空一行、不夹带作者备注和章纲；支持**按章范围导出成多个 txt** 和「复制本章纯文本」按钮（章页与落笔面板各放一个）；保留现有 md/epub。
- **影响范围**：`export-artifact.ts`、`work-export.ts`、`ChapterReader.tsx`、`AuthoringWritePanel.tsx`、`BookDetail.tsx` 导出菜单。

#### A4 · 落笔面板旁边没有「本章要写什么」 —— **P1 · 中**

- **现象**（`AuthoringWritePanel.tsx` L125–237）：面板只有一个正文编辑框和一个「本章要求」框。本章章纲、上一章结尾、本卷进度都在织卷页 / 书房，写的时候看不见；编辑框没有实时字数、没有目标字数对照。
- **为什么重要**：连载作者写一章要反复看章纲和上一章尾——现在得来回切页。审稿意见里说「与章纲不符」，作者却看不到章纲。
- **建议改法**：面板右侧或上方加一条可折叠的「本章依据」：章纲短题+提要、上一章末尾 300 字、本卷进度（第几章 / 共几章）、当前字数 / 目标字数。这些数据 `assembleAuthoringContext` 已经算过，接口开一个只读端点即可。
- **影响范围**：`AuthoringWritePanel.tsx`、`authoring-routes.ts`（新增只读 context 预览端点）。

#### A5 · 新通路的「审查本章」是通用单次审查，比较版本是假 diff —— **P1 · 中**

- **现象**：`review.ts` L73–85 的审查提示词是一段通用文字 + 要求输出 JSON；InkOS 已有的 33+4 维连续性审计（`agents/continuity.ts`）、确定性 AI 痕迹 / 章号引用检查（`post-write-validator.ts`）、禁词表（G6）在新通路一个都没接。`diffLines`（`write.ts` L383–397）是按行号位置逐行比对，开头多插一段就整篇标红，「比较版本」形同虚设。
- **为什么重要**：作者付了审查模型的钱，却拿不到旧通路早已具备的「人设前后矛盾 / 时间线 / 视角 / 伏笔欠账」结构化维度；改稿后想看改了哪几段，看到的却是一片红。
- **建议改法**：审查提示词加入维度清单（可直接从 `continuity.ts` 的编号维度取中文名），并在模型审查前先跑确定性检查（AI 痕迹、禁词、章号、字数）合并进同一份报告；`diffLines` 换成真正的最长公共子序列行级 diff（有现成小库，或 core 里若已有 diff 工具复用）。
- **影响范围**：`authoring/review.ts`、`authoring/stages/write.ts`、`AuthoringDiffDrawer.tsx`。

#### A6 · 短篇流程是半成品 —— **P2 · 中**

- **现象**：短篇书房的三步条（问心 · 织卷 · 落笔）里织卷和落笔**不可点击**（`ShortReader.tsx` L37–41），只有问心能打开聊天；没有研墨、没有审查 / 比较 / 采用闭环；「继续写」的提示词里带着 `storyId: xxx` 英文（`work-export.ts` L31–35）。
- **为什么重要**：作者也写短篇；现在短篇 = 「聊一聊然后生成然后读」，和长篇体验落差大，假的进度条还会误导。
- **建议改法**：二选一——要么把短篇接进四 Agent 的 ask/write 两步（复用同一套候选/审查/采用），要么把假的三步条收成「对话 + 正文 + 导出」三块，别摆不能点的按钮。去掉提示词里的 storyId。四 Agent 规划已把「短篇接入」标为后续，这里只是提醒别拖太久。
- **影响范围**：`ShortReader.tsx`、`short-study.ts`、`short-api.ts`、可能的 `authoring` 短篇适配。

#### A7 · 导入旧稿没有入口 —— **P2 · 小**

- **现象**：`ImportManager.tsx` 页面（粘贴章节 / 正则分章 / 正典导入）还在，`#/import` 也能解析，但侧栏 `toImport` 没有任何地方调用，CHANGELOG 2.1.x 写的是「去掉导入入口」。导入成功提示还是英文 `Imported N chapters`。
- **为什么重要**：作者已有 260 章在番茄上；换机、重装、或想把旧稿喂给新通路做「兼容正典视图」时，唯一路径是手敲地址。
- **建议改法**：在书房「⋯ 更多工具」里放回「导入已有章节」；文案中文化；导入后自动登记为「已有成果 / 未在新流程审查」（四 Agent 规划 M5 的要求）。
- **影响范围**：`BookToolsDrawer.tsx`、`ImportManager.tsx`。

#### A8 · 没有「连写 N 章」和「过卷」 —— **P2 · 中**

- **现象**：引擎支持 `chapterCount` 连续写（`agent-tools.ts` ~L1164），UI 只有单章；卷尾没有过卷提示、下一卷卷纲入口（2.0 蓝图 §5.5 P2 项一直未做）。
- **建议改法**：在 A1 统一通路之后，落笔加「连写 2~5 章，每章写完自动审查、停在等你过目」的选项（必须能中途停）；书房在本卷最后一章采用后出现「本卷完成 → 去织卷排下一卷」提示。
- **影响范围**：`AuthoringWritePanel.tsx`、`BookStudy.tsx`、`authoring-routes.ts`。

### B. 界面与交互

#### B1 · 落笔生成 1~3 分钟只有一个灰按钮 —— **P1 · 中**

- **现象**：`/authoring/write/generate` 是同步 HTTP 请求，等模型全部写完才返回（`authoring-routes.ts` L525–536）。UI 只把按钮文字改成「正在写…」（`AuthoringWritePanel.tsx` L179），没有流式正文、没有已用时间、没有取消（`cancel` 控制文件只有织卷分批时才检查）。审查、按意见修改同样如此。织卷已经做了「进度标签 + 暂停」（`AuthoringWeavePanel.tsx` L69–90），问心聊天有流式和停止。
- **为什么重要**：5000 字一章，DeepSeek 流式要 1~3 分钟；作者不知道是卡了还是在写，只能干等；中途想改要求也停不下来，白花一次调用的钱。
- **建议改法**：generate / revise 改成「先返回 runId，正文经 SSE 或轮询逐段推到编辑框」，面板显示已用时间与已写字数，给「停止」按钮（停止后已写部分保留为候选稿）。复用织卷的 run 记录与控制文件机制，以及 `provider.ts` 已支持的 `onTextDelta`。
- **影响范围**：`authoring-routes.ts`、`authoring/stages/write.ts`、`authoring/llm.ts`、`AuthoringWritePanel.tsx`。

#### B2 · 260 章的章节表是一张平铺大表 —— **P1 · 中**

- **现象**（`BookDetail.tsx` L562–680）：所有章一张 `<table>`，不按卷分组、不能搜索、不做虚拟滚动；每行的「审稿 / 打磨」按钮 `opacity-0 group-hover:opacity-100`，鼠标不悬停就看不到。织卷页已经有按卷分组 + 过滤（`OutlineWorkspace.tsx` L151–158）。
- **为什么重要**：260 行往下翻找第 137 章很累；悬停才出现的按钮作者不一定发现；DOM 一次渲染几百行在低配 Windows 机上会卡（需实测）。
- **建议改法**：复用织卷的卷树，把章节表改为「按卷折叠 + 默认展开当前卷 + 搜索框（章号 / 标题）」，行操作常显小图标；超过 100 章启用虚拟列表。
- **影响范围**：`BookDetail.tsx`、`volume-map-tree.ts`。

#### B3 · 章页 / 分析页刷新回首页 —— **P1 · 小**

- **现象**：`use-hash-route.ts` 的 `routeToHash` 与 `HASH_PAGES` 没有 `chapter`、`analytics`、`truth` 等页（L112–150），进入章页后地址栏还是 `#/book/:id/write`，按 F5 或引擎重启后重连就回到书架。
- **为什么重要**：作者读到第 137 章刷新一下就丢位置；出问题重启引擎后无法回到原处。
- **建议改法**：给章页 / 分析页 / 真相页补 hash（如 `#/book/:id/chapter/137`），并让书房记住「上次打开的章」。
- **影响范围**：`use-hash-route.ts`、`App.tsx`。

#### B4 · 文案残留：真相文件、pid、Error:、英文 —— **P1 · 小**

- **现象**：导航里仍叫「真相文件」（`BookWorkspaceNav.tsx` L158、`use-i18n.ts` L262/406），与研墨的「设定」是同一批文件；`BookBusyCard.tsx` L31–48 显示 `pid` / `taskId`；书房和落笔页错误直接 `Error: {error}`（`BookStudy.tsx` L209、`BookDetail.tsx` L389）；`error-copy.ts` 的中文提示里还夹着 `state-degraded`、`critical`、`volume_map.md`；导入成功 `Imported N chapters`；项目设置里的 agent 名叫 `writer` / `architect`（`ProjectSettings.tsx` L466–520）。
- **建议改法**：一次「文案清扫」PR：真相 → 「设定档案」或直接并进研墨；`BookBusyCard` 只说「这本书正在被写入（已 X 分钟）」+ 三个按钮；错误统一走 `error-copy.ts` 并给出「下一步怎么做」；补齐英文残留。
- **工作量**：小。**影响范围**：studio 文案层。

#### B5 · 模型配置两套并列，一个人用一个 key 显得太重 —— **P1 · 中**

- **现象**：项目设置里既有按 InkOS agent（writer / architect / auditor…）的 `modelOverrides`，又有「四步八角色」卡（`AuthoringRolesPanel.tsx`），每个角色还有 temperature / 思考预算 / 接口格式。八个角色默认全部从项目默认模型填充。
- **为什么重要**：作者的真实场景是「一个 DeepSeek key，偶尔换 Claude 中转」；两套配置会让人怀疑「到底哪一套生效」；四 Agent 规划自己也说「八个位置允许全部相同」。
- **建议改法**：默认视图只留「连接（地址 + 密钥 + 测试）」和「主力模型 / 审查模型」两行；八角色和 agent overrides 收进「高级」；旧 `modelOverrides` 只作只读迁移来源，不再在 UI 提供编辑（等 A1 统一通路后可整体下线）。
- **影响范围**：`ProjectSettings.tsx`、`AuthoringRolesPanel.tsx`、`project-settings-model.ts`。

#### B6 · 书房缺连载作者最想看的几个数 —— **P2 · 小**

- **现象**（`BookStudy.tsx` L279–498）：有总字数、下一章、卷概要、注意事项、四步状态；没有**今日 / 近 7 天字数**、**最近一次写作时间**、**待审章数**（在落笔页才有）、**存稿数**。
- **建议改法**：从 `index.json` 的 `updatedAt` / `wordCount` 就能算出这些，加一行小字即可；「存稿 / 已发布」标记可以先做成章的一个布尔位（1.4 时代做过）。
- **影响范围**：`BookStudy.tsx`、`serial-cockpit.ts`。

### C. 稳定性与数据安全

#### C1 · 「采用此稿」不取书锁、不原子写 —— **P0 · 中**

- **现象**：`authoring-routes.ts` 全文没有 `acquireBookLock`；`persistAdoptedChapter`（`authoring/chapter-index.ts` L76–132）先归档旧版本（好），然后**普通 `writeFile` 写正文，再普通 `writeFile` 写 `index.json`**，两步之间没有原子性；`store.ts` 的 `manifest.json`、`runs/*.json`、`artifacts/*/meta.json`、`settings/index.json` 全是直接 `writeFile`；`drafts.ts` 的草稿索引同样。旧通路是 `commitAtomicFileSet`（临时文件 + rename + 失败回滚），`adoptFiles` 里明明已经引了这个函数（`store.ts` L303–310）却没在采用正文时用。
- **为什么重要**：（1）作者在书房点了「写下一章」（旧通路持锁运行中）又在落笔页点「采用此稿」，两边同时改同一个 `NNNN_*.md` 和 `index.json`，后写的覆盖先写的，索引可能丢一章；（2）Windows 上写文件中途断电 / 崩溃，`index.json` 或 `manifest.json` 半截 → 整本书候选稿全部「找不到」（见 C3）。
- **建议改法**：所有改 `chapters/`、`story/` 的新通路操作（采用正文、采用卷纲、采用正典、采用设定）统一取书锁（复用 `StateManager.acquireBookLock`），冲突时返回和旧通路一样的 `BOOK_BUSY` 卡；正文 + `index.json` + 状态笔记 + 清单一起走 `commitAtomicFileSet`；`manifest.json` / 各类 `index.json` 写入改为「临时文件 + rename」。
- **影响范围**：`authoring/store.ts`、`authoring/chapter-index.ts`、`authoring/drafts.ts`、`authoring/stages/*.ts`、`authoring-routes.ts`。

#### C2 · 手改会被静默丢掉 —— **P0 · 小~中**

- **现象**：`AuthoringWritePanel.tsx` L55–63：切换章号时直接 `setBody("")`、`dirtyRef=false`，**不保存**；点「开始写本章」时 `run("generate")` 不先 `persistIfDirty`（L172–178），生成结果回来后 candidate 变了、编辑框内容被替换；离开页面、关窗都没有提示。`ChapterReader.tsx`（L88–115）、`BookSidebar` 稿件编辑框同样只有显式保存。CHANGELOG 写的「未保存的手改会先写入当前稿」只覆盖了问心 / 研墨 / 织卷的审查、修订、采用，没覆盖落笔切章和重新生成。「不做 beforeunload 确认」在三修方案里被列为不在范围，现在该做了。
- **为什么重要**：作者手改一个小时，顺手点一下上一章看看，回来全没了。这是最伤人的丢字。
- **建议改法**：编辑框做**防抖自动保存为手改版本**（沿用现有「手改 = 新候选版本」语义，1~2 秒无输入即保存，或至少在切章 / 生成 / 离开前自动 `persistIfDirty`）；有未保存内容时切章和关窗弹确认；「开始写本章」在已有手改时提示「将基于当前手改改写 / 另起一稿」。
- **影响范围**：`AuthoringWritePanel.tsx`、`ChapterReader.tsx`、`BookSidebar.tsx`、桌面壳 `before-quit` 询问渲染层。

#### C3 · 一个坏掉的 JSON 让整本书打不开 —— **P1 · 小**

- **现象**：`manager.ts` L697–727 读 `book.json` / `inkos.json`、`store.ts` L45–49 读 `manifest.json` 等都是 `JSON.parse` 直接抛错，没有「备份一份坏文件 → 用空清单 / 从磁盘重建」的兜底；`index.json` 有重建（好），`manifest.json` 没有。
- **建议改法**：读取失败时把坏文件改名为 `*.corrupt-<时间>`，清单从 `artifacts/*/meta.json` 重建（元数据齐全，可重建），`book.json` 坏则提示作者并给出最近一次快照路径。
- **影响范围**：`state/manager.ts`、`authoring/store.ts`。

#### C4 · 退出时不等书锁 / 原子提交；日志无轮转、找不到 —— **P1 · 小**

- **现象**：`main.cjs` L296–335 退出流程 = 请求引擎中止任务 → 等 400ms → SIGTERM → SIGKILL，不等待正在进行的原子提交完成，也不提示「有任务在写」；`server.log` 用 `appendFileSync` 无限增长，`LOG_MAX_BYTES` 常量（L47）声明了但没用；应用内没有「打开日志目录」入口，出错时作者不知道去 `%APPDATA%\fantawriter\server.log` 找。
- **建议改法**：退出前若引擎持有书锁则弹「正在写第 N 章，等它写完 / 立即中止」；`server.log` 按 512KB 轮转保留 3 份；帮助菜单加「打开日志目录」「打开项目目录」。
- **影响范围**：`packages/desktop/main.cjs`。

#### C5 · 没有整书备份 / 一键打包 —— **P2 · 小~中**

- **现象**：只有章级快照与 `.versions/`；没有「把这本书打成 zip 存到别处」或定时备份；1.2 时代的 6 小时滚动备份没有在 2.0 重建；四 Agent 规划要求「接入新流程前备份一次」也未实施。`.versions/` 无上限（见 D2）。
- **建议改法**：书房「⋯」加「备份本书（zip，不含密钥）」；可选每天首次写作时自动备份一份到 `文档/幻想作家/backups/`，保留 7 份。
- **影响范围**：`server.ts` 新增路由或 desktop IPC、`BookToolsDrawer.tsx`。

### D. 性能（几十万字、几百章）

#### D1 · 落笔 / 书房每次加载都要读完整个工作流目录 —— **P1 · 中**

- **现象**：`GET /authoring/workspace`（`authoring-routes.ts` L143–188）一次性 `listArtifacts` + `listReports` + `listRuns`：逐个读 `artifacts/<id>/meta.json`、`reviews/*.json`、`runs/*.json`。每章生成 / 手改 / 修订各产生一个新 artifact 目录，260 章 × 平均 5 个版本 ≈ 1300 次小文件读取，外加所有报告与运行记录；`markReportsStale` 还会对每份报告再读一遍 artifact。落笔页、书房、每次 `refetch()` 都打这个接口。
- **为什么重要**：现在几十章感觉不到，到 200 章以后每次切页都会顿一下（Windows 机械盘更明显，需实测）。
- **建议改法**：接口按章过滤（`?chapter=N` 只回本章的版本与报告）；清单里已经记了每章当前候选 / 采用 ID，工作区概览不需要全部 artifact 列表；或在 `manifest.json` 里维护一份轻量索引。
- **影响范围**：`authoring-routes.ts`、`authoring/store.ts`、`authoring-workspace.ts`（前端）。

#### D2 · 几个只增不减、每次整读整写的文件 —— **P1 · 中**

- **现象**：（1）会话记录 `.jsonl` 每次追加都要**先读完整份**算下一个序号（`interaction/session-transcript.ts` L29–84）；（2）`chapters/.versions/` 无上限，列版本时把每个版本正文全读出来算字数（`state/chapter-workspace.ts` L89–109）；（3）`chapter_summaries.md/.json` 整文件重写；（4）单章 GET 每次 `readdir` 整个 chapters 目录（`server.ts` L3459–3471）。
- **建议改法**：序号存在 sidecar 或从文件末尾读一行；版本保留最近 N 份（如 20）+ 采用版永久；版本列表只读元数据；章路径从 `index.json` 查而不是扫目录。
- **影响范围**：core `interaction/`、`state/`，studio `server.ts`。

#### D3 · 全书检索 —— **P2 · 中**

- **现象**：没有「在全书里找一句话」的 UI；Agent 的 grep 是全盘扫 1.3M 字；FTS5 只用于资料检索。
- **建议改法**：章节正文进 FTS（Electron 内置 Node 的 `node:sqlite` 已验证可用），落笔页加搜索框；Agent grep 默认限最近 20 章。
- **影响范围**：`state/memory-db.ts`、`server.ts`、`BookDetail.tsx`。

### E. AI 调用

#### E1 · 密钥明文放在项目根里，接口还能整串读出来 —— **P1 · 小~中**

- **现象**：密钥存 `<项目根>/.inkos/secrets.json` 明文（`llm/secrets.ts`）。项目根默认在「文档/幻想作家」，作者用网盘同步、拷贝整个目录给别人看稿、或「导出项目」时会一起带走；`GET /api/v1/services/:service/secret`（`server.ts` L4771–4777）返回**完整明文**给前端回显。密钥不进 git、不进命令行、不进报错信息这几点已经做好。
- **为什么重要**：目前只监听 127.0.0.1，风险主要是「项目目录被整体拷走」。
- **建议改法**：（1）读取接口只回「已配置 / 末四位」，需要时「显示一次」；（2）密钥文件移到 `%APPDATA%\fantawriter\`（壳配置同级）或用 Electron `safeStorage` 加密后存，项目根只留服务名；（3）任何「导出项目 / 备份 zip」明确排除 `.inkos/secrets.json`；（4）设置页加一句「密钥只存在本机 X 位置」。
- **影响范围**：`llm/secrets.ts`、`server.ts` 密钥路由、`project.cjs`、`ServiceDetailPage.tsx`。

#### E2 · 新通路把 token 用量扔了，没有成本视图 —— **P1 · 小**

- **现象**：`authoring/llm.ts` L13–17 只取 `response.content`，`usage` 丢弃；`runs/*.json` 里没有 token 数；旧通路会把 `tokenUsage` 写进 `index.json`，但 UI 没有任何地方展示。
- **为什么重要**：作者用 DeepSeek 按量付费，八个角色随便一试就是钱；至少要知道「这章花了多少 token、这本书累计多少」。
- **建议改法**：run 记录加 `usage`；落笔面板显示「本次 X 万 token」；书房一行「本书累计」；模型配置页给每个连接一个「估算单价」可选字段。
- **影响范围**：`authoring/llm.ts`、`authoring/types.ts`、`AuthoringWritePanel.tsx`、`BookStudy.tsx`。

#### E3 · 八角色系统提示词过短，四步都是「一句话人设」 —— **P1 · 中**

- **现象**：`model-config.ts` L43–51 的八条默认指令每条 1~2 句；落笔的正文写作没有任何网文写法指导（视角、节奏、章末钩子、避免 AI 腔），而 core 里 `craft/`、`genres/`、`skills/` 有一整套旧通路在用的中文创作规则与禁语表，新通路完全没引用。
- **建议改法**：写作角色的系统提示词按「角色 + 本书文风（正典 voice）+ 网文通用写法 + 禁语表」四段拼；允许作者在角色卡里改「附加要求」（已有 `instructions` 字段），并把默认版本号升级以便老配置自动获得新默认。
- **影响范围**：`authoring/model-config.ts`、`authoring/stages/write.ts`、复用 `craft/`。

#### E4 · 审查要 JSON 全靠嘴说 —— **P2 · 小**

- **现象**：`review.ts` 提示词要求「只输出 JSON」，不传 `response_format`；`extractJsonObject` 靠找第一个 `{`；解析不出来记为「不完整，请重试」（好，不会崩）。
- **建议改法**：对支持的服务（DeepSeek、OpenAI 兼容）传 `response_format: json_object`，Claude 中转不传；失败重试一次并保留原文供作者看。
- **影响范围**：`authoring/review.ts`、`llm/provider.ts`。

#### E5 · 同一本书可以并发发多次生成 —— **P2 · 小**

- **现象**：新通路没有「同一本书同时只跑一个生成」的限制，连点两次「开始写本章」会开两次调用，两份候选稿互相覆盖清单。
- **建议改法**：与 C1 一起做——每本书一个生成中的 runId，第二次请求返回「正在写，请稍候」。

### F. 代码质量与可维护性

#### F1 · CI 只跑手写子集，最大的测试文件没跑，前端不做类型检查 —— **P1 · 小~中**

- **现象**：根 `pnpm test` 显式列出 ~29 个 core + ~56 个 studio 测试文件；core 实有 ~213、studio ~95 个测试文件；`authoring-rework.test.ts`（2704 行）、`pipeline-runner.test.ts`（5425 行）、`server.test.ts`（7519 行）都不在 CI 里；`typecheck` 只查 core 和 studio 的 `src/api`，**React 前端不做 `tsc`**；Playwright e2e 目录存在但 CI 不跑；根 `eslint.config.mjs` 在 2.0 重建时删了没恢复。原因之一是 FTS5 测试在系统 Node 下跑不了。
- **为什么重要**：四 Agent 那一大批修复靠的正是没进 CI 的测试；前端类型错误只能等打包后发现。
- **建议改法**：把不依赖 FTS5 的测试全部纳入默认集合（用 vitest 的 exclude 列出少数需要 FTS5 的，而不是 include 列白名单）；CI 加 `pnpm --filter @actalk/inkos-studio typecheck`；e2e 每周或发版前跑；恢复一份最小 eslint。
- **影响范围**：根 `package.json`、`.github/workflows/test.yml`、各包 vitest 配置。

#### F2 · 三个「上帝文件」 —— **P2 · 大（渐进）**

- **现象**：`studio/src/api/server.ts` 7788 行、`core/src/pipeline/runner.ts` 4195 行、`core/src/agent/agent-tools.ts` 4113 行。四 Agent 规划 §2.9 已经要求「限制继续向大文件堆逻辑」，`authoring-routes.ts` 是好的先例。
- **建议改法**：不做大重构，只定规则：新路由一律放 `api/<domain>-routes.ts`；每次动 `server.ts` 顺手把所在 domain 搬出去。
- **影响范围**：渐进。

#### F3 · 打包与依赖的几处小毛刺 —— **P2 · 小**

- **现象**：`first-run.html` 仍在 `electron-builder.yml` 打包清单里但启动已不打开；版本号在根与 desktop 两份 `package.json`（release 工作流会校验一致，尚可）；Windows 安装包未签名（SmartScreen 警告）；`@mariozechner/pi-ai` 0.67.1 在 lockfile 中已标 deprecated（上游改名 `@earendil-works/*`）；spawn 在 win32 用 `shell: true`，中文路径需持续留意。
- **建议改法**：删 `first-run.html`；依赖升级跟上游 InkOS 合流时一起做（`docs/UPSTREAM.md`）；签名等有预算再说。

#### F4 · 章节索引重建逻辑写了两份 —— **P2 · 小**

- **现象**：`state/manager.ts` L809–845 与 `authoring/chapter-index.ts` L21–58 各自实现「从 `.md` 重建 index.json」，字数算法略有差异。
- **建议改法**：新通路调用 core 的那一份，删掉重复。

---

## 四、优先级总表

| 编号 | 一句话 | 优先级 | 工作量 |
|---|---|---|---|
| A1 | 两条写章通路并存，书房账本只认旧的 | P0 | 大 |
| A2 | 落笔没有跨章记忆，设定挑选失效，无目标字数 | P0 | 中 |
| C1 | 采用正文不取书锁、不原子写，清单文件裸写 | P0 | 中 |
| C2 | 落笔手改切章 / 重新生成时静默丢失，无离开提示 | P0 | 小~中 |
| B1 | 生成 1~3 分钟无流式、无耗时、无取消 | P1 | 中 |
| A3 | 导出不适合贴番茄，无按章导出 / 复制 | P1 | 小~中 |
| A4 | 落笔旁边看不到章纲 / 上一章尾 / 字数 | P1 | 中 |
| A5 | 新通路审查无维度、无确定性检查，diff 是假的 | P1 | 中 |
| B2 | 260 章平铺大表，无分组 / 搜索 / 虚拟滚动 | P1 | 中 |
| B3 | 章页刷新回首页 | P1 | 小 |
| B4 | 真相文件 / pid / Error: / 英文残留 | P1 | 小 |
| B5 | 模型配置两套并列 | P1 | 中 |
| C3 | 坏 JSON 无兜底 | P1 | 小 |
| C4 | 退出不等锁；日志无轮转无入口 | P1 | 小 |
| D1 | workspace 接口整目录读取 | P1 | 中 |
| D2 | 会话 / 版本 / 摘要文件只增不减、整读整写 | P1 | 中 |
| E1 | 密钥明文在项目根，接口回整串 | P1 | 小~中 |
| E2 | token 用量丢弃，无成本视图 | P1 | 小 |
| E3 | 八角色提示词过短，未用现成创作规则 | P1 | 中 |
| F1 | CI 白名单子集、前端不 typecheck、无 eslint | P1 | 小~中 |
| A6 | 短篇三步条不可点，无闭环 | P2 | 中 |
| A7 | 导入旧稿无入口 | P2 | 小 |
| A8 | 连写 N 章、过卷提示 | P2 | 中 |
| B6 | 书房缺今日字数 / 待审数 / 存稿 | P2 | 小 |
| C5 | 整书备份 zip | P2 | 小~中 |
| D3 | 全书检索 | P2 | 中 |
| E4 | 审查 JSON 用 response_format | P2 | 小 |
| E5 | 同书并发生成限一 | P2 | 小 |
| F2 | 上帝文件渐进拆分 | P2 | 大（渐进） |
| F3 | 打包 / 依赖小毛刺 | P2 | 小 |
| F4 | 索引重建两份 | P2 | 小 |

---

## 五、迭代路线图与 PR 拆分

原则：每个 PR 作者都能独立人工验收；P0 三个 PR 先于任何新功能；每个 PR 都把对应的 authoring 测试纳入 `pnpm test` 默认集合（不要再往白名单里加文件名，改成 exclude）。

### 第一批 · 止血（全部 P0）

**PR-1 · 采用与清单落盘加固**（C1 + C3 + E5，顺带 F4）
- 新通路所有落盘动作取书锁；正文 + index + 状态笔记 + 清单走原子文件集；清单 / 索引临时文件 + rename；坏 JSON 备份重建；同书生成中禁止第二次生成。
- 验收：写章进行中点「采用此稿」得到「本书正在被写入」卡而不是静默覆盖；手工把 `manifest.json` 截成半截后重开应用，候选稿列表能自动恢复。

**PR-2 · 手改永不丢**（C2）
- 落笔 / 章页 / 稿件编辑框防抖自动保存为手改版本；切章、生成、关窗前自动保存或确认。
- 验收：改几个字立刻切到别的章再切回来，改动还在；改几个字直接关应用，弹确认。

**PR-3 · 写章通路统一 + 落笔记忆**（A1 + A2 + E3）
- 决策落地：书房 CTA、落笔顶部按钮、落笔面板三处指向同一条新通路；「落墨」改「落笔」；旧通路按钮下线或收进高级。
- 采用后维护累计人物状态账本 + 待收伏笔清单 + 近 3~5 章一段话摘要；写章注入这三份；设定挑选按实体名精确匹配；去重注入；目标字数进提示词并校验；写作角色提示词接 `craft/` 规则与禁语表。
- 验收：用一本 30 章的测试书，第 30 章的上下文快照里能看到第 5 章埋下的伏笔条目；设定 2 万字时人物条目不被砍掉；生成字数与目标偏差 > 30% 时有提示。
- 这是最大的一个 PR，可拆成 3a（通路统一 + 文案）和 3b（记忆与提示词）两个先后合入。

### 第二批 · 日常体验（P1）

**PR-4 · 落笔等待体验与本章依据**（B1 + A4 + E2）
- 流式正文入编辑框、已用时间、已写字数、停止；面板旁「本章依据」折叠条；run 记录存 usage，面板与书房显示 token。

**PR-5 · 番茄导出**（A3）
- 纯文本预设、按章范围多文件、复制本章；短篇同样接入。

**PR-6 · 审查升级与真 diff**（A5 + E4）
- 审查前确定性检查（AI 痕迹 / 禁词 / 章号 / 字数）+ 维度化提示词 + `response_format`；LCS 行级 diff。

**PR-7 · 大书性能**（D1 + D2 + B2 + B3）
- workspace 接口按章过滤；会话序号不整读；`.versions/` 上限 + 只读元数据；章路径查索引；章节表按卷折叠 + 搜索 + 虚拟列表；章页 hash 路由。
- 验收：造一本 300 章 × 5000 字的假书，落笔页打开 < 1 秒（需实测基线）。

**PR-8 · 密钥、日志与退出**（E1 + C4）
- 密钥接口脱敏、密钥文件迁出项目根（带一次性迁移）、导出排除密钥；日志轮转；「打开日志目录 / 项目目录」；退出前等书锁或确认中止。

**PR-9 · 文案清扫与配置简化**（B4 + B5）
- 真相 → 设定档案；BookBusy 卡白话；错误统一走 error-copy；英文残留；模型配置默认视图两行、八角色收进高级。

**PR-10 · 工程护栏**（F1 + F3）
- 测试改 exclude 制、前端 typecheck 进 CI、e2e 定期跑、最小 eslint；删 `first-run.html`。建议这个 PR 提前到第一批之前或与 PR-1 同时合入，后面的改动都需要它兜底。

### 第三批 · 完整连载工具（P2）

**PR-11 · 书房补数 + 过卷 + 连写**（B6 + A8）
**PR-12 · 短篇收口**（A6）
**PR-13 · 导入旧稿入口 + 整书备份**（A7 + C5）
**PR-14 · 全书检索**（D3）
**PR-15 起 · 上帝文件渐进拆分、上游合流、依赖升级**（F2、F3）

---

## 六、不建议现在做的事

- 不做云同步、多人协作、账号体系（四 Agent 规划已排除，仍然排除）。
- 不换 electron-updater、不做静默后台更新（现有更新链能用；GFW 镜像等有反馈再说）。
- 不再引入第三套写章逻辑；A1 之前不要给新通路加更多按钮。
- 不做语义检索 / RAG（历次结论一致：FTS + 账本够用）。
- 不为「精确计费」建系统，E2 只做 token 数显示。
- 不在 P0 完成前动大纲工作区的大重构（2.0 蓝图 P2 项，继续挂着）。

---

## 附：本文引用的关键文件

- core：`authoring/context.ts`（上下文拼装与设定挑选）、`authoring/stages/write.ts`（生成 / 审查 / 修订 / 采用 / 假 diff）、`authoring/store.ts`（清单与 artifact 落盘）、`authoring/chapter-index.ts`（采用落盘）、`authoring/review.ts`（审查提示词与 JSON 解析）、`authoring/model-config.ts`（八角色默认指令）、`authoring/llm.ts`（丢 usage）、`state/manager.ts`（书锁、索引重建、JSON 读取）、`state/chapter-workspace.ts`（版本目录）、`interaction/session-transcript.ts`（会话追加）、`interaction/export-artifact.ts`（导出）、`llm/provider.ts`（超时 / 重试 / 流式）、`llm/secrets.ts`（密钥文件）。
- studio：`api/authoring-routes.ts`（无锁、同步长请求、workspace 全量读取）、`api/server.ts`（密钥 GET、导出、单章 readdir）、`pages/BookDetail.tsx`（落笔页双按钮、平铺章节表）、`pages/BookStudy.tsx`（书房 CTA 走旧通路）、`components/AuthoringWritePanel.tsx`（手改丢失、无流式）、`components/BookBusyCard.tsx`、`hooks/use-hash-route.ts`（章页无 hash）、`lib/work-export.ts`、`lib/stage-copy.ts`（落墨 / 落笔）、`pages/ShortReader.tsx`、`pages/ImportManager.tsx`。
- desktop：`main.cjs`（退出流程、`server.log`、`LOG_MAX_BYTES` 未用）、`lib/project.cjs`（项目根与密钥文件创建）。
- 工程：根 `package.json`（测试白名单、typecheck 范围）、`.github/workflows/test.yml`、`packages/desktop/electron-builder.yml`。
- 历史文档：`2.0重构蓝图-InkOS内核桌面重建方案.md`（P1/P2 挂账、风险 R1–R8）、`墨生万象-Grokbuild设计交付包-v1.0/墨生万象-四Agent协作重构规划.md`（§3.4 落笔输入要求、§8 M4/M5 清单、§10 工程尺度）、`墨生万象-问心研墨书房三修方案.md`（beforeunload 曾列不在范围）、`CHANGELOG.md`。
