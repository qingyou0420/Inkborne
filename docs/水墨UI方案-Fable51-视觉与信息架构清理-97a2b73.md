# 墨生万象（Inkborne）· 水墨 UI 方案轮：视觉与信息架构清理

> 状态：**方案文档（draft）。** 本文**不改任何产品代码**；只提交这一份 Markdown。附录 A 说明为什么本轮没有随文做「一行级死链」修复。
> 基线：`work/authoring-next` @ `97a2b73`（已合 #127–#133；#133 宣布创作流程轮收口）。
> 范围：Studio 前端（`packages/studio/src`）的**视觉与信息架构**——全局 chrome、书架 / 新书引导、四阶段页（问心 / 研墨 / 织卷 / 落笔）、书房页、章页、配置菜单与设置页。对照 `DESIGN.md`（水墨书房规范）与 `PRODUCT.md`（重设计简报）逐页核对源码，所有位置以文件 + 函数 / 组件名标注。
> 不做：不重开创作流程 P0；不写完整视觉重写代码；不扩安全边界；不动数据格式 / 后台 run 契约 / 采样与额度（见「五、不动清单」）。

---

## 〇、先读这里

1. **本轮主矛盾不是「不够水墨」，而是「一套水墨壳子里还装着两套产品」。** 水墨令牌（`ink-design.css` / `ink-home.css`）、书法阶段条、书架、问心双栏、研墨 / 织卷 / 落笔的「目录 + 文稿 + 右栏审查」骨架都已经在；但 1.4–1.7 时代的「连载驾驭舱」及旧管线仍以**独立页 + 菜单项 + 兜底分支**的形式留在同一套壳里：`BookStudy`（书房 / SerialCockpit）成了没有导航入口的孤儿页；`ChapterReader`（章页，含「通过 / 回退 / 删除章节 / 上下文包」）通过落笔目录的「预览」仍对四阶段书开放；「作品工具」抽屉里的「组装下一章 / 评估 / 归并」直连旧 API；`Sidebar.tsx`、`StageTools.tsx`、`chat/BookSidebar.tsx`、`components/sidebar/*` 约 1 870 行组件**已无任何挂载点**却仍被测试断言。作者感知到的「质感不直观」，一半来自这些残留把同一件事用两种词、两种控件、两种颜色讲了两遍。
2. **建议先做的 P0（三刀，均为删减 / 收拢，不加功能）：** (P0-1) **四阶段书的旧管线入口全部收口**——「预览」章页、「作品工具」抽屉、「真相文件」对四阶段书隐藏或降级为只读；(P0-2) **重复入口归一**——「统计」「导出正文」「八槽模型」各只保留一个主入口（「作品设置」书内 / 书外各留一处），落笔页两份复制的导出菜单合并，织卷同一动作在按钮和 ⋯ 菜单里出现两次的去掉一处；(P0-3) **书房页去留决断 + 书名可点**——阶段条上的书名（`BookWorkspaceNav` 的 `ink-book-context`）变成回到「本书概览」的唯一入口，`BookStudy` 更名为「本书」、只保留「等你过目 / 本卷要抵达 / 四步一览」三段，删掉对四阶段书无意义的「落墨 · 写下一章」兜底分支。三项对应切片 B / C / D，合计约 −450 行 / +170 行，全部在 `studio` 前端，不碰 core 与路由契约；再加两条零风险前置切片 A（词表替换）与 E（圆角 / 横幅令牌），P0 共五片。
3. **与流程轮的边界：** 流程轮收口的成果（孤儿 run 回收、会话迁移、按 scope 选 run、`wait=false` 先落 running、重试分派）在本轮**只被引用、不被触碰**；本轮所有改动都不新增 / 删除任何 `/authoring/*` 路由或 run 字段，不改变「生成 → 保存 → 审查 → 采用」四个动作的语义与禁用条件，不改变候选 / 已采用的落盘格式。复审 #133 列出的 B-1 / B-2 / B-3（放弃按钮对活跃 run、settle 竞态、研墨中途挂接）**不在本方案主线**，只在「六、可并行」点到为止，建议作为独立的 PR-G-lite 与本轮并行。
4. **术语统一是 P0 的前置条件，不是 P2 的润色。** 现在「书房」同时指书架（`StudioHeader` aria「返回书房」）、每本书的概览页（`BookStudy`「连载书房」）、短篇页（「创作书房」）；织卷页同一份东西被叫作「全书大纲 / 全书规划 / 卷纲 / 分卷规划 / 卷章目录」；「审查 / 审稿 / 审校」「通过 / 采用」「落墨 / 落笔」并存。本文「二·2.3」给出一张词表，P0 切片第一条就是按词表替换文案（纯字符串改动，无逻辑）。
5. **验证口径：** 每个切片以「代码测试 + 用户实机逐页验收」双证据记录，不把 vitest 通过说成视觉验收（`PRODUCT.md` 平台与边界段）。切片 A–E 都能用现有 `__tests__/*-ia.test.ts` 系列的「源码文本断言」模式补一条回归（例如断言 `BookDetail.tsx` 不再出现两处 `name="export-format`），不需要新的 UI 自动化。

---

## 术语对照（编码代理必读）

