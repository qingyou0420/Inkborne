# 墨生万象 2.1.9 · P1 集成报告

分支：`grok/p1-integration`（从 `origin/master` 的 `6667fea` 拉出）。没有推送，没有改版本号，没有改计划文档。本文件未提交。

## 1. 合并顺序、冲突和解决方式

按计划建议的顺序合入。六条分支都直接基于 `6667fea`，先合工程护栏，后面几条分支里仍是「测试白名单」的 `package.json` 就可以一律留下 exclude 制脚本，不必来回改。

| 顺序 | 来源 | 结果 | 冲突 |
|---|---|---|---|
| 1 | PR #149 `origin/cursor/pr10-engineering-guardrails-b8fc` | `ef49912` 干净合并 | 无 |
| 2 | PR #150 `origin/cursor/secrets-logs-copy-4b77` | `028d770` | 只有根 `package.json` |
| 3 | PR #153 `origin/cursor/large-book-perf-46e1` | `e88a895` 干净合并 | 无。自动合并了 `index.ts`、`manager.ts`、`server.ts`、`BookDetail.tsx`、`BookStudy.tsx`、`authoring-ia.test.ts`、`use-api` |
| 4 | PR #148 `origin/cursor/review-upgrade-real-diff-733f` | `f116c30` | 根 `package.json`、`authoring-ia.test.ts` |
| 5 | PR #152 `origin/cursor/write-stream-basis-usage-12c4` | `6605475` | `authoring/llm.ts`、`authoring/types.ts`、`AuthoringWritePanel.tsx` |
| 6 | PR #151 `origin/cursor/fanqie-plain-export-702c` | `1059fe9` | 根 `package.json`、`BookDetail.tsx` 的 import |

冲突怎么留两边：

- **根 `package.json`（#150、#148、#151）**  
  这三条分支还在用合并前的测试白名单，并且会拿掉 `lint`、前端 `tsc` 和 eslint 依赖。留下 PR-10 的脚本：`pnpm test` 走各包自己的 vitest（exclude 制）、`test:core:full` 仍跑 FTS、`typecheck` 含 studio 前端、`lint` 为 `eslint .`。新测试文件不用再写进白名单，默认就会跑到。

- **`authoring-ia.test.ts`（#148）**  
  大书分支的「按卷分组 / 按章查询工作区」和审查分支的「按方面分组 / 真 diff」都留下。两边的 import（`workspaceQuery`、`groupReviewIssues`）都保留。

- **`authoring/llm.ts` 与 `types.ts`（#152）**  
  审查分支的 `response_format: json_object`（Claude / responses 不传，不支持则退回纯文本）和流式分支的 `usage`、`onTextDelta`、`completeRoleObserved` 合在同一个 `createAuthoringLlm` 里。`completeRole` 会把 `responseFormat` 传进 `completeRoleObserved`。审查报告上的 `dimension`、`rawExcerpt` 没有被 usage 类型盖掉。

- **`AuthoringWritePanel.tsx` 的 effect 依赖（#152）**  
  保留 `loading`（加载中不清空正文）和 `chapterTitle`（标题到达后去掉重复章题）。

- **`BookDetail.tsx`（#151）**  
  番茄分支在自己的基线上把章节表退回平铺大表，并把页面错误改回 `Error: {error}`。合并时没有跟那一侧走：章节表仍是 `ChapterManuscriptTable`，错误仍走 `pageErrorText`。番茄格式、章范围、保存提示和 `showToast` 接在现有导出菜单上。`pageErrorText`、`showToast`、`FanqieExportFields` 三个 import 都留着。

`packages/core/package.json` 在流式分支里没有 `test:full`（它基于护栏合入之前）。三方合并留下了 `test:full`，并加上 `./chapter-heading` 导出。

## 2. 每个 P1 条目

P0 的 #147 提交说明只写了 A1、A2、C1、C2。核对源码后，**C3 和 E3 在 master 上没有交付**，已在本分支补上。

