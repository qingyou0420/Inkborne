# 更新日志

本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 记录对用户可见的改动。安装包在 [Releases](https://github.com/qingyou0420/Inkborne/releases) 下载。本软件中文名「墨生万象」，英文名 Inkborne（原名幻想作家 / FantaWriter）。

## [Unreleased]

## [2.1.10] - 2026-09-28

Windows 安装包：`Inkborne-Setup-2.1.10.exe`（同时上传 `FantaWriter-Setup-2.1.10.exe` 与 `Fantasy-Writer-Setup-2.1.10.exe` 别名）。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。`appId` 仍为 `com.fantawriter.app`。

本版带来四 Agent 创作工作流，并合入 2.1.9 之后全面审查的 P0（#147）与 P1（#154）两批改动。

### 新增

- 四 Agent 创作工作流（问心 / 研墨 / 织卷 / 落笔）：每一步都是生成 → 审查 → 按意见修改 → 采用，八个角色可以各配模型。
- 问心生成可编辑的正典，页面右侧是正典栏；首次采用只轻量建书，不再顺带跑设定和卷纲。
- 研墨按目录分项生成、采用；织卷按目标章数分批覆盖；落笔的候选稿与正式正文分开，审查意见可以勾选后按指定报告改稿，也可以比较版本。
- 落笔边写边出字：显示已用时间和字数，随时可以「停止」；停下或中途连接失败时，已经写出的正文会存成候选稿。
- 落笔面板新增「本章依据」折叠条：章纲短题与提要、上一章末尾约 300 字、本卷进度、当前字数 / 目标字数。
- 番茄纯文本导出：去掉 Markdown 标记，章题统一为「第N章 标题」，可按章范围导出成一个文件或每章一个文件；落笔面板和章页都能「复制本章」。章范围填错时会提示，不再静默导出全书。
- 审查本章先做一遍自动检查（套话、禁语、章号、字数），报告按情节推进、人物一致、伏笔、节奏、文笔分组；版本对比改为真正的逐行差异。
- 用量显示：落笔显示「这次用了 … token」，书房显示「这本书累计用了 …」。连接设置可选填估算单价（元 / 百万 token），填了才折算金额。
- 关闭应用时如果这本书正在写入，会先提示，可以等它写完或立即中止。帮助菜单和项目设置可以直接打开日志目录和项目目录。

### 变更

- 日常写章只走落笔：书房「落笔 · 写下一章」、落笔页顶栏按钮、问心快捷入口和确认卡上的「写下一章」都进落笔；文案「落墨」统一为「落笔」。自动连载仍在「自动模式」页，可选审稿方式（自动 / 人工）。
- 落笔能看见前面的章：采用一章后记下人物现状、新伏笔、推进或收回的旧线和一段摘要；写后面的章时带上人物最新状态、还没收的伏笔和最近 5 章摘要。旧书原有的伏笔和人物状态照常读取。设定按条目名挑选，正典和上一章结尾不再重复注入，提示里写明本章目标字数。
- 落笔的默认写作说明加长，并带上本书文风、网文通用写法和禁语样例；还停在旧默认句上的角色自动换成新说明，作者自己写过的要求保留。
- 模型和检索服务的密钥从项目目录迁到本机用户数据目录，页面默认只显示「已配置 · 末四位」；迁移失败时原文件保留，导出不带密钥。
- 模型配置默认只留连接（地址、密钥、测试）和主力模型 / 审查模型，八个角色的分别设置收进「高级」。
- 大书更快：落笔页按章加载，书房只读摘要；章节表按卷折叠、默认展开当前卷、可按章号或标题搜索，超过 100 章时虚拟滚动；章页刷新后仍停在原处，书房记住上次打开的章；自动保存的版本每章只留最近 20 份。
- 「真相文件」在导航、设定页和进度提示里统一改称「设定档案」；书被占用时只说「这本书正在被写入」；页面报错改为中文。
- 启动不再弹出首次设置向导。没有有效项目根时自动使用「文档\幻想作家」文件夹（沿用原有目录名），模型在工作台「模型配置」里填写。
- 研墨去掉「铺细节 / 定稿」，织卷去掉旧的十章织卷按钮，生成都改走四 Agent 工作流。
- 运行日志到 512KB 轮转，连同当前文件最多保留 3 份。

### 修复

#### 写章与稿件安全

- 「采用此稿」在书锁内把正文、章节目录、工作流清单和章节笔记一次写完；锁被占用时给出「这本书正在写」提示；结算被强制中止时不写正文。长时间生成的书锁不再在 8 秒后被接管。
- 手改不再悄悄丢失：落笔编辑框停笔约 1.5 秒自动存成手改候选，换章、开始写、审查、采用之前先等保存完成；已有手改时「开始写本章」会问基于手改改写还是另起一稿；关窗前先尝试存盘，来不及时再询问。章节阅读页和侧栏的自动保存会先把改前原文留在版本里。
- 恢复历史版本不再报错。
- 坏掉或为空的书籍信息、稿件清单不再让整本书打不开：坏文件改名隔离，候选稿尽量从稿件记录重建；书架照常列出其它书，坏书显示说明和最近一次快照的位置。空的章节目录会按章节文件重建。
- 落笔正文里不再重复出现章节标题。
- 问心、研墨、织卷未保存的手改会先写入当前稿，再进入审查、修订和采用。
- 恢复正文或结算失败后，下一章不再读到旧版人物状态。
- 新章直接手写并采用、或按意见修订时，沿用已采用规划的章题，不再把「手改」写成正式标题；按意见修订会带上正典、设定和规划。
- 修订优先更新已有的精确章节，不被更早的章段范围挡住。

#### 落笔上下文

- 落笔上下文按最终拼接长度分配预算，并先给本章概要留出位置：本章末句不再被分隔符截掉，很长的卷前备注也不再挤掉本章任务；同一范围节点只注入一次。
- 超出已定卷范围的新章归入末卷并更新卷范围；落笔的「本卷」取自所选章节实际所在的卷。

#### 织卷与规划

- 织卷只改某章时保留范围概要、章间和卷末备注以及卷前作者备注（如「第1卷·节点A」）；未分章的卷改概要不再删掉后面的独立备注。
- 织卷修订不再把旧章概要累积进全书纲，卷名不再重复加「第N卷」；全书纲边界与卷 / 章解析一致，纯文本和加粗标题修订后不再复制旧提纲。
- 续跑以当前已保存的候选为准：保留暂停后的手改，删掉的备注不会从旧断点回来，新增或替换的备注进入下一批；修订漏返章节时保留原概要。
- 追加规划保留已有备注和章段；清空全书纲表示删除，不再从旧断点补回。尚未分卷但已有章节、章段和备注时，追加规划会建卷并保留原有内容。
- 平铺稿建卷时按规划顺序插入卷头，中间卷没有旧章也不会排成 1→3→2；作者前言按原始行位拼接，不再被空行切出残句。
- 卷序错乱的旧稿追加新章时，正文和断点都归入最大卷号，不再各写各的。
- 新增的精确章按卷声明归卷，旧的跨卷粗范围不再把后卷章节吸进前卷。
- 无括号的中英文卷范围标题在追加章节后也会更新终点。
- 只有作者想法或备注时重新规划，会写入新的全书纲和分卷，并保留原输入。

#### 设定与正典

- 重新拟定设定目录会合并已有条目：同名才合并，冲突时分配新编号和文件；模型给的临时编号不再占用已有条目；Windows 上只差大小写的文件名视为同一个；空结果不再覆盖已采用的目录。
- 更新正典会带上当前候选；已有书采用正典会同步书名和篇幅。

#### 模型连接、用量与隐私

- 四步八角色切换连接后默认沿用该连接的接口协议，也可以手动选 Chat / Responses；旧续写入口切换角色连接时带上对应密钥，命名自定义连接的 Responses 模式走 `/responses`。
- 审查结果解析失败会自动重试一次（OpenAI 兼容接口使用 JSON 模式）。
- 上游报错里的密钥片段显示为「已隐藏」，长模型名和文件路径不会被误隐藏；返回页面的运行记录不再带密钥字段；模型列表不再从网址参数接收密钥。
- 检索服务密钥迁移失败、或两处密钥不一致时，两把都保留，不会丢。
- 用量统计补齐：问心、研墨、织卷和落笔审查都记录用量，刷新后「这次用了」和书房累计不再归零；估算金额按这次实际使用的连接计价，没标价的连接会注明未计入。
- 日志轮转改名失败时不覆盖已有备份，超限的日志不再继续变大。
- 超过 100 章的章节表行高对齐，滚到底能看到最后一章。

### 注意

- 第一次打开已经配过密钥的项目时，密钥会自动迁到本机用户数据目录；迁移失败时原文件保留不动。
- 估算金额只是按单价粗算，不是账单；不填单价就只显示 token 数。
- 旧书原有的伏笔和人物状态文件不会被改写，新的跨章记忆另行记录。

## [2.1.9] - 2026-09-08

Windows 补丁安装包：`Inkborne-Setup-2.1.9.exe`（同时上传 `FantaWriter-Setup-2.1.9.exe` 与 `Fantasy-Writer-Setup-2.1.9.exe` 别名）。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。`appId` 仍为 `com.fantawriter.app`。

### 修复

- 「等你过目」黄卡改成作者能读懂的编辑口吻，不再像检查日志；健康区间的说明条不再显示。

## [2.1.8] - 2026-09-07

Windows 补丁安装包：`Inkborne-Setup-2.1.8.exe`（同时上传 `FantaWriter-Setup-2.1.8.exe` 与 `Fantasy-Writer-Setup-2.1.8.exe` 别名）。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。`appId` 仍为 `com.fantawriter.app`。

### 修复

- 改写完成后刷新章节正文：落笔工作区与阅读页不再停在改写前的旧稿。

## [2.1.7] - 2026-09-07

Windows 补丁安装包：`Inkborne-Setup-2.1.7.exe`（同时上传 `FantaWriter-Setup-2.1.7.exe` 与 `Fantasy-Writer-Setup-2.1.7.exe` 别名）。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。`appId` 仍为 `com.fantawriter.app`。

### 变更

- 问心新建书对话去掉题材模版芯片（Cozy Fantasy、LitRPG、恐怖等），只留输入框。

## [2.1.6] - 2026-09-07

Windows 补丁安装包：`Inkborne-Setup-2.1.6.exe`（同时上传 `FantaWriter-Setup-2.1.6.exe` 与 `Fantasy-Writer-Setup-2.1.6.exe` 别名）。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。`appId` 仍为 `com.fantawriter.app`。

### 变更

- 问心页去掉故事卡侧栏，只留对话；书名改到研墨改。
- 研墨改为七段竖排（基础设定、故事概要、世界规则、人物设定、关系与主线、结局与伏笔、其他待定项），带目录与定稿条。
- 书房四步一览改为「圆点 | 步名 | 状态」，并改写各步状态文案。

## [2.1.5] - 2026-09-07

Windows 补丁安装包：`Inkborne-Setup-2.1.5.exe`（同时上传 `FantaWriter-Setup-2.1.5.exe` 与 `Fantasy-Writer-Setup-2.1.5.exe` 别名）。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。`appId` 仍为 `com.fantawriter.app`。

### 修复

- Windows 安装包嵌入 Inkborne 图标（`icon.ico`），不再静默关掉 rcedit；落笔空态补上内边距，无章节时隐藏表头。
- 问心故事卡：没有 `story_card.md` 时从作者意图 / 故事框架推导。
- 织卷长标题拆成短题 / 提要。
- 问心记录去掉「新书与短篇」；`#/chat` 不再先建空会话。

## [2.1.4] - 2026-09-07

Windows 补丁安装包：`Inkborne-Setup-2.1.4.exe`（同时上传 `FantaWriter-Setup-2.1.4.exe` 与 `Fantasy-Writer-Setup-2.1.4.exe` 别名）。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。`appId` 仍为 `com.fantawriter.app`。

### 变更

- 全站配色改为「墨 · 宣 · 朱」：墨色主按钮、宣纸底、朱砂只做短线与印芯；下拉悬停不再是金色块。
- 四步圆点改为同一枚 StageDot（实心=已成、环+朱砂芯=进行中、淡环=未及），当前页与阶段进度分开。
- 侧栏「长篇 / 短篇」；问心页只留「重新推敲前提」；首页封面菜单「落笔」不再错标为书籍设置。
- 书内五页与章页 / 真相 / 数据分析共用顶栏 chrome（左【书房】，右问心·研墨·织卷·落笔）；系统页面包屑去掉，页标题统一 32 衬线。
- 对话框去掉右上 X 与重阴影；书籍设置 / 更多工具改用同一 Drawer；短篇删除只在短篇设置危险区。
- 深页排版：落笔章节表收成「通过 + ⋯」，重写/修订/带病通过改用对话框；研墨显示已定稿日期并把终局与伏笔拆开；织卷筛选折叠、树底文字链接；章页只留编辑 / 通过 / ⋯；短篇创作书房改为【书房】+ 可点问心。

## [2.1.3] - 2026-09-06

Windows 补丁安装包：`Inkborne-Setup-2.1.3.exe`（同时上传 `FantaWriter-Setup-2.1.3.exe` 与 `Fantasy-Writer-Setup-2.1.3.exe` 别名）。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。`appId` 仍为 `com.fantawriter.app`。

### 变更

- 问心改为独立整页，不再用右侧抽屉；书内五页平铺：书房 / 问心 / 研墨 / 织卷 / 落笔。
- 书内 chrome 左【书房】，右问心·研墨·织卷·落笔；侧栏问心记录直接进问心页。
- 删除 talk-drawer（`book-talk-drawer` / `bookChatOpen` / `closeAskDrawer` 等）。

## [2.1.2] - 2026-09-06

Windows 补丁安装包：`Inkborne-Setup-2.1.2.exe`（同时上传 `FantaWriter-Setup-2.1.2.exe` 与 `Fantasy-Writer-Setup-2.1.2.exe` 别名）。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。`appId` 仍为 `com.fantawriter.app`。

### 修复

- 问心抽屉只保留聊天与故事卡，不再被书籍侧栏挤掉；关闭后地址回到 `#/book/:id`。

### 变更

- 侧栏「AI 动态」改称「实时动态」，去掉守护进程 / 实时动态前的状态点，六格对齐。
- 系统设置顺序改为：模型配置 · 项目设置 / 资料设置 · 守护进程 / 实时动态 · 检查更新。
- 「作者资料」改称「资料设置」；该页只留头像、姓名、简介、保存。
- 首页去掉「在创」大标题；封面不再带进度条，封面下改为 `[连载|短篇]《书名》` / 始于日期 / 章数。
- 「新开问心 / 新的问心」改「新开会话 / 新的会话」。

## [2.1.1] - 2026-09-06

Windows 补丁安装包：`Inkborne-Setup-2.1.1.exe`（同时上传 `FantaWriter-Setup-2.1.1.exe` 与 `Fantasy-Writer-Setup-2.1.1.exe` 别名）。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。`appId` 仍为 `com.fantawriter.app`。

### 变更

- 首页改为只读作者信息 + 封面书架；编辑作者资料仍在 `#/author`。
- 侧栏去掉「在创」封面墙，菜单改为两列网格；「对谈记录」改「问心记录」。
- 问心与对谈统一：书内进程条「问心」打开问心抽屉，去掉「对谈」按钮。
- 顶栏中/EN 语言切换去掉，改到「项目设置 → 创作语言」。
- 「日志记录」改称「AI 动态」，复用现有 SSE / 日志展示 AI 进度；「守护进程」行为不变。

## [2.1.0] - 2026-09-06

墨生万象（Inkborne）换标正式 Windows 安装包：`Inkborne-Setup-2.1.0.exe`（同时上传 `FantaWriter-Setup-2.1.0.exe` 与 `Fantasy-Writer-Setup-2.1.0.exe` 别名，给仍认旧文件名的客户端）。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。`appId` 仍为 `com.fantawriter.app`。

### 新增

- 产品名换为墨生万象 / Inkborne（原名幻想作家 / FantaWriter）。
- 连载书房 + 问心 / 研墨 / 织卷 / 落笔四步流程壳。
- 作者墙：作者卡、在创封面墙、对谈按书归组。
- 问心故事卡（书名 / 一句话 / 梗概）与「就此建书」。
- 研墨定稿：世界规则 / 人物 / 关系与主线 / 结局与伏笔 / 待定项。
- 短篇创作书房（问心 · 织卷 · 落笔）。
- 松绿 / 米纸 / 金视觉系统；本地霞鹜文楷子集 + Instrument Serif + JetBrains Mono。

### 变更

- 落笔页去设置化：页头只留导出与写下一章；设置 / 删书进抽屉危险区。
- 织卷重排为单一主 CTA（锁定卷纲 → 下一批）。
- 书房改为今日一笔 / 本卷要抵达 / 等你过目 / 四步一览。
- 安装包主文件名改为 `Inkborne-Setup-*.exe`；检查更新同时识别旧 `FantaWriter-Setup-*` 与 `Fantasy-Writer-Setup-*`。

## [2.0.15] - 2026-09-06

Windows 补丁安装包：`FantaWriter-Setup-2.0.15.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。

### 修复

- 书籍写入锁卡住对话改设定。
- 过期锁自动清理。
- 占用时中文提示为写入被占用而非读取失败。

## [2.0.14] - 2026-09-04

Windows 补丁安装包：`FantaWriter-Setup-2.0.14.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。

### 变更

- 侧栏按开始创作/我的创作/会话记录/工具/系统重排。
- 去掉互动影游与导入入口。
- 题材模板挪到工具。

### 修复

- 短篇删除后「我的创作」残影。

## [2.0.13] - 2026-09-04

Windows 补丁安装包：`FantaWriter-Setup-2.0.13.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。

### 变更

- 侧栏创建只留长篇/短篇。
- 作品列表长短篇标记与短篇操作对齐。
- 增加导出原文。
- 精简检查更新说明。
- 暂时隐藏翻译译介与市场雷达入口。

## [2.0.12] - 2026-09-04

Windows 补丁安装包：`FantaWriter-Setup-2.0.12.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。

### 新增

- 短篇分阶段（先大纲确认再按章写）。
- 工具卡中文阶段可见。
- 短篇进作品列表可打开阅读。

## [2.0.11] - 2026-09-04

Windows 补丁安装包：`FantaWriter-Setup-2.0.11.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。

### 修复

- 书聊：识别 kimi 等模型把（tool_write_truth_file: …）写成正文假标记的问题，自动重试或给出可恢复中文错误，避免「没有完成」空芯片。
- 书聊长工具/改写骨架：交互流 idle 与长工具调用更稳（对齐 #82）。

## [2.0.10] - 2026-09-04

Windows 补丁安装包：`FantaWriter-Setup-2.0.10.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。

### 修复

- 修复自定义服务加载时把 custom:zenmux 裁成 custom 导致无 baseUrl。

## [2.0.9] - 2026-09-03

Windows 补丁安装包：`FantaWriter-Setup-2.0.9.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。

### 修复

- 活动书读/写/改路径自动带上当前书 id；流水线空流 idle 从 60s 放到 180s；旧书会话下一轮跟随 Studio 默认模型。

## [2.0.8] - 2026-09-03

Windows 补丁安装包：`FantaWriter-Setup-2.0.8.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。

### 修复

- 织卷识别卷一《冕旒》与四十章；已写成第N程的书可从原架构笔记重锁冕旒…清溪；240s 超时不再误报成 API 400；kimi-k3 织卷第1–10章 reasoning_effort low，总超时 900s。

## [2.0.7] - 2026-09-03

Windows 补丁安装包：`FantaWriter-Setup-2.0.7.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。

### 修复

- 织卷先定卷，再每批 10 章供审；LLM 流超时不再空转。

## [2.0.6] - 2026-09-03

Windows 补丁安装包：`FantaWriter-Setup-2.0.6.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。

### 修复

- 建书按目标章数/每章字数写出短标题卷章树和提要；大纲侧栏不再把「卷一埋/OKR」散文当卷名；已有书可用织卷按字数重排，不用删书。

## [2.0.5] - 2026-09-02

Windows 补丁安装包：`FantaWriter-Setup-2.0.5.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。

### 修复

- 点创建长篇会开新会话，删除对话后不会再钻回失败的旧建书。

## [2.0.4] - 2026-09-02

Windows 补丁安装包：`FantaWriter-Setup-2.0.4.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。

### 修复

- 修 Moonshot kimi-k3 建书 400：K3 固定温度，自定义服务不再发送 0.7。

## [2.0.3] - 2026-09-02

Windows 补丁安装包：`FantaWriter-Setup-2.0.3.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。

### 修复

- 去掉侧栏左上角坏掉的 LOGO 区域，顶上直接是开始创作。窗口标题、首次设置和安装包图标不动。

## [2.0.2] - 2026-09-02

Windows 补丁安装包：`FantaWriter-Setup-2.0.2.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。2.0.1 还没有应用内「检查更新」按钮，需要先从 Releases 手动装这一版。

### 新增

- 侧栏「系统」和帮助菜单恢复检查更新，可从 GitHub Release 下载安装包并安装重启。

## [2.0.1] - 2026-09-02

Windows 补丁安装包：`FantaWriter-Setup-2.0.1.exe`。许可证仍是 **AGPL-3.0-only**，NOTICE 与 InkOS 署名未改。

### 变更

- 用户可见的 InkOS 标志 / 「InkOS Studio」换成幻想作家 LOGO 与产品名。

### 修复

- 首次配置会写入可列出的自定义服务商（不再丢成认不到的 custom）。

## [2.0.0] - 2026-09-02

第一份正式 **2.0 桌面安装包**：`FantaWriter-Setup-2.0.0.exe`（同时上传 `Fantasy-Writer-Setup-2.0.0.exe` 别名，给仍认旧文件名的 1.7 端）。这是 InkOS 内核 + Electron 壳的首发，不是「P2 已经打磨完毕」的声明。

### 新增

- **InkOS 内核**：稿件落在你选的项目根（默认 `%USERPROFILE%\Documents\幻想作家\`），标准目录 `inkos.json`、`books/`、`.inkos/secrets.json`。密钥只写在本机项目里，**不进 git、不进安装包**。
- **Electron 壳**：单实例、钉端口（从 17831 扫，不用 4567）、首启向导、退出杀引擎、从本仓 GitHub Release 检查更新。
- **连载驾驶舱**：打开书先看今天写哪章、卷进度、到期/逾期伏笔和审稿待办，而不是 1.x Next 的「写下一章」向导。
- **防跑偏闸**：写前必须有大纲条目（可显式带病续写）；正典（方向/骨架/规则）改动先 diff 再确认；审稿问题进队列，critical 默认挡通过；伏笔可标目标章，逾期升为 hook-debt。
- **锁可强制释放**：进程内租约可回收；界面可强释书锁并中止占用任务，避免卡死只能重启。

### 变更

- 产品入口是 Electron + fork 的 InkOS Studio，**不再是** 1.7.x Next.js / IndexedDB 向导。
- 仓库与安装包许可证为 **AGPL-3.0-only**（1.x 已发布的 MIT 安装包不受影响）。
- `pnpm dist:win` 产出 NSIS；GitHub Actions 在 tag `v2.0.0` 上构建并上传安装包与 sha256。

## [2.0.0-dev.1] - 2026-09-01

P1 硬闸（仍是开发快照，不是正式 2.0.0）。

### 新增

- G1 写前闸：目标章无 `volume_map` 条目、骨架/意图为空、或上一章未通过时拒绝写下一章/草稿；可显式「带病续写」。
- G2 有界 packet 落盘为 `story/runtime/chapter-NNNN.packet.json`。
- G3 正典 diff 人闸：chat/agent 改方向/骨架/规则只暂存提案，确认按钮 + 基线修订校验后才写。
- G5 审稿问题队列；critical>0 默认挡通过，覆盖须记入章 meta。
- 伏笔 `targetChapter`：到期/过期进写 packet，过期记 hook-debt critical。
- G6 合并 OpenWrite Apache-2.0 文风禁表到默认 craft；写后违规强制改稿，仍失败则 audit-failed。
- 织卷 / 落墨入口标签（仍走现有 Chat + pipeline）。

### 尚未交付（P2 / 后续）

- 连载驾驶舱完整重写。
- 1.x IndexedDB 备份迁移器。
- 正式 Windows NSIS 安装包装配（见 [2.0.0]）。

## [2.0.0-dev] - 2026-09-01

这是 **2.0 重建的开发快照**，不是正式 2.0.0。没有 `FantaWriter-Setup-2.0.0.exe`。

### 变更

- 产品入口换成 Electron + fork 的 InkOS Studio（v1.8.0）。旧 Next.js 1.7.1 Studio / IndexedDB 不再能从 `pnpm start` 启动。
- 默认项目根：`文档/幻想作家`（Windows 上即 `%USERPROFILE%\Documents\幻想作家\`）。
- 仓库许可证改为 AGPL-3.0-only。
- 书锁可强制释放；进程内过期租约可回收；truth 文件保存会取书锁。
- 引擎端口从 17831 扫描钉住，不再默认 4567。
- 壳接管已有引擎后仍跟踪 pid/port/token，退出与「重启引擎」会 abort+杀进程。
- Dashboard/BookDetail「写下一章」注册可中止任务并占用书锁；BOOK_BUSY 带持有者；强释后管线不再继续落盘。
- BookDetail「草稿」`POST /draft` 同样注册可中止任务并占用书锁，避免强释后幽灵落盘。

### 尚未交付（P1/P2）

- P1 硬闸见 [2.0.0-dev.1]；连载驾驶舱完整重写仍待 P2。
- 1.x 备份迁移器。
- 正式 Windows 安装包装配（见 [2.0.0]）。

## [1.7.1] - 2026-08-29

安装包：`FantaWriter-Setup-1.7.1.exe`（同时上传 `Fantasy-Writer-Setup-1.7.1.exe` 别名）。

### 变更

- 大纲页收成一棵树，摘要就地改。
- 「写这一章」对准被点的章。
- 默认幕节先藏起来。

### 修复

- 过卷向导可关。
- 优化大纲后摘要会跟上。

## [1.7.0] - 2026-08-28

安装包：`FantaWriter-Setup-1.7.0.exe`（同时上传 `Fantasy-Writer-Setup-1.7.0.exe` 别名）。

### 新增

- Studio 工作台：左侧七工作区（总览 / 大纲 / 正文 / 审稿 / 资料库 / AI 协作 / 工具与设置）+ 右侧创作助手。
- 规划「织卷」与写作「落墨」分工；正典 AI 写入须经 diff 确认闸。
- 写下一章管线：写前检查 → 有界 packet → 初稿 → 10 维审稿 → 结算 / 回滚。旧「写下一章」向导已退役。
- 旧项目 schema v2 → v3 无损迁移（章序 / 正文 / 账本保留）。
- 工作台信息架构借鉴 [OpenWrite](https://github.com/LiPu-jpg/Openwrite)（仅思路，未复制代码）。

## [1.6.0] - 2026-08-28

安装包：`FantaWriter-Setup-1.6.0.exe`（同时上传 `Fantasy-Writer-Setup-1.6.0.exe` 别名）。

### 新增

- 有大纲的项目打开后直接进正文。
- 「写下一章」先立本章契约：要写什么、绝不能写什么。续写、改写、按场景生成也会带上契约禁写。
- 定稿要过摘要、账本、伏笔。
- 前提卡与人物真相层：仅作者可见，不进提示词。结局方向默认不给 AI，勾选后才本次参考。
- 新建项目连载默认开。
- 账本条目可置顶。
- 过卷向导：卷摘要、出卷人物快照、伏笔去向、时间线落点。
- 未审章审阅同屏。

### 修复

- 仅作者暗线不再泄漏进生成路径。

## [1.5.1] - 2026-08-27

安装包：`FantaWriter-Setup-1.5.1.exe`（同时上传 `Fantasy-Writer-Setup-1.5.1.exe` 别名）。

### 修复

- 冷启动后窗口一出现，首页项目名等输入框立刻可点可输；静默检查更新不再挡首屏。

## [1.5.0] - 2026-08-27

安装包：`FantaWriter-Setup-1.5.0.exe`（同时上传 `Fantasy-Writer-Setup-1.5.0.exe` 别名）。

### 新增

- 连载模式与滚动排章：可选钩子与连载提示；「续排本卷 N 章」按已有摘要向后接，不改已写章。
- 人物状态账本：章摘要带结构化附录，按人物累积；可手改摘要和账本；工具页可批量补缺失摘要。
- 审阅回路：草稿 / 已审、本章体检、写下一章 / 队列限章；一致性检查可按本卷或自上次以来。
- 存稿 / 发布看板、自定义字数档、中间插章；完卷时可提示生成卷摘要。
- 按章序导出；重排或改题后会清理同章旧文件。
- 正文四项任务可选精写档。

### 变更

- 拍增量确认时可改时间线。

### 修复

- 设置保存不再误清精写档配置。

### 注意

- 原作焕新项目仍不走整书 / 续排。

## [1.4.3] - 2026-08-25

安装包：`FantaWriter-Setup-1.4.3.exe`（同时上传 `Fantasy-Writer-Setup-1.4.3.exe` 别名）。

### 修复

- 启动后，首页项目名等输入框不再因静默检查更新卡住。

## [1.4.2] - 2026-08-25

安装包：`FantaWriter-Setup-1.4.2.exe`（同时上传 `Fantasy-Writer-Setup-1.4.2.exe` 别名）。

### 变更

- 英文名改为 FantaWriter（中文仍为「幻想作家」）。
- 数据目录改为 `%APPDATA%\fantawriter`。

### 注意

- 此版不迁移旧稿；此前数据仍在旧目录。
- 本版起同时上传旧安装包名别名，已安装的 1.4.0 桌面端才能检到 1.4.1 及之后的更新。

## [1.4.1] - 2026-08-25

安装包：`FantaWriter-Setup-1.4.1.exe`。

### 新增

- 从零开写可打开人物编辑框并保存。
- 公开仓补上 MIT 许可证，以及面向下载用户的 README（下载、API、未签名 SmartScreen）。

### 变更

- 安装包改名为 `FantaWriter-Setup-*.exe`。

### 注意

- 检查更新仍识别旧安装包名 `Fantasy-Writer-Setup-*.exe`。

## [1.4.0] - 2026-08-22

安装包：`Fantasy-Writer-Setup-1.4.0.exe`。

### 新增

- 原作焕新：先抽故事骨架，可预览再确认。
- 按节拍扩写：先预览，再接受 / 改稿 / 重生成 / 跳过；接受后才追加正文。
- 伏笔可标「读者已知」或「仅作者」，暗线不泄漏。

### 注意

- 已挂原作的项目不走全书 / 整卷一键生成。

## [1.3.0] - 2026-08-21

安装包：`Fantasy-Writer-Setup-1.3.0.exe`。

### 新增

- 保存失败会明确提示，并可导出备份。
- 自动备份可恢复。
- 多卷目录显示各章字数。

### 变更

- 过夜队列更稳：章摘要先落地；崩溃后正在跑的队列会暂停。
- 全书替换可选同步摘要 / 大纲。
- 一致性检查更完整。

## [1.2.0] - 2026-08-21

安装包：`Fantasy-Writer-Setup-1.2.0.exe`。

### 新增

- 破坏性操作需确认。
- 单章失败可重试。
- 正文温度可调。
- 卷摘要可一键生成。
- 伏笔板可一键标已回收。
- 新建书有开写四步卡。

## [1.1.0] - 2026-08-21

安装包：`Fantasy-Writer-Setup-1.1.0.exe`。

### 新增

- 章节篇幅硬约束；不足可一键补足。
- 本章可勾选出场人物。

### 变更

- 原作焕新只锁定事实。
- 文风指纹会注入提示词。

## [1.0.0] - 2026-08-21

安装包：`Fantasy-Writer-Setup-1.0.0.exe`。

### 新增

- 第一版公开独立发行，只写正规小说。
- 提供 Windows 安装包。
- 从本仓 GitHub Release 检查更新。

[2.1.10]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.1.10
[2.1.9]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.1.9
[2.1.8]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.1.8
[2.1.7]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.1.7
[2.1.6]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.1.6
[2.1.5]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.1.5
[2.1.4]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.1.4
[2.1.3]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.1.3
[2.1.2]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.1.2
[2.1.1]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.1.1
[2.1.0]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.1.0
[2.0.15]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.15
[2.0.14]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.14
[2.0.13]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.13
[2.0.12]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.12
[2.0.11]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.11
[2.0.10]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.10
[2.0.9]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.9
[2.0.8]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.8
[2.0.7]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.7
[2.0.6]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.6
[2.0.5]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.5
[2.0.4]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.4
[2.0.3]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.3
[2.0.2]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.2
[2.0.1]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.1
[2.0.0]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.0
[2.0.0-dev.1]: https://github.com/qingyou0420/Inkborne/releases/tag/v2.0.0-dev.1
[1.7.1]: https://github.com/qingyou0420/Inkborne/releases/tag/v1.7.1
[1.7.0]: https://github.com/qingyou0420/Inkborne/releases/tag/v1.7.0
[1.6.0]: https://github.com/qingyou0420/Inkborne/releases/tag/v1.6.0
[1.5.1]: https://github.com/qingyou0420/Inkborne/releases/tag/v1.5.1
[1.5.0]: https://github.com/qingyou0420/Inkborne/releases/tag/v1.5.0
[1.4.3]: https://github.com/qingyou0420/Inkborne/releases/tag/v1.4.3
[1.4.2]: https://github.com/qingyou0420/Inkborne/releases/tag/v1.4.2
[1.4.1]: https://github.com/qingyou0420/Inkborne/releases/tag/v1.4.1
[1.4.0]: https://github.com/qingyou0420/Inkborne/releases/tag/v1.4.0
[1.3.0]: https://github.com/qingyou0420/Inkborne/releases/tag/v1.3.0
[1.2.0]: https://github.com/qingyou0420/Inkborne/releases/tag/v1.2.0
[1.1.0]: https://github.com/qingyou0420/Inkborne/releases/tag/v1.1.0
[1.0.0]: https://github.com/qingyou0420/Inkborne/releases/tag/v1.0.0