| 用户说法 | 代码位置 | 说明 |
|---|---|---|
| 书架 / 首页 | 路由 `#/`（`use-hash-route.ts` `parseHash`）→ `pages/Dashboard.tsx`；零本或 `#/book/intro` → `components/NewBookIntro.tsx` | 多本封面书架；一本则启动时直接续上一阶段（`lib/home-navigation.ts` `startupBookRoute`） |
| 阶段条 | `components/BookWorkspaceNav.tsx`（`ink-book-nav` / `ink-stage-strip`）；由 `App.tsx` `deriveBookChromeTab` 决定是否显示 | 书名（不可点）+ 问心 / 研墨 / 织卷 / 落笔书法字 + `StageDot` |
| 配置菜单 | `components/StudioHeader.tsx` → `components/AppMoreMenu.tsx`（触发器文字「配置」） | 外观与字体 / 模型配置 / 作者信息 / 导入旧作 / 问心记录 / 当前作品 ▸ / 工具 ▸ / 运行 ▸ / 其他创作 ▸ / 高级设置 |
| 问心页 | `#/book/:id/ask` → `pages/BookAskPage.tsx`：`ChatPage mode="book"` + `AskCanonPanel` | 建书页 `#/book/new` 同布局（`App.tsx` `isBookCreateChatRoute`） |
| 研墨页 | `#/book/:id/ground` → `pages/BookGround.tsx` → `components/AuthoringGroundPanel.tsx` | 设定目录 + 条目正文 + 右栏审查；旧书（`authoringBook === false`）另有「已采用资料」七节 |
| 织卷页 | `#/book/:id/weave`（`outline` 同义）→ `pages/OutlineWorkspace.tsx` → `components/AuthoringWeavePanel.tsx` | 目录首项「全书大纲」进入面板；其余为已采用卷纲的卷 / 章 / 备注 |
| 落笔页 | `#/book/:id/write`（`settings` 同义）→ `pages/BookDetail.tsx` → `components/AuthoringWritePanel.tsx` | 章目录 + 候选正文 + 固定底栏；旧书另有 `<details class="write-legacy">` |
| 书房页 / 本书概览 | `#/book/:id` → `pages/BookStudy.tsx`（`export { BookStudy as SerialCockpit }`；`pages/SerialCockpit.tsx` 为别名） | 今日一笔 / 本卷要抵达 / 等你过目 / 四步一览；**当前无导航入口** |
| 章页 | `#/book/:id/chapter/:n` → `pages/ChapterReader.tsx`（+ `ChapterWorkspacePanel` 助手） | 旧管线的正式正文页：编辑 / 通过 / 回退 / 删除 / 上下文包 |
| 真相文件 | `#/book/:id/truth` → `pages/TruthFiles.tsx` | 原始 truth 目录浏览 / 编辑 |
| 作品工具 | `components/BookToolsDrawer.tsx`（配置 ▸ 当前作品 ▸ 作品工具） | 统计 / 评估 / 归并 / 组装下一章 |
| 八槽模型 | `components/AuthoringRolesPanel.tsx`，挂在 `pages/ServiceListPage.tsx` **与** `pages/ProjectSettings.tsx`（高级区） | 四阶段 × 创作 / 审查 |
| 水墨令牌 | `src/ink-design.css`（颜色 / 书法字体 / 文稿排版 / 审查栏）、`src/ink-home.css`（配置触发器 / 阶段条 / 书架 / 新书引导）、`src/index.css`（Tailwind 主题 + 旧 ONE 布局类） | `ink-design.css` 在 `main.tsx` 最后引入，覆盖 `index.css` 的颜色 |

---

## 一、现状盘点

### 1.1 全局 chrome 与路由

- **头部**：`StudioHeader` = 品牌（回书架）+ 「配置」下拉。书内高度 64px，书外 83px（`index.css` `.studio-chrome-header` / `.in-book`）。
- **阶段条**：仅在 `deriveBookChromeTab(route)` 非空时显示。`book`（书房）与 `analytics` 映射为 `study`，此时阶段条四个字都不高亮、书名只是 `<span>`。`truth` 映射为 `ground`、`chapter` 映射为 `write`——章页与真相文件页借用了阶段高亮，作者会以为自己仍在「研墨 / 落笔」阶段内。
- **主内容**：`PAGE_SHELL`（880px）/ `PAGE_SHELL_WIDE`（1200px）/ `one-page`（1256px）/ `one-book-page`（1350px）/ `ask-workspace`（满宽）/ `absolute inset-0`（聊天）六种容器并存（`App.tsx` 渲染段）。
- **固定层**：落笔 / 研墨 / 织卷的成果操作栏 `manuscript-actions` 固定底部 72px；审查右栏 `ink-review-pane` 固定 380px（≤1250px 时 340px 并隐藏目录）。`--ink-shell-height: 141px`（64 + 76 + 1）。在 `PRODUCT.md` 的最小窗口 1100×720 下，文稿可视高度 ≈ 720 − 141 − 72 ≈ **507px**。
- **孤儿页**：`#/book/:id`（`BookStudy`）只能从 `ImportManager` 导入成功、`ChapterReader` 通过 / 回退 / 删除后、`TruthFiles` 空态「打开书房」三处到达；书架卡片、阶段条、配置菜单都不指向它。`bookCreatedRoute` 在非 `ask` 阶段也会落到它，但 PR-F 后 `ask/adopt` 总广播 `stage:"ask"`，该分支实际不再触发。
- **死代码（无挂载点）**：`components/Sidebar.tsx`（573 行）、`components/chat/BookSidebar.tsx`（358 行）、`components/StageTools.tsx`、`components/sidebar/*.tsx`（7 个文件）、`lib/sidebar-create-items.ts`，合计约 1 870 行；`pages/SerialCockpit.tsx` 别名文件。`__tests__/update-chrome.test.ts`、`p1-5-deep-pages.test.ts`、`ask-page.test.ts`、`works-list-parity.test.ts` 仍读取 `Sidebar.tsx` 源码做文本断言，删除时需同步改测试。
- **死样式 / 死素材**：`index.css` 中 `.book-top .book-title-group .book-back .book-title-button .one-stage-tab .header-models .header-more .status-dot .one-photo .stage-tools .model-trigger .no-images .decorative-image .project-image` 在 tsx 中零引用；`public/paper-grain.svg`、`public/studio-light.png` 被 `static-assets.ts` 显式放行但无处使用。
- **死文案**：`hooks/use-i18n.ts` 510 个键中约 163 个在非测试源码里无字符串引用（含 `home.*` 60 余条、`cockpit.*`、`dash.*` 大部分、`book.writeNext / book.goWeave / book.truthFiles` 等）。

### 1.2 逐页审查