| 条目 | 状态 | 说明 |
|---|---|---|
| B1 落笔流式、耗时、停止 | 已完成 | `POST /authoring/write/generate/stream` 与 `revise/stream` 用 SSE 把增量推进编辑框。面板有已用时间、正文字数和「停止」。停下后已写出的正文会存成候选稿。 |
| A3 番茄纯文本 | 已完成 | 去 Markdown、章题固定为「第N章 标题」、可按章范围导出成一个或每章一个文件、落笔面板和章页都有「复制本章」。短篇导出走同一套。md / epub 还在。 |
| A4 本章依据 | 已完成 | 只读 `GET /authoring/write/basis`。面板折叠条有章纲短题和提要、上一章末尾约 300 字、本卷进度、当前字数 / 目标字数。 |
| A5 审查与真 diff | 已完成 | 审查前先跑套话、禁语、章号、字数等确定性检查，提示词带情节推进 / 人物一致 / 伏笔 / 节奏 / 文笔。`diffLines` 改为最长公共子序列行级 diff。 |
| B2 章节表 | 已完成 | 按卷折叠，默认展开当前卷，可按章号或标题搜索。超过 100 章虚拟滚动。行操作在 `ChapterManuscriptTable` 里常显。番茄合并时没有退回平铺表。 |
| B3 章页刷新 | 已完成 | `#/book/:id/chapter/:n`、`/analytics`、`/truth` 能往返。书房用 `inkborne:last-chapter:` 记住上次打开的章。 |
| B4 文案 | 已完成 | 导航和文案键改为「设定档案」。忙碌卡只说「这本书正在被写入」，带等它写完 / 强制放开。页面错误走 `error-copy`。设置里的英文示例从 writer / architect 改成 write / ground。见下方残留。 |
| B5 模型配置 | 已完成 | 默认只留连接（地址、密钥、测试）和主力模型 / 审查模型。八个角色和旧的分角色模型收在「高级」里。 |
| C3 坏 JSON | 已修复 | master 上没有。`manifest.json` 解析失败会改名为 `manifest.json.corrupt-<时间>`，再从 `artifacts/*/meta.json` 重建候选和已采用。`book.json` 坏了同样改名，错误里带最近一次 `story/snapshots/<章号>` 路径；书架仍列出这本书，再次打开会看到同一句说明。 |
| C4 退出与日志 | 已完成 | 退出前若持有书锁，提示正在写入，可等它写完或立即中止。`server.log` 到 512KB 轮转，保留 2 份旧日志加当前文件，共 3 份。帮助菜单和项目设置可打开日志目录、项目目录。 |
| D1 工作区按章加载 | 已完成 | `?chapter=N` 只回本章稿件和报告。书房 `?summary=1` 不读全部正文。见 E2：摘要原先把 run 清空，累计 token 会一直是 0，已改成从索引里带回 run。300 章假书单测：按章 14.4 ms，摘要 6.7 ms，落笔页组装 22.0 ms。 |
| D2 只增不减的文件 | 已完成 | 会话序号从文件尾读，不再整份读完再编号。`.versions/` 自动保存保留最近 20 份。版本列表只读元数据。章路径从 `index.json` 查。 |
| E1 密钥 | 已完成 | 读取接口默认只回「已配置 / 末四位」，`?reveal=1` 才显示一次。密钥迁到用户数据目录，失败时留原文件。导出排除密钥。设置页写明密钥在本机用户数据目录。 |
| E2 token | 已修复 | run 记录有 `usage`。落笔显示「这次用了 …」，书房显示「这本书累计用了 …」。摘要接口原先不返回 run，累计永远是 0；按章接口也不返回本章 run，刷新后「这次」会丢。现在摘要返回索引里的 run，按章只返回本章 run。连接设置增加可选「估算单价（元 / 百万 token）」，填了才在数字后面加粗算金额，不计费。 |
| E3 写作提示词 | 已修复 | master 上仍是一两句人设，`instructionsVersion` 为 1。落笔 / 落笔审查的默认说明已加长，版本升到 2。还停在旧默认句上的角色会自动换成新默认；作者自己写过的附加要求保留。真正调用时系统提示词再拼四段：角色要求、本书文风（正典 voice）、网文通用写法、`craft/` 禁语样例。 |
| E4 JSON 审查 | 已完成 | 随 PR-6。OpenAI 兼容接口传 `response_format: json_object`，Claude 和 responses 不传。解析失败重试一次，原文留在报告的 `rawExcerpt`。与流式调用合并后这条路径还在。 |
| F1 工程护栏 | 已完成 | 默认测试改为 exclude（缺 FTS5 的少数文件排除，`pnpm test:core:full` 才全跑）。CI 跑 `pnpm typecheck`（含前端 tsc）、`pnpm lint`、`pnpm test`。新增最小 `eslint.config.mjs`。另有 `.github/workflows/e2e.yml`。 |
| F3 小毛刺 | 已完成 | 按 PR-10：删掉已不再打开的 `first-run.html`，并从 `electron-builder.yml` 去掉。未签名、未改 `@mariozechner/pi-ai`，计划把这两件留到以后。 |

## 3. 额外修的 bug