| 页 | 已具备的水墨骨架 | 本轮要清理的点 |
|---|---|---|
| **书架** `Dashboard` | 作者头像 + 名 / 「新书」唯一入口 / 竖排默认封面 / 卡片 ⋯ 菜单 / >6 本才出搜索 | 卡片 ⋯ 菜单含「作品统计 / 导出正文」，与配置菜单「工具 ▸ 统计」「当前作品 ▸ 导出正文」重复；短篇与长篇卡片同形但短篇进入 `ShortReader`（另一套「创作书房」文案）；卡片副文案 12px |
| **新书引导** `NewBookIntro` | 作者名 / 头像 / 四字书法 / 右下留白墨图（可关） | 与书架的作者区是同一份数据的两套控件（`ink-intro-author` vs `ink-shelf-author`）；「进入问心」后没有回到引导页的路径（正确），但书架的「新书」每次都先经过身份页——符合简报，需在文案上说明「可跳过」 |
| **问心** `BookAskPage` / `ChatPage` / `AskCanonPanel` | 单列聊天 → 有正典才出右稿；审查时收起聊天；底部固定工具栏 | 「对话操作 ▸ 重新推敲前提」藏在聊天区右上 ⋯，与右栏 ⋯「成果操作」同形不同义；`ask-hello` 25px 与阶段条 29px 书法字视觉打架；`BookAskPage` 用 `t("settings.title") === "项目设置"` 判中文（应改用 `useI18n().lang`） |
| **研墨** `BookGround` / `AuthoringGroundPanel` | 目录 + 条目正文 + 右栏审查；编辑 / 审查 / 采用直接动作，重新生成 / 历史在 ⋯ | 顶部三行控件（目录开关 + 状态行 + ⋯ 任务菜单 → `version-state` 行 → 徽标）才到正文；状态字串「已生成 x/y · 已采用 z」「候选」「已采用 · 新候选」「未生成」四种小字并列；旧书「已采用资料」七节与四阶段目录混排在同一 `nav`；`h1` 为 `sr-only`，页面没有可见的阶段标题（阶段条已高亮，可接受，但要与织卷 / 落笔保持一致） |
| **织卷** `OutlineWorkspace` / `AuthoringWeavePanel` | 目录首项「全书大纲」+ 已采用卷纲树；面板内保存 / 审查 / 采用 / 生成章概要 | 正文前**三行**控件：目录开关 + 统计、未研墨横幅、搜索框 + 筛选；「生成本卷章概要」按钮与 ⋯ 菜单「生成本次章概要」同一 `openChapterGeneration`；目录底部「卷纲操作」对四阶段书只剩一条 disabled 提示；「全书大纲」（目录）/「全书规划」（面板 h2、提示语）/「卷纲」（已采用）/「分卷规划」（生成动作）/「卷章目录」（开关）五个词指两样东西；`ChapterRow` 12px + `bg-primary/10` 高亮、`NotesFold` 用 `▾ ▸` 字符做折叠符 |
| **落笔** `BookDetail` / `AuthoringWritePanel` | 章目录 + 只读文稿 + 固定底栏「编辑 / 审查 / 采用 / ⋯」+ 专注模式 | 目录开关单独一行；当前章 ⋯ 菜单对四阶段书仍有「预览」→ `ChapterReader`（旧管线页）；导出菜单在 `authoringBook` 与旧书两个分支各复制一份（`name="export-format"` / `"export-format-legacy"`）；页底导出工具落在固定操作栏下方需滚动才见；`writing || drafting` 横幅用 `rounded-2xl` 卡片；旧书目录状态词（待审稿 / 已通过 / 须处理 / 需修订 / 状态待修）与四阶段（候选 / 已采用 / 未生成）并存 |
| **书房** `BookStudy` | 书名 32px + 元信息；等你过目 / 本卷要抵达 / 四步一览 | 无入口（见 1.1）；「四步一览」与阶段条重复展示四个 `StageDot`；旧书分支「落墨 · 写下一章」+ 「跳过未通过」勾选 = 旧管线入口；`guide` 文案「研墨定稿后才能织卷 / 先定卷，再排前十章 / 去织卷排出前十章」来自 `stage-copy.ts`，与四阶段实际门禁不符（P1-8）；`inferGroundDone` 采用 1 条即打勾（`lib/book-stage.ts`） |
| **章页** `ChapterReader` | 只读正文 + 排版抽屉 | 整页是旧管线：「通过 / 回退 / 删除章节 / 上下文包 / 助手」；操作后 `nav.toBook` 回孤儿书房页；「排版」抽屉与配置 ▸ 外观与字体改同一组偏好 |
| **配置菜单** `AppMoreMenu` | 单一入口；分组子菜单 | 「问心记录」是创作历史却放在配置里；「当前作品 ▸」含作品设置 / 导出正文 / 真相文件 / 作品工具四项，其中后两项通向旧管线；「工具 ▸ 统计」依赖 `statsBookId` 猜书；「其他创作 ▸ 短篇 / 影视」通向 `ChatPage mode="project-chat"` 的另一套壳 |
| **设置页** `ProjectSettings` / `ServiceListPage` | 左侧 `SettingsTabs`（模型配置 / 外观与字体 / 高级）| `ServiceListPage` 的 h1 是「设置」而 tab 是「模型配置」；`AuthoringRolesPanel` 在模型配置页与高级页各挂一份；高级页还有「全局默认模型」输入框，与八槽并列时语义不清；通知 / Skill / 提示词包等大量 `rounded-xl` 卡片嵌套 |

### 1.3 五类问题清单

编号规则：`U-<类别>-<序号>`。类别：L 旧管线入口、D 重复导航、C 文案不一致、I 信息密度、V 水墨质感。每条给出位置与建议处置，优先级在「四」统一排。

#### L · 残留旧管线入口（对四阶段书应不可见或只读）

| # | 位置 | 现状 | 处置 |
|---|---|---|---|
| U-L-1 | `BookDetail.tsx` 当前章 ⋯ 菜单 `t("reader.preview")` | 四阶段书也可进 `ChapterReader`，那里能「通过 / 回退 / 删除章节」，绕过候选 → 采用 | `authoringBook` 时改为「只读预览」：`ChapterReader` 收到 `readOnly` 时隐藏工具栏动作，仅留「排版」；或直接不渲染该菜单项（已采用正文本就以 `ManuscriptView` 展示） |
| U-L-2 | `AppMoreMenu.tsx` 当前作品 ▸ 作品工具 → `BookToolsDrawer` | 「组装下一章」调 `/books/:id/compose`，「评估 / 归并」为旧管线维护动作 | 四阶段书隐藏「作品工具」；旧书保留 |
| U-L-3 | `AppMoreMenu.tsx` 当前作品 ▸ 真相文件 → `TruthFiles` | 原始文件浏览 + 编辑，可直接改 truth 绕过采用 | 四阶段书降级为只读浏览（`TruthFiles` 加 `readOnly`），并移到「高级设置」下；标题改「原始资料（只读）」 |
| U-L-4 | `BookStudy.tsx` `cockpit-write-next-button`「落墨 · 写下一章」+ `book.skipUnapproved` 勾选 | 只在 `!authoringBook` 出现，但书房本身无入口，四阶段书永远看不到，旧书作者却要靠导入完成后的一次跳转才能见到 | 随 P0-3 一起处置：书房只保留概览段，旧书的「写下一章」交给落笔页 `write-legacy` |
| U-L-5 | `ChapterReader.tsx` 全页 | 见 1.2 | 只读化（见 U-L-1）；旧书保留完整工具栏 |
| U-L-6 | `App.tsx` `deriveBookChromeTab`：`truth → ground`、`chapter → write` | 旧页借用阶段高亮 | 两者归入 `study`（无阶段高亮）并显示书名链接 |

#### D · 重复导航 / 重复控件

| # | 功能 | 现有入口 | 保留 |
|---|---|---|---|
| U-D-1 | 作品统计 | ① 书架卡片 ⋯ ② 配置 ▸ 工具 ▸ 统计 ③ 作品工具抽屉首行 | 只留 ①；③ 随 U-L-2 消失；② 删除（`statsBookId` 猜书逻辑一并删） |
| U-D-2 | 导出正文 | ① 书架卡片 ⋯ ② 配置 ▸ 当前作品 ▸ 导出正文 ③ 落笔页底部导出菜单（且 `authoringBook` / 旧书两份复制） | 留 ① 与 ③；③ 合并为一个 `ExportMenu` 组件；② 删除 |
| U-D-3 | 作品设置 | ① 书架卡片 ⋯ ② 配置 ▸ 当前作品 ▸ 作品设置 | 都留（书内 / 书外各一）；但 ② 应是「当前作品 ▸」的第一项，其余项按 U-L 清理后只剩「作品设置 / 导出正文」，可去掉子菜单直接平铺 |
| U-D-4 | 八槽模型 | ① `ServiceListPage` ② `ProjectSettings` 高级区 | 只留 ①；② 删除一行挂载，高级区保留「全局默认模型」并加一句说明「四阶段各槽在模型配置页」 |
| U-D-5 | 正文排版偏好 | ① 配置 ▸ 外观与字体 ② 章页「排版」抽屉 | 留 ①；② 随章页只读化保留为「阅读态快捷」，但抽屉标题注明「与外观设置同步」 |
| U-D-6 | 织卷「生成章概要」 | 面板按钮「生成本卷章概要」 + ⋯ 菜单「生成本次章概要」 | 留按钮；菜单项删除 |
| U-D-7 | 研墨「重新拟定目录」 | ⋯ 菜单内联复制了 `startCatalog` 的实现 | 复用 `startCatalog`（代码去重，不改 UI） |
| U-D-8 | 四阶段导航 | 阶段条 + 书房「四步一览」 | 书房改为「本书概览」时，「四步一览」保留为**带进度文案**的列表（阶段条只有圆点），去掉重复的 `StageDot`，改为文字状态 |
| U-D-9 | 作者身份 | 书架头部 + 新书引导 | 共用一个 `AuthorIdentity` 组件（两处样式合一） |

#### C · 文案不一致

| # | 现状 | 统一为 |
|---|---|---|
| U-C-1 | 「书房」= 书架（`StudioHeader` aria）、= 每本书概览（`BookStudy`）、= 短篇页（`ShortReader`）、= 产品名（`DESIGN.md`「水墨书房」） | **书房 = 整个应用**（品牌语）；首页叫**书架**；每本书概览叫**本书**（阶段条书名即入口）；短篇页去掉「创作书房」kicker |
| U-C-2 | 织卷：全书大纲 / 全书规划 / 卷纲 / 分卷规划 / 卷章目录 | **规划**（面板里的候选，动作「生成分卷规划 / 生成章概要」）与**卷纲**（已采用结果，目录标题「卷纲」）两词；目录首项改「本书规划」，开关文字「卷纲目录」 |
| U-C-3 | 研墨：设定目录 / 已采用资料 / 真相文件 / 正典 | **正典**只指问心产物；**设定**指研墨条目；「已采用资料」改「已采用设定（旧书）」；「真相文件」改「原始资料」 |
| U-C-4 | 审查 / 审稿 / 审校 / 通过 / 采用 / 落墨 / 落笔 | 四阶段一律**审查、采用、落笔**；旧书专有的「审校 / 通过」只在 `write-legacy` 与旧章页出现；`cockpit.writeNext`「落墨 · 写下一章」→「写下一章（旧管线）」 |
| U-C-5 | 配置 / 设置 / 项目设置 / 高级设置；`ServiceListPage` h1「设置」 | 触发器与页面 h1 一律**配置**；tab：模型 / 外观与字体 / 高级 |
| U-C-6 | 同一个 ⋯ 的 aria：成果操作 / 当前章节工具 / 设定任务 / 卷纲操作 / 对话操作 | 成果层统一「更多操作」；目录层统一「目录操作」；聊天层「对话操作」 |
| U-C-7 | 英文串里夹中文：`cockpit.writeNext` en「落墨 · Write next」、`cockpit.weave` en「织卷」 | 修正 en 值 |
| U-C-8 | `stage-copy.ts`「研墨定稿后才能织卷 / 先定卷，再排前十章 / 去织卷排出前十章」；`BookStudy`「去织卷起草下一卷 / 去审稿」 | 按四阶段门禁重写：「先在研墨采用至少一组设定 / 先生成并采用分卷规划 / 去织卷生成章概要 / 去落笔审查」（P1-8） |
| U-C-9 | 目录状态词双轨（待审稿…／候选…） | 旧书保留旧词但加「（旧）」前缀不可行——改为在 `write-legacy` 折叠标题注明「旧管线书」，目录词不改 |

#### I · 信息密度