- 大书摘要和按章工作区把 run 丢掉，书房累计 token、刷新后的「这次用了」都对不上。已接回索引里的 run，不恢复「把每个 artifact 正文读一遍」。
- `completeRole` 在和流式合并后曾经不把 `responseFormat` 传下去，审查的 JSON 模式会失效。冲突解决时接上了。
- 本机 Node 24 带 FTS5，于是跑到一条以前常被跳过的管线测试。夹具已经写入中文「作者意图」，断言还在找英文 `Author Intent`。断言改成「作者意图」。
- 本机没有创建符号链接的权限（`EPERM`）。`skill-agent-tool` 两条和 desktop `copyTree` 一条在 `EPERM` / `ENOTSUP` 时跳过。有权限的环境（包括 Linux CI）仍会执行。

## 4. 验证

都在本工作区、当前 HEAD 上跑过。退出码 0。

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过。core `tsc`，studio 前端 `tsc --noEmit`，studio `tsconfig.server.json`。 |
| `pnpm lint` | 通过。`eslint .`，无报告。 |
| `pnpm test` | 通过。core 212 个文件、2113 通过、2 跳过（符号链接）；studio 97 个文件、813 通过；cli 43 个文件、235 通过；desktop 13 个文件、58 通过、1 跳过（符号链接）。合计 3219 通过、3 跳过。`pnpm test:desktop` 已含在这条命令里。 |
| `pnpm build` | 通过。core `tsc`，studio Vite 客户端（5366 个模块，约 21.8 秒）和 server `tsc`。Vite 提示主包约 2.8 MB，超过 500 kB 的块大小警告，构建没有失败。 |

300 章 × 5000 字的假书单测（`large-book-perf.test.ts`）里，按章工作区 14.4 ms，书房摘要 6.7 ms，落笔页组装（书信息 + 按章工作区 + 章路径）22.0 ms。这是函数计时，不是窗口里打开页面。

## 5. 需要人看的事和已知风险

- 没有打开桌面窗口点过。流式出字、停止后候选稿还在、番茄后台粘贴、260 章章节表是否顺，需要作者在真书上过一遍。
- 密钥从项目根 `.inkos/secrets.json` 迁到用户数据目录，要用一本已经配过密钥的真书打开一次确认。迁移失败时应仍留着原文件。
- 退出时「正在写入」的对话框要在真的写章过程中关窗口看一次。
- 估算单价是「元 / 百万 token」的粗算，不是账单。留空则只显示 token 数。
- 旧通路进度日志和侧栏阶段名仍有「真相文件」「生成最终真相文件」「校验真相文件变更」。这些句子被 `project-tools` 用来识别阶段，管线测试也按原句断言，这次没有改。导航和设定页已经是「设定档案」。
- 本机跳过了 3 个符号链接测试。Windows 若未开开发者模式，这是预期。CI 的 Linux 跑者仍会跑它们。
- 书房为了累计 token 会带上索引里的 run 记录（含模型快照）。没有大量 run 时很快；run 非常多时这个接口的响应会变大，但不再逐个读候选稿正文。
- Vite 主包体积警告是既有情况，这次没有拆包。

## 6. 本分支提交

`git log --oneline origin/master..HEAD`

```
96b3e5d test(desktop): skip copyTree symlink case when the OS denies links
f5b47ee test: match the Chinese preflight seed and skip symlinks without privilege
0a2d6c4 fix(p1): recover corrupt books, thicken the write prompt, and keep token totals
1059fe9 merge: PR-5 番茄纯文本导出（A3）
6605475 merge: PR-4 落笔流式、本章依据与用量（B1 A4 E2）
f116c30 merge: PR-6 审查升级与真 diff（A5 E4）
e88a895 merge: PR-7 大书性能（D1 D2 B2 B3）
028d770 merge: PR-8+PR-9 密钥、日志、退出与文案（E1 C4 B4 B5）
ef49912 merge: PR-10 工程护栏（F1+F3）
755ec86 迁密钥失败时保留原文件，占用提示仍带书名
96defd2 perf(authoring): 大书按章加载工作区、版本目录和章节表
0c6cdf1 落笔边写边出字，并去掉重复的章节标题。
08284c7 feat(export): 番茄纯文本，按章导出和复制本章
f3ac8fc 密钥迁出项目根，并收起模型配置与英文报错
f9ac6bb chore: default the test suite to an exclude list and add CI guardrails
c73d789 feat(authoring): 审查本章先做自动检查，并改用真实行级 diff
```

上面后半是各分支自带的提交，经 `--no-ff` 带进本分支。本分支自己的合并提交是 `ef49912` 到 `1059fe9`，跟进修复是 `0a2d6c4`、`f5b47ee`、`96b3e5d`。