| # | 位置 | 现状 | 处置 |
|---|---|---|---|
| U-I-1 | 全局 | chrome 141px + 底栏 72px；1100×720 下文稿约 507px | 阶段条 76px → 60px（书法字 29 → 26px，`min-height` 60）；头部书内 64 → 56px；`--ink-shell-height` 相应 117px；专注模式不变 |
| U-I-2 | `one-directory` | 178px 宽、12px 字、10px 副字；落笔数百章平铺 | 目录 200px、13px / 11px；落笔目录按卷折叠（复用 `parseVolumeMapTree` 已有的卷信息，纯前端分组），默认只展开当前卷 |
| U-I-3 | 研墨 / 织卷 / 落笔顶部 | 2–3 行控件后才到正文 | 统一为**一行**：左「目录」开关，中状态一句话，右 ⋯；织卷的搜索 / 筛选移入目录顶部（目录内滚动），未研墨横幅改为目录空态文案 |
| U-I-4 | 研墨条目正文头 | `version-state` + 三种徽标 + 未保存提示 | 一行：「条目名 · 候选 v3 · 未保存」，用 `ink-manuscript-meta` 样式 |
| U-I-5 | 落笔页底 | 导出工具在固定栏之下 | 移入成果 ⋯ 菜单「导出…」 |
| U-I-6 | 书架卡片 | 副文案 12px | 13px，行高 1.7 |
| U-I-7 | 审查右栏 | 380 / 340px 固定；≤1250 隐藏目录 | 保持（符合 `DESIGN.md` 布局段）；补 `≥1500px` 时 420px |

#### V · 水墨质感缺口（对照 `DESIGN.md`）

| # | 规范条 | 现状 | 处置 |
|---|---|---|---|
| U-V-1 | 控件 4–5px 小圆角 | `index.css` `@theme inline` 已设 `--radius: 5px`，故 `rounded-lg`（230 处）= 5px、`rounded-md` = 3px 合规；但 `--radius-xl` = 9px（`rounded-xl` 82 处）、`--radius-2xl` 未覆盖仍是 Tailwind 默认 16px（`rounded-2xl` 15 处）、手写 `rounded-[10px]` 17 处，都超出规范 | `@theme` 把 `--radius-xl` 定为 `var(--radius)`、补 `--radius-2xl: calc(var(--radius) + 1px)`（改一处全站生效）；`rounded-[10px]` 全部改 `rounded-lg`；`rounded-full` 只留头像与 `StageDot` |
| U-V-2 | 普通状态不铺满绿色卡片 | `--seal / --mark` (#386254) 用于 `bg-seal` 开关、`bg-mark-soft` 审稿队列卡、`text-seal-text` 须处理 | `--seal` 仅保留给「已采用」印记与错误对比色；状态字用 `--muted-foreground`，队列去底色改分隔线 |
| U-V-3 | 文稿平铺纸面，不嵌套多层卡片 | 错误 / 进行中横幅 `rounded-2xl border bg-destructive/5`、`rounded-xl border bg-secondary/30`；设置页多层 `SettingsCard` | 横幅改为**无底色 + 左侧 2px 墨线**的 `ink-notice`；设置页卡片降为分组标题 + 分隔线 |
| U-V-4 | 只保留轻微状态过渡 | `animate-spin` 边框圆环出现在 12 个文件；`animate-pulse` 加载文字 | 统一为 `ink-breath` 墨点（已存在于 `index.css`）；页面级 loading 用「正在打开…」一句话 |
| U-V-5 | 书法仅用于四阶段名称 | 正确；但 `ask-hello` 25px 宋体标题与阶段条书法字并列时层级混乱 | `ask-hello` 降到 21px，颜色 `--muted-foreground` |
| U-V-6 | 文稿默认思源宋体 19px / 2 倍行高 | `ManuscriptView` 正确；`OutlineWorkspace` 编辑框 / `BookGround` `EDITOR_CLASS` 手写 `font-serif text-[15px] leading-[26px]`、`rounded-[10px] bg-card` | 编辑态 textarea 统一用 `.manuscript-editor`（已存在），继承 `--prose` |
| U-V-7 | 小说情节装饰 / 印章按钮不用 | 正确；`▾ ▸ →` 字符做图标 23 处 | 换 `lucide` `ChevronDown / ChevronRight / ArrowRight` 14px |
| U-V-8 | 夜间深炭灰 | `.dark` 令牌齐；但 `text-primary` 在夜间是浅绿灰，用作**选中项底色** `bg-primary/10` 时对比不足（织卷 `ChapterRow`、真相文件列表） | 选中态统一 `dir-item.active`（字重 + 下划线），去 `bg-primary/10` |
| U-V-9 | 留白墨图仅首页右下 | 正确；`paper-grain.svg` / `studio-light.png` 死素材 | 删除并从 `static-assets.ts` 白名单移除 |

---

## 二、目标信息架构

### 2.1 一句话

**一个书架，一条阶段线，一个配置入口。** 书外只有书架与新书引导；书内只有阶段条（书名 = 本书概览，四字 = 四阶段）与阶段页；一切非创作动作都在「配置」下拉里，且对四阶段书只出现四阶段能理解的项。不新增第五阶段，不恢复侧栏。

### 2.2 导航矩阵（唯一主入口 ✔，允许的次入口 ○，删除 ✕）

| 功能 | 书架卡片 ⋯ | 阶段条 | 阶段页内 | 配置 ▸ 当前作品 | 配置 ▸ 其他 | 备注 |
|---|---|---|---|---|---|---|
| 进入本书（续上一阶段） | ✔ | — | — | — | — | `bookResumeStage` 不变 |
| 本书概览（原书房） | — | ✔ 书名 | ○ toast「去…」 | — | — | `BookStudy` 更名 |
| 问心 / 研墨 / 织卷 / 落笔 | — | ✔ | ○ toast / 空态动作 | — | — | 不变 |
| 作品设置（改名 / 状态 / 删除） | ✔ | — | — | ○ | — | |
| 导出正文 | ✔ | — | ○ 落笔 ⋯ | ✕ | — | 合并组件 |
| 作品统计 | ✔ | — | — | ✕ | ✕ | |
| 原始资料（只读） | — | — | — | — | ✔ 高级 | 四阶段书只读 |
| 作品工具（评估 / 归并 / 组装） | — | — | — | ○ 仅旧书 | — | 四阶段书 ✕ |
| 章页 | — | — | ○ 落笔 ⋯「只读预览」 | — | — | 四阶段书只读 |
| 问心记录 | — | — | ✔ 问心页对话 ⋯ | — | ✕ | 从配置移到问心页 |
| 外观与字体 / 模型 / 作者 / 导入 / 高级 | — | — | — | — | ✔ | 不变 |
| 短篇 / 影视 / 翻译等其他创作 | — | — | — | — | ✔ 其他创作 | 不变，本轮不动 |

### 2.3 词表（P0 切片 A 直接按此替换）

| 概念 | 统一用词 | 禁用 |
|---|---|---|
| 应用 / 品牌语 | 墨生万象；书房只作品牌语（「回到书房」不用于任何按钮） | 连载书房、创作书房 |
| 首页 | 书架 | 书房、首页 |
| 每本书概览页 | 本书 | 书房、驾驭舱、cockpit |
| 问心产物 | 正典（候选 / 已采用） | 故事卡（仅旧书内部）、真相 |
| 研墨产物 | 设定（目录 / 条目 / 候选 / 已采用） | 已采用资料、真相文件 |
| 织卷候选 | 规划（分卷规划 / 章概要） | 全书大纲、全书规划 |
| 织卷已采用 | 卷纲 | 大纲、卷章目录 |
| 落笔产物 | 正文（候选 / 已采用） | 书稿、正式正文、草稿（仅 `mark === "draft"` 状态词） |
| 四个动作 | 编辑 / 审查 / 采用 / 重新生成 | 审稿、审校、通过、落墨、改写 |
| 设置入口 | 配置 | 设置、项目设置 |
| 旧管线专区 | 旧管线（仅 `write-legacy` 折叠标题与旧书章页） | 连续创作与作品工具 |

---

## 三、水墨质感落地口径

只列**规则**与**落点**，不写实现代码。所有规则以 `DESIGN.md` 为准，本节是把规范对到具体文件。

1. **圆角**：`index.css` `@theme inline` 已有 `--radius: 5px`；只需把 `--radius-xl` 收到 `var(--radius)` 并补 `--radius-2xl`（U-V-1）。这是**一处改动全站生效**，因此放在 P0 而不是逐页改；`rounded-[10px]` 的 17 处随切片 E 顺手改为 `rounded-lg`。
2. **颜色**：新增 `--ink-line`（与 `--border` 同值，语义化为「文稿分隔线」）、`--ink-notice`（横幅左侧墨线）。`--seal / --mark` 保留但只允许出现在 `StageDot(done)`、「已采用」徽标、错误对比。`--destructive` 不变。
3. **字体**：书法仅 `.ink-calligraphy`；标题一律 `var(--prose)` 500 字重；控件 `var(--ui)`。删除 tsx 中 `font-serif` Tailwind 类（10 个文件）改用 `.ink-heading`。
4. **卡片**：新增 `.ink-notice`（无底色，左 2px 线，13px），替换所有 `rounded-2xl/xl border ... bg-*/5` 横幅；设置页 `SettingsCard` 降为 `.ink-section`（标题 + 分隔线）。
5. **动效**：只保留 `.fade-in`（120ms）与 `.ink-breath`；`prefers-reduced-motion` 已处理。删除 `animate-spin` 用法。
6. **图标**：`lucide` 统一 14–16px、`strokeWidth 1.5`；字符箭头 / 三角全部替换。
7. **留白**：页面纵向节律统一 24 / 40px（`DESIGN.md` `spacing.section / gutter`）；`space-y-8`、`space-y-6`、`space-y-5`、`space-y-4` 混用收敛为 `space-y-6`（section）与 `space-y-3`（组内）。
8. **夜间**：选中态不用 `bg-primary/10`，统一 `dir-item.active`；审查栏在夜间沿用 `--card`。

---

## 四、分优先级方案与 PR 切片

### P0（先做；全部是删减 / 收拢 / 纯字符串）

| 切片 | 内容 | 涉及文件 | 预估行数 | 回归测试 |
|---|---|---|---|---|
| **A · 词表替换** | 按 2.3 替换 U-C-1 … U-C-8 全部文案；`ServiceListPage` h1 改「配置」；`StudioHeader` aria 改「回到书架」；修 `cockpit.*` en 值 | `use-i18n.ts`、`stage-copy.ts`、`StudioHeader.tsx`、`ServiceListPage.tsx`、`OutlineWorkspace.tsx`、`AuthoringWeavePanel.tsx`、`BookGround.tsx`、`BookStudy.tsx`、`ShortReader.tsx` | ~120 行字符串 | 新增 `__tests__/ink-copy-glossary.test.ts`：断言禁用词不出现在非 legacy 文件 |
| **B · 旧管线入口收口** | U-L-1 / L-2 / L-3 / L-6：`authoringBook` 时隐藏「作品工具」、章页与真相文件只读化并移到高级、`deriveBookChromeTab` 把 `truth / chapter` 归入 `study` | `AppMoreMenu.tsx`（需拿到 `authoringBook`，从 `useApi("/authoring/workspace")` 取一次）、`BookToolsDrawer.tsx`、`ChapterReader.tsx`、`TruthFiles.tsx`、`App.tsx` | −150 / +60 | `authoring-ia.test.ts` 加断言：四阶段书 `AppMoreMenu` 不渲染 `book-tools-drawer`；`ChapterReader` 有 `readOnly` 分支。`BookToolsDrawer.tsx` 本身保留（`p0-7-chrome.test.ts` / `p1-ia.test.ts` 对它的断言不动） |
| **C · 重复入口归一** | U-D-1 / D-2 / D-4 / D-6 / D-7：删配置菜单「统计」「导出正文」，落笔导出合并为 `ExportMenu`，高级页去掉第二份 `AuthoringRolesPanel`，织卷菜单去掉重复项，研墨菜单复用 `startCatalog` | `AppMoreMenu.tsx`、`BookDetail.tsx`（新 `components/ExportMenu.tsx`）、`ProjectSettings.tsx`、`AuthoringWeavePanel.tsx`、`AuthoringGroundPanel.tsx` | −180 / +70 | `copy-dedupe.test.ts` 加：`BookDetail.tsx` 只出现一次 `export-format`；`ProjectSettings.tsx` 不含 `<AuthoringRolesPanel`。**需同步改**：`authoring-ia.test.ts`「registers authoring routes and eight-role settings」现断言 `ProjectSettings.tsx` 含 `AuthoringRolesPanel`，改为断言 `ServiceListPage.tsx`；`p1-ia.test.ts`「P1-2 落笔」断言 `BookDetail.tsx` 含 `book.exportMenu`，`ExportMenu` 抽出后改读新组件 |
| **D · 本书概览 + 书名可点** | U-L-4 / U-D-8 / P0-3：`BookWorkspaceNav` 书名改 `<button onClick={nav.toBook}>`，`aria-current` 在 `study` 时落在书名；`BookStudy` 更名「本书」，删除旧书「落墨」分支与 `skipPreviousApproval`（旧书由落笔页 `write-legacy` 承担），「四步一览」去 `StageDot` 改文字状态；`deriveBookChromeTab("book")` 保持 `study` | `BookWorkspaceNav.tsx`、`BookStudy.tsx`、`ink-home.css`（`.ink-book-context` 按钮态） | −120 / +40 | `ink-home.test.ts`「single accessible stage strip」断言 `aria-current="page"` 恰一次——书名按钮只在 `study` 态带 `aria-current`，`active:"weave"` 用例不受影响，但要补一个 `active:"study"` 用例；`stage-dot.test.ts` / `p2-ask-ground.test.ts` 读取 `BookWorkspaceNav.tsx` 源码，改动后复跑；新增：书名按钮 `data-testid="book-overview-link"` |
| **E · 全站圆角与横幅令牌** | U-V-1 / U-V-3：`@theme` 收 `--radius-xl`、补 `--radius-2xl`；`rounded-[10px]` → `rounded-lg`；新增 `.ink-notice`，替换 `BookDetail / BookStudy / OutlineWorkspace / ProjectSettings / App` 五处横幅 | `index.css`、`ink-design.css` + 五个 tsx（`rounded-[10px]` 另涉 `BookGround / OutlineWorkspace / BookDetail`） | ~80 | `p0-7-chrome.test.ts` 风格的文本断言：五个文件不再含 `rounded-2xl`；全 `src` 不含 `rounded-\[10px\]` |

P0 合计约 −570 / +350 行，全部在 `packages/studio/src`。建议顺序 A → E → C → B → D（A、E 零风险先合，给 B、C、D 提供稳定的文案与令牌）。

### P1（P0 合入并实机验收后）

| 切片 | 内容 | 关键文件 |
|---|---|---|
| **F · 顶部一行化 + chrome 减高** | U-I-1 / U-I-3 / U-I-4：阶段条 60px、书内头部 56px、`--ink-shell-height` 117px；研墨 / 织卷 / 落笔顶部控件合为一行；织卷搜索 / 筛选入目录；研墨条目头一行化 | `ink-home.css`、`index.css`、`AuthoringGroundPanel.tsx`、`OutlineWorkspace.tsx`、`BookDetail.tsx` |
| **G · 目录密度与按卷折叠** | U-I-2：`one-directory` 200px / 13px；落笔目录按卷分组默认展开当前卷（复用 `parseVolumeMapTree`，前端分组） | `index.css`、`BookDetail.tsx`、`lib/write-directory.ts`（新增 `groupWriteDirectoryByVolume` 纯函数 + 单测） |
| **H · 状态色与动效** | U-V-2 / U-V-4 / U-V-8：`--seal` 收窄用途；`animate-spin` → `ink-breath`；选中态去 `bg-primary/10` | `index.css` + 12 个文件的 spinner 替换 |
| **I · 编辑态排版统一** | U-V-6：`EDITOR_CLASS`、织卷 textarea、研墨 textarea 统一 `.manuscript-editor` | `BookGround.tsx`、`OutlineWorkspace.tsx`、`AuthoringGroundPanel.tsx`、`AuthoringWeavePanel.tsx` |
| **J · P1-8 文案与 `inferGroundDone`** | U-C-8：`stage-copy.ts` 四阶段口径重写；`inferGroundDone` 改为「≥1 条已采用 **且** 目录已生成条目 ≥ 50%」或读 `coverage.settingsAdopted / settingsTarget`（只改前端推断，不改 `/book-stage` 契约） | `lib/stage-copy.ts`、`lib/book-stage.ts` + 已有单测更新 |
| **K · 问心记录归位 + 作者组件合一** | 「问心记录」从配置菜单移到问心页对话 ⋯；`AuthorIdentity` 组件合并书架 / 引导两处 | `AppMoreMenu.tsx`、`ChatPage.tsx`、`Dashboard.tsx`、`NewBookIntro.tsx` |

### P2（顺手 / 清债）

- **L · 死代码删除**：`Sidebar.tsx`、`chat/BookSidebar.tsx`、`StageTools.tsx`、`components/sidebar/*`、`lib/sidebar-create-items.ts`、`pages/SerialCockpit.tsx`；同步改 4 个仍读取 `Sidebar.tsx` 源码的测试（改为断言文件不存在或删除该断言）。
- **M · 死样式 / 死素材 / 死文案**：`index.css` 14 个孤儿类；`paper-grain.svg`、`studio-light.png` 与 `static-assets.ts` 白名单；`use-i18n.ts` 约 163 个无引用键（先用脚本列出，逐条确认无 `t(\`…${x}\`)` 动态拼接后删）。
- **N · 容器统一**：`PAGE_SHELL` / `PAGE_SHELL_WIDE` / `one-page` / `one-book-page` 收敛为 `ink-page`（880）/ `ink-page-wide`（1256）/ `ink-workspace`（满宽）三种。
- **O · 字符图标替换**：U-V-7 的 23 处。
- **P · 短篇 / 其他创作壳**：`ShortReader`「创作书房」等文案与卡片风格对齐词表；不改其流程。
- **Q · `BookAskPage` isZh 判定**：改用 `useI18n().lang`。

### 不建议做（本轮明确拒绝）

- 恢复左侧栏或新增「本书」为第五个书法字——阶段条只放四阶段，本书概览由书名承担。
- 全页纸纹、墨迹动画、印章按钮、山水背景（`DESIGN.md` Shapes 段已禁）。
- 把短篇 / 影视 / 翻译并入四阶段——它们保留在「其他创作」，本轮不动。

---

## 五、不动清单

| 类别 | 具体 | 原因 |
|---|---|---|
| 数据格式 | `books/<id>/**` 全部落盘结构；`.inkos/authoring/*`（artifacts / manifest / runs / drafts）；`book.json` 字段；truth 目录文件名 | UI 轮不动数据 |
| 后台 run 契约 | `GET/POST /authoring/**` 全部路由与请求 / 响应字段；`runs/:id/{pause,cancel,resume}`；`serverStartedAt` 孤儿回收；`wait=false` 先落 running；SSE 事件名与 payload | 流程轮收口成果 |
| 前端 run 选取 | `lib/authoring-run-selection.ts` 全部函数；`hooks/use-authoring-run.ts` 轮询与 404 上限；三面板的 `activeRunId` / 重试分派 | 同上 |
| 四动作语义 | 编辑 / 审查 / 采用 / 重新生成的禁用条件、`dirty` 守卫、`registerNavigationGuard`、`useDraftDecision` 三选一 | 只改外观与位置，不改何时可点 |
| 候选 / 已采用分离 | `ManuscriptView` 只读、编辑另存候选、报告 `stale` 标记 | `PRODUCT.md` 核心机制 |
| 采样 / 额度 | `core/llm/*`、Claude 采样约束、`maxTokens`、八槽模型的读写 API | 不在 UI 范围 |
| 建书动线 | `#/book/new` 双栏、`ask/adopt` 迁移会话、`bookCreatedRoute` | 流程轮 P0-1 / F-b |
| 篇幅门禁 | `weave-length-gate`、`resolveWeaveTargetChapters` | 流程轮 P0-4 |
| 桌面壳 | `packages/desktop/**`、引擎端口、项目根 | AGENTS.md 约束 |
| 安全边界 | `api/safety.ts`、静态资源白名单**只删不加**、无新外链 | 任务要求 |
| 旧书能力 | `authoringBook === false` 的书仍能用旧管线（`write-legacy`、旧章页完整工具栏、作品工具） | 「既有能力保持可达」 |

---

## 六、可并行（点到为止，不在本方案主线）

复审 #133「三·B」的三项建议作为独立 **PR-G-lite** 与本轮并行，彼此文件不重叠：

- **B-1** 「放弃这次运行」对活跃的问心 / 研墨 / 落笔 run 无可见效果（core `ask.ts / ground.ts / write.ts` 不读 `loadRunControl`）。
- **B-2** 采用第 N 章后 N+1 立即可写，与 N 的 settle 竞态；settle 失败 10 分钟后无痕迹。UI 轮若先合 P1-G（目录按卷折叠），B-2 的「状态未整理」目录标记可直接复用新的分组渲染。
- **B-3** 研墨批量生成只在循环结束后 `saveSettingsCatalog`。

另有 F-7（织卷审查后台化）、织卷 resume 不进活跃表，同属流程侧，本轮不碰。

---

## 七、验收方式

1. **代码测试**：每个切片附一条「源码文本断言」回归（沿用 `__tests__/*-ia.test.ts`、`copy-dedupe.test.ts`、`p0-7-chrome.test.ts` 的写法），加入根 `package.json` `test` 白名单；`pnpm typecheck`、`pnpm test` 全绿是合入门槛，不是视觉验收。
2. **用户实机逐页验收**（每个 P0 切片合入后一次）：1480×960 与 1100×720 两档窗口；日 / 夜 × 素白 / 暖纸 / 雾灰；一本四阶段书 + 一本导入旧书。检查项：① 四阶段书在任何页面都找不到「通过 / 回退 / 组装 / 作品工具」；② 「统计 / 导出 / 作品设置 / 八槽」各只有一个主入口且能到达；③ 阶段条书名可点、回到「本书」；④ 全站没有 `>6px` 圆角控件与绿色底卡；⑤ 词表禁用词不出现（可用 `rg` 扫描 `dist` 产物辅助）。
3. **不做**：不恢复慢速逐控件 UI 自动化；不把构建通过标记为视觉验收（`PRODUCT.md`）。

---

## 附录 A · 本轮为什么没有随文做「一行级死链」修复

任务允许对「一行级明显死链且直接误导用户」做极小修并单列。本文逐页核对后，**没有发现严格意义上的死链**（点了没反应、跳到不存在的页、或按钮文字与实际目的地相反且一行可修）。最接近的三处都不满足「一行 + 无行为变化」：

| 候选 | 为什么不算 / 不一行修 |
|---|---|
| `StudioHeader` aria「墨生万象，返回书房」实际回到书架 | 是术语不一致（U-C-1），随切片 A 整体替换，单独改会与其余「书房」文案打架 |
| `BookWorkspaceNav` 书名不可点、`BookStudy` 无入口 | 需要加按钮 + 样式 + 测试同步（切片 D），不是一行 |
| `ProjectSettings` 高级区第二份 `<AuthoringRolesPanel />` | 删一行即可，但属「重复入口」而非「死链」，且 `p1-5-deep-pages.test.ts` 等可能断言其存在，随切片 C 一并处理 |

另有两处**文档**死引用：`PRODUCT.md` 与 `DESIGN.md` 指向仓库内不存在的 `迭代与审查/中国水墨UI重构-2026-09-16/重构规格-待整体确认.md`。它们不面向产品用户，本文不改；建议切片 A 合入时把两处改为指向本文。

## 附录 B · 死代码 / 死样式 / 死文案清单（供切片 L、M 使用）

- 组件（无挂载）：`components/Sidebar.tsx`、`components/chat/BookSidebar.tsx`、`components/StageTools.tsx`、`components/sidebar/{ChaptersSection,CharacterSection,FoundationSection,FrontmatterCards,PendingHooksView,ProgressSection,SidebarCard,SummarySection}.tsx`、`lib/sidebar-create-items.ts`、`pages/SerialCockpit.tsx`。
- 仍引用上述源码的测试：`__tests__/update-chrome.test.ts`、`__tests__/p1-5-deep-pages.test.ts`、`__tests__/ask-page.test.ts`、`__tests__/works-list-parity.test.ts`。
- `index.css` 孤儿类：`.book-top .book-title-group .book-back .book-title-button .one-stage-tab .header-models .header-more .status-dot .one-photo .stage-tools .model-trigger .no-images .decorative-image .project-image`。
- 死素材：`public/paper-grain.svg`、`public/studio-light.png`（`api/static-assets.ts` 白名单同步移除）。
- 死文案：`use-i18n.ts` 中 `home.*`（60 余条）、`cockpit.{manuscript,nextChapter,outline,weave}`、`dash.{createFirst,noBooks,recentEvents,subtitle,title,writeNext,writingProgress}`、`book.{badgeLong,confirmDelete,curate,delete,drafting,goWeave,manuscriptTitle,noChapters,planNext,reject,reviseFoundation,statusOutlining,truthFiles,writeNext}` 等约 163 键；删除前需排除 `t(\`…\`)` 动态拼接。
