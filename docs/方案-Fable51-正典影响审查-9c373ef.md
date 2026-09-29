# 墨生万象（Inkborne）· 正典重采用后的影响审查方案

> 状态：**产品 / 技术方案，先方案后施工。** 基线 `work/authoring-next` @ `9c373ef`。本文不改产品代码，只提交这份方案；P0 切片按「六」拆成 1～2 个 PR 另开。
> 场景样本：书「醉词」——研墨设定约 157 条、织卷已有约 50 章概要、正典已多次采用。目标是：正典调整后，作者**只处理被影响的子集**，核对完黄条消失。

---

## 〇、结论（先读这里）

1. **「审查依据」从一条笼统提醒变成一份可逐项关闭的影响清单。** 正典 vN→vM 采用时，系统先做字段级 diff（哪几个字段真的变了），再由一次聚焦的 LLM 分诊把 diff 映射到具体的研墨条目 id 与织卷章号，每一项附「改了哪个字段 → 与这条 / 这章的哪一点冲突」的可解释理由。正典正文没变（只是重新采用同一内容、或只动了待定项）就**不产生任何提醒**。
2. **分诊产物直接落成两份标准审查报告 + 一份影响索引，不发明新的修订链路。** 研墨报告 `issue.target = 条目 id`、织卷报告 `issue.target = 章号`，与现有 `reviseGroundEntry` / `reviseWeave` 按 target 分组修订的契约完全一致；作者在研墨 / 织卷里「审查抽屉 → 勾选意见 → 按意见修订」的操作一字不改就能用。影响索引 `story/workflow/impact/<id>.json` 只多管两件事：每项的 `open / reviewed / regenerated / dismissed` 状态，以及与 `manifest.watches` 的挂接。
3. **研墨 / 织卷默认只显示「需核对」子集；关闭方式有三种，都会自动消黄条。** ① 该条目 / 该章在报告之后被重新生成或修订并**采用**（自动关闭）；② 作者勾选后点「标为已核对」；③ 作者点「忽略」。所有项关闭 → 对应 watch `acknowledged=true` → 影响基线前移到 vM → 落笔黄条与本书页「等你过目」同时消失。
4. **触发：采用时自动 + 任何时候可手动「相对正典重算影响」。** 自动分诊是采用后的**后台 run**，采用本身仍是同步、原子、不变的；分诊失败只影响提醒精度，不阻塞任何阶段。手动重算以「上一次全部核对完的正典版本」为起点，多次连续采用不会丢项。
5. **失败降级三级：LLM 分诊 → 名称 / 别名 / 实体启发式 → 只留一条「分诊失败，可重试」的粗提醒。** 任何一级都**不会**退化成「157 条全标」。P0 两个 PR（core+API、studio UI）；P1 做卷级目标、已写正文的下游影响、影响历史。**不动清单**：不重开水墨 UI、run 契约只做可选字段追加、不要求人肉全量、不自动改任何已采用材料。

---

## 一、现状与问题定位

| 位置 | 现状 | 问题 |
|---|---|---|
| `core/authoring/stages/ask.ts` `adoptAskCanon` L643–667；`book-create.ts` L107–127 | `previous && previous !== artifactId` 就追加两条 watch：「正典已采用新版本，设定可能需要核对」「…大纲可能需要核对」，`sourceId` 只记新版 id，`fromVersion / toVersion` 字段有但没填 | 判据是 artifactId 而不是内容——手改一个错字后重新采用也会触发；没有「从哪版到哪版」；没有任何粒度 |
| `core/authoring/types.ts` `DependencyWatchSchema` L187–197 | `acknowledged` 默认 `false` | 全仓（含 `studio/src/api/authoring-routes.ts`）没有任何写入 `acknowledged: true` 的代码路径，也没有 API；黄条一旦出现永不消失 |
| `core/authoring/context.ts` `assembleAuthoringContext` L614–616 | 把未确认 watch 的 label 拼进研墨 / 织卷 / 落笔**每一次**生成与审查的提示词 | 「待核对：正典已采用新版本，设定可能需要核对」对模型没有信息量，只是噪音，且会随时间永久存在 |
| `studio/components/AuthoringWritePanel.tsx` L319 | `watches.some(!acknowledged)` → 黄条「上游已有新采用版，审查依据可能需要更新」 | 与当前章无关，不可操作，不可消除 |
| `studio/pages/BookStudy.tsx` L214–221 | 「等你过目」逐条列出 watch label，点击跳阶段 | 跳到研墨后面对 157 条不知从哪看 |
| `studio/components/AuthoringGroundPanel.tsx` | 目录按分类分组，状态只有 候选 / 已采用 / 未生成；批量选择要手动逐条勾 | 没有「哪些条目需要看」的信息 |
| `studio/pages/OutlineWorkspace.tsx` + `AuthoringWeavePanel.tsx` | 卷 → 章目录，节点 id `chapter:N` / `range:a-b` / `volume:*`；审查按整份规划 | 同样没有「哪些章需要看」的信息；审查一次要喂 50 章 |

可复用的既有能力（方案建立在这些之上，不新造）：

- 研墨条目有稳定 `entry.id`；织卷章节有稳定节点 id（`utils/volume-map-tree.ts` L233 / L248），`beatsFromOutline` 可从 `volume_map.md` 取 `{chapterNumber, title, summary}`。
- 审查报告 `ReviewIssue.target` 语义已是「条目 id / 章号」（`review.ts` L78–81），`reviseGroundEntry` 按 `issue.target` 匹配条目（`ground.ts` L381–390），`reviseWeaveChapters` 按范围与选中意见分批修订（`weave.ts` L1163–1288）。studio 侧 `groundRevisionScope` 已把意见映射回条目。
- `GET /api/v1/authoring/diff?left&right`（`authoring-routes.ts` L1088–1102）给两版 artifact 出行级 diff，`AuthoringDiffDrawer` 已存在。
- `context.ts` 已有 `significantTokens / settingAliases / nameHitsNeedle`（L200–222，未导出）——启发式降级的全部原料。
- 后台 run 基建：`emptyRun / persistStartingRun / startAuthoringWork / watchAuthoringWork`，SSE `authoring:run`，`useAuthoringRun`。

---

## 二、产品定义

### 2.1 术语

- **正典版本对**：`from`（影响基线）→ `to`（当前已采用正典）。`from` 不是「上一次采用的版本」，而是**上一次影响清单全部关闭时的版本**（首次为建书时采用的那版）。这样 v3→v4 还没核对完又采用了 v5，重算得到的是 v3→v5 的合并影响，不会丢项。
- **正典 diff**：按 `CanonDocument` 字段比较（`title / genre / targetChapters / chapterWordCount / oneLine / proposition / protagonist / conflict / voice / boundaries / direction`）。`openQuestions` 的变化**不算**影响（待定项是作者待定，不是设定改变）。全部相等 → 不产生 watch、不产生报告。
- **影响范围（impact）**：一组 `item`，每项指向一个研墨条目（`ground:<entryId>`）或一个织卷章节（`weave:chapter:<n>` / `weave:range:<a>-<b>`）或分卷结构（`weave:structure`），带 `verdict`（`affected` 明确受影响 / `maybe` 可能受影响）、`reason`（可解释理由）、`hint`（建议怎么改）、`fields`（触发它的正典字段）。
- **审查依据**：某个阶段成果在生成 / 审查时依赖的上游已采用版本。P0 只处理「正典 → 研墨 / 织卷」这一层；「研墨 / 织卷 → 落笔已写正文」在 P1（见「七」）。
- **需核对**：`item.status === "open"`。作者面对的默认视图就是这一组。

### 2.2 作者看到什么

1. 采用新正典后，问心页 toast：「正典 v4 已采用，正在分辨对设定与规划的影响…」→ 完成后「影响分辨完成：设定 9 条、章概要 6 章需核对 → 去研墨 / 去织卷」。
2. 本书页「等你过目」一行：「正典 v3→v4：设定 9 条、章概要 6 章待核对」，点开分别进研墨 / 织卷。
3. 研墨：目录顶部出现筛选「需核对 9 · 全部 157」，默认停在「需核对」。每条下面一行小字理由，例如「主角与核心欲望改动：核心欲望由『复仇』改为『赎罪』，本条『沈砚』的动机段仍写复仇」。批量模式自动预勾这 9 条。动作：「审查所选（对照新正典）」「按影响重新生成所选」「标为已核对」「忽略」。
4. 织卷：卷纲目录里受影响章节前有墨点，同样的筛选与理由；动作复用审查抽屉：「按意见修订这些章」/「标为已核对」/「忽略」。`targetChapters` 变了会出现一条置顶的 `weave:structure` 项：「全书篇幅由 200 改为 240 章，分卷结构必须重新规划后才能采用（`validateVolumePlan` 会拒绝旧结构）」。
5. 落笔：黄条改为具体可点：「正典 v3→v4 影响未核对完：设定 3 条、章概要 2 章 → 去核对」；若当前章本身在清单里，另加一行「本章概要被标记受影响：<理由>」。全部关闭后两行都消失。
6. 任何时候，研墨 / 织卷 ⋯ 菜单里有「相对正典重算影响」；黄条上也有。

### 2.3 不做什么

- 不自动改任何已采用材料。分诊只产生「意见」与「标记」，改动仍走候选 → 采用。
- 不要求作者看完 157 条 / 50 章；「全部」只是一个可切换的视图。
- 不把 `voice`（叙事视角与文风）的改动映射到条目 / 章级——它是落笔时生效的全局项，记为 `globals` 在报告摘要里说明，不进「需核对」列表。
- 不引入新的评审模型槽；分诊用现有 `ask.review` 槽。

---

## 三、触发时机

| 触发 | 行为 | 说明 |
|---|---|---|
| **自动**：`adoptAskCanon` / `createLightweightBook` 的「已有书重新采用」分支 | 采用本身不变（同步写 `canon.md`、更新 manifest）。随后：① 做字段 diff，相等则直接返回，**不加 watch**；② 不等则写两条 watch（带 `fromArtifactId / toArtifactId / fromVersion / toVersion / impactReportId: pending`），并在路由层启动后台 run `triageCanonImpact` | 采用接口仍立即返回 `{ bookId, artifactId }`，额外带 `impactRunId?`。分诊是「采用之后的事」，失败不回滚采用 |
| **手动**：研墨 / 织卷 ⋯「相对正典重算影响」、落笔黄条「重算」、本书页 | `POST /authoring/impact/recompute { bookId }`：`from = manifest.impactBaseline.ask ?? 首个已采用正典`，`to = manifest.adopted.ask`；产生新报告并**取代**未关闭的旧报告（旧报告归档保留，已关闭项状态迁移到新报告：同 key 且 `to` 未再变化的项沿用状态） | 用途：分诊失败重试、作者手改设定后想再看一眼、旧书第一次用 |
| **连续采用**：上一份报告还有 open 项时又采用了新正典 | 等同手动重算：`from` 仍是基线，`to` 换成最新 | 不叠加多份并行报告，作者永远只面对一份「当前影响清单」 |
| **不触发** | 研墨采用、织卷采用、落笔采用 | 现状 `adoptWeave / adoptGroundEntries` 本就不产生 watch，保持；它们只负责**关闭**影响项（见 5.3） |

---

## 四、从旧正典 → 新正典 → 条目 / 章的映射

### 4.1 第一步：字段级 diff（纯代码，无模型）

```
canonFieldDiff(from: CanonDocument, to: CanonDocument): CanonFieldChange[]
  // 逐字段比较上面 11 个字段（trim 后），openQuestions 不比
  // 每项：{ field, label(中文标题), before, after, kind: "text" | "number" }
```

- 空 diff → 结束，不产生任何东西。这一步单独修掉「重新采用同一内容也报提醒」。
- 数值字段的硬规则（不需要模型）：
  - `targetChapters` 变 → 必出 `weave:structure`（`affected`，理由引用 `validateVolumePlan` 的覆盖要求），并对超出新目标的已规划章（`chapterNumber > 新目标`）各出一条 `affected`。
  - `chapterWordCount` 变 → 只进 `globals`（落笔时生效），不出条目 / 章项。
  - `title / genre` 变 → 进 `globals`；`genre` 若从现实题材改成幻想或反向，附一条「设定目录可能需要重新拟定」的 `maybe`，target 为 `ground:catalog`（点击落到「重新拟定目录」）。
- 文本字段的实体抽取（给分诊与降级共用）：对每个变化字段的 `before / after` 用 `significantTokens` 取 token，再与设定目录的 `entry.name` / 别名（`settingAliases`）做包含匹配，得到 `mentionedEntries`；对 `after - before` 新增的 ≥2 字 token 做 `newTokens`。

### 4.2 第二步：一次聚焦 LLM 分诊（首选）

**角色**：`ask.review`（问心 · 审查槽）。理由：这是「作者改了正典，改动波及到哪」的判断，属于正典侧审查；不占研墨 / 织卷的审查槽，也不新增槽位。

**输入（严格控预算，只给索引不给全文）**：

```
【正典改动 vN → vM】
- 主角与核心欲望：
  旧：……（≤600 字）
  新：……（≤600 字）
- 主要冲突：……
（未改动字段只列名：一句话故事、核心命题、故事边界、初始方向、叙事视角与文风）

【可能相关的名字】沈砚、柳含烟、醉词楼   ← 4.1 抽出的 mentionedEntries + newTokens，供模型对照

【设定目录索引 · 第 1/3 批（60 条）】
- id: shen-yan | 人物 / 沈砚 | 首 120 字：……
- id: liu-hanyan | 人物 / 柳含烟 | 首 120 字：……
…

【章概要索引（50 章）】
- 第 1 章 醉词楼夜 | 概要（≤200 字）：……
…
```

- 研墨：按分类分批，每批 ≤ 60 条（157 条 → 3 批），每批一次调用。
- 织卷：50 章一批（每章 title + summary 截 200 字，约 1 万汉字）；超过 120 章按卷分批。
- 因此「醉词」规模 = 4 次调用，全部走 `ask.review`，每次输入约 8k–12k 汉字。

**输出（只 JSON）**：

```json
{
  "items": [
    { "target": "shen-yan", "verdict": "affected",
      "fields": ["protagonist"],
      "reason": "核心欲望由『为父复仇』改为『替父赎罪』；本条『动机』一节仍以复仇为主线",
      "hint": "重写『动机』与『与柳含烟的关系』两节，把复仇改为赎罪，保留身世" },
    { "target": "12", "verdict": "maybe",
      "fields": ["conflict"],
      "reason": "主要冲突新增『醉词楼易主』，第 12 章概要写的是原东家仍在",
      "hint": "确认第 12 章是否需要把东家换人或提前铺垫" }
  ],
  "globals": [ { "field": "voice", "note": "改为第一人称，影响落笔文风，不需逐条改设定" } ]
}
```

**提示词硬规则**（写进用户消息，不改角色 instructions）：
- 只列**受影响**的项；不确定给 `maybe`；不要为了保险把所有条目列出。
- `reason` 必须同时点到「哪个正典字段怎么改了」和「这一条 / 这一章的哪一点与之冲突或过时」；≤ 80 字。
- `target` 必须是索引里给出的 id / 章号；不在索引里的直接丢弃。
- 文风、篇幅、书名类改动放 `globals`，不映射到条目。

**解析与校验**：
- `target` 不在索引 → 丢进 `unmapped[]`（报告里可见，不进需核对）。
- 同一 target 多条 → 合并 `fields`，理由用「；」拼接，verdict 取高。
- 某一批返回非 JSON / 空 → **只对这一批**走 4.3 降级，其余批次正常。
- 若 `affected + maybe` 超过该批候选的 60%，不裁剪，但在摘要里标注「改动可能是全局性的（如主角改名）；建议用『按影响重新生成所选』而不是逐条核对」。

### 4.3 第三步：启发式降级（模型失败、超时、JSON 不可解析时）

纯代码，用 4.1 的产物，`method: "heuristic"`，所有项 `verdict: "maybe"`，理由前缀「启发式：」。

- 研墨条目命中条件（任一）：
  - `entry.name` 或别名出现在任一变化字段的 `before` 或 `after`；
  - `newTokens` 中 ≥ 4 字的 token 出现在条目正文；
  - 变化字段含 `boundaries` 且条目属约束类（`isConstraintSetting`：时间 / 规则 / 世界 / 制度 / 年表 / 铁律 / 约束）。
- 织卷章节命中条件（任一）：
  - `mentionedEntries` 的名字 / 别名出现在章 title 或 summary；
  - `newTokens` 中 ≥ 4 字的 token 出现在 summary；
  - `targetChapters` 硬规则（同 4.1）。
- 理由模板：「启发式：『主角与核心欲望』改动提到『沈砚』，本条名称命中」/「启发式：第 12 章概要含『醉词楼』，该词出现在改动后的『主要冲突』」。

### 4.4 第四步：兜底

启发式也一项没命中，或代码异常：
- 报告仍写出，`degraded: { reason }`，`items: []`；
- watch 保留但 label 改为「正典 v3→v4 已采用，影响分辨失败：<原因简述>，可重算」，`impactReportId` 指向这份空报告；
- UI 显示这一条 + 「重算」按钮 + 「查看正典改动」（走既有 `/authoring/diff`）。作者也可以直接「标为已核对」关掉它。
- **绝不**回落到「全部条目 / 全部章标记需核对」。

### 4.5 运行记录

沿用 run 契约，不新增 `operation` 枚举值：

```
{ stage: "ask", operation: "review", roleId: "ask.review",
  scope: "impact:<fromArtifactId>..<toArtifactId>",
  progressTotal: 批次数, progressLabel: "正在分辨正典改动的影响 2/4",
  reportId: <impact index id> }
```

走 `persistStartingRun → startAuthoringWork`，SSE `authoring:run` 照常；`useAuthoringRun` 现有 UI 即可显示进度与「放弃」。取消：批间检查 `loadRunControl`，取消则已完成批次照常落盘，未完成批次的候选不标记，报告 `partial: true`。

---

## 五、数据落在哪

### 5.1 三层落点

| 层 | 文件 | 内容 | 为什么放这 |
|---|---|---|---|
| **影响索引** | `story/workflow/impact/<impactId>.json` | 版本对、diff 摘要、`items[]` 及其状态、`globals`、`unmapped`、`method`、`degraded`、关联的两份审查报告 id | 章节在 `volume_map.md` 里没有元数据位置，条目的 `index.json` 也不该混入临时状态；独立文件、独立生命周期、可归档 |
| **两份标准审查报告** | `story/workflow/reviews/<reportId>.json`（既有目录与 schema） | `stage: "ground"` 一份、`stage: "weave"` 一份；`coverage: "正典 v3→v4 影响分辨"`；每个 item 一条 issue：`target = 条目 id / 章号`、`severity = affected→priority, maybe→improve`、`reason`、`suggestion = hint`、`evidence = 该字段的 before→after 摘录`；`inputRefs` 记两版正典 artifact。`targetRefs`：研墨报告 = 受影响条目当前的 `candidateArtifactId ?? adoptedArtifactId`；织卷报告 = `manifest.adopted.weave`（若有候选 `candidates.weave` 一并列入），这样 `assertReportReusable` 直接通过；`weave:structure` 项走 `reviseWeave({ reviseStructure: true })` | 复用整条「审查抽屉 → 按意见修订」链路；`reviseGroundEntry / reviseWeave` 无需改 |
| **manifest 挂接** | `story/workflow/manifest.json` | `watches[]` 每条追加可选 `fromArtifactId / toArtifactId / impactReportId / openCount`；新增可选 `impactBaseline: { ask?: string }` | 黄条 / 等你过目仍读 manifest，一次请求拿到摘要 |

`WorkflowManifestSchema.version` 仍为 `1`；所有新字段 `optional`，旧 manifest 直接兼容。`acknowledged` 语义不变，只是**终于有人写它**：`openCount === 0` 时置 `true`。

### 5.2 影响索引 schema（zod，放 `types.ts`）

```ts
ImpactItemSchema = {
  key: string,                     // "ground:shen-yan" | "weave:chapter:12" | "weave:range:30-35" | "weave:structure" | "ground:catalog"
  stage: "ground" | "weave",
  targetId: string,                // entry.id | 章节节点 id | "structure" | "catalog"
  label: string,                   // 沈砚 | 第 12 章 醉词楼易主
  verdict: "affected" | "maybe",
  fields: string[],                // 触发字段
  reason: string, hint?: string,
  method: "llm" | "heuristic" | "rule",
  snapshot?: string,               // 分诊时目标的内容指纹（条目 artifactId / 章 summary hash），用于自动关闭
  status: "open" | "reviewed" | "regenerated" | "dismissed",
  resolvedAt?: string, resolvedArtifactId?: string,
}
ImpactReportSchema = {
  impactId, createdAt, runId?,
  from: { artifactId, version }, to: { artifactId, version },
  changes: [{ field, label, before, after }],   // before/after 各截 600 字
  globals: [{ field, note }],
  groundReportId?: string, weaveReportId?: string,
  items: ImpactItem[], unmapped: [{ target, reason }],
  method: "llm" | "heuristic" | "mixed", degraded?: { reason }, partial?: boolean,
  supersededBy?: string,           // 被新报告取代时回填
}
```

### 5.3 关闭规则（消黄条的唯一来源）

| 事件 | 关闭哪些项 | 落在哪 |
|---|---|---|
| `adoptGroundEntries(entryIds)` | 报告里 `ground:<id>` 且该 entry 的新 `adoptedArtifactId !== item.snapshot` → `regenerated` | `ground.ts` 采用循环末尾调一次 `closeImpactItems(root, { ground: entryIds })` |
| `adoptWeave(artifactId)` | 对每个 `weave:chapter:N` 比较新采用规划里第 N 章 `title+summary` 的 hash 与 `snapshot`，变了 → `regenerated`；`weave:structure` 在新规划通过 `validateVolumePlan` 后 → `regenerated` | `weave.ts` `adoptWeave` 写文件后调 `closeImpactItems(root, { weaveBody })` |
| `POST /authoring/impact/ack { keys[] }` | 指定项 → `reviewed` | 新路由 |
| `POST /authoring/impact/dismiss { keys[] }` | 指定项 → `dismissed` | 新路由（与 ack 可合并为 `resolve { keys, as }`） |
| 任何关闭之后 | 重算 `openCount`；为 0 → 该阶段 watch `acknowledged = true`；两阶段都为 0 → `impactBaseline.ask = to.artifactId` | `closeImpactItems` 内部统一处理 |

「手改条目正文并保存」只产生新候选，不关闭——采用才算核对完成，与全站「采用才生效」一致。

### 5.4 `assembleAuthoringContext` 的调整

删掉 L614–616 把 watch label 拼进提示词的做法。替代：
- `stage: "write"` 且有 `chapterNumber` 时，若 `weave:chapter:N` 仍 open，追加一行「注意：本章概要在正典 v3→v4 后尚未核对，理由：<reason>」——这是对模型有用的信息；
- 其它阶段不再注入任何 watch 文本。

---

## 六、UI 与 API 改动

### 6.1 API（studio `authoring-routes.ts`）

| 路由 | 说明 |
|---|---|
| `GET /authoring/workspace` | 响应追加 `impact?: { impactId, from, to, openCount: { ground, weave }, items: ImpactItem[], globals, method, degraded, partial, runId }`（只带当前未被取代的那份；items 全量返回，157 条上限也就几十 KB） |
| `POST /authoring/ask/adopt` | 行为不变；已有书且 diff 非空时返回体多一个 `impactRunId` |
| `POST /authoring/impact/recompute { bookId, wait? }` | 手动重算；后台 run 模式与 `ground/review` 一致 |
| `POST /authoring/impact/resolve { bookId, keys[], as: "reviewed" \| "dismissed" }` | 关闭指定项，返回更新后的 `impact` 摘要 |
| `GET /authoring/impact/:impactId` | 读历史报告（P1 影响历史用；P0 顺手暴露） |

### 6.2 研墨 `AuthoringGroundPanel`

- 目录头部：`impact.openCount.ground > 0` 时渲染筛选 `需核对 N · 全部 157`，默认「需核对」；无 open 项时不渲染筛选（现状不变）。
- 条目行：在 `<small>{status}</small>` 旁加墨点 + 一行 `reason`（截 60 字，hover 全文）；`verdict === "maybe"` 用淡一档的墨。
- 进入「需核对」视图时自动开启 `batchMode` 并预勾全部 open 项；作者可取消勾选。
- 动作条（复用现有按钮，改传参）：
  - 「审查所选」→ 现有 `/ground/review`，`requirements` 里附上这些项的 `reason`（模型审查时知道要对照什么）；
  - 「按影响重新生成所选」→ 现有 `RegenerateDialog` → `/ground/generate { regenerate: true, requirements: 由 reason+hint 拼成 }`；
  - 「按意见修订」→ 打开审查抽屉直接载入 `impact.groundReportId` 对应的报告（`reportForArtifact` 之外加一个按 id 载入的分支），后面全是现有链路；
  - 新增两个 quiet 按钮：「标为已核对」「忽略」→ `/impact/resolve`。
- ⋯ 菜单加「相对正典重算影响」「查看正典改动」（`AuthoringDiffDrawer` + `/authoring/diff?left=from&right=to`）。

### 6.3 织卷 `OutlineWorkspace` + `AuthoringWeavePanel`

- 卷纲目录：受影响章节前墨点；顶部同样的筛选；`weave:structure` open 时在目录首项「规划」旁显示「分卷需重规划」标记。
- 选中受影响章节时，节点面板顶部一行理由 + 「标为已核对」「忽略」。
- 「按意见修订」：审查抽屉载入 `impact.weaveReportId`，`onRevise` 走现有 `/weave/revise`（范围取选中意见章号的 min–max，与现有 `reviseWeaveChapters` 语义一致）。
- ⋯ 菜单同样加「相对正典重算影响」「查看正典改动」。

### 6.4 落笔 `AuthoringWritePanel`

L319 的条件与文案替换为：

```
open = impact && (impact.openCount.ground + impact.openCount.weave) > 0
open →「正典 v3→v4 影响未核对完：设定 3 条、章概要 2 章」+ [去研墨] [去织卷]
impact.items 含 open 的 weave:chapter:<当前章> →「本章概要被标记受影响：<reason>」+ [去织卷看这章]
分诊 run 进行中 →「正在分辨正典改动的影响…」
degraded →「影响分辨失败，可重算」+ [重算] [标为已核对]
```

`impact` 为空或 openCount 全 0 → 不渲染。旧 manifest 里没有 `impactReportId` 的遗留 watch（升级前产生的）→ 显示「上游正典有过变更，尚未分辨影响」+ [重算] [标为已核对]，让老书一次性收口。

### 6.5 本书页 `BookStudy`

「等你过目」把两条 watch 合成一行：「正典 v3→v4：设定 9 条、章概要 6 章待核对」；分别可点。degraded 与遗留情况同 6.4。

### 6.6 问心页

采用成功 toast 加第二段（分诊完成后由 SSE 触发）：「影响分辨完成：设定 9 条、章概要 6 章需核对」+ 动作按钮。不改问心页其它任何布局。

---

## 七、切片：P0 vs P1，以及不动清单

### P0（两个 PR，可先后合入；PR-1 单独合入也不破坏现状）

**PR-1 · core + API（`packages/core`、`studio/src/api`）**

1. `types.ts`：`ImpactItemSchema / ImpactReportSchema`；`DependencyWatchSchema` 追加可选 `fromArtifactId / toArtifactId / impactReportId / openCount`；`WorkflowManifestSchema` 追加可选 `impactBaseline`。
2. `canon.ts`（或新 `impact-diff.ts`）：`canonFieldDiff`；`context.ts` 导出 `significantTokens / settingAliases / nameHitsNeedle / isConstraintSetting`。
3. 新 `stages/impact.ts`：`triageCanonImpact`（4.1–4.5）、`closeImpactItems`（5.3）、`resolveImpactItems`、`loadCurrentImpact`；`store.ts` 加 `saveImpactReport / loadImpactReport / listImpactReports`。
4. `ask.ts` / `book-create.ts`：重采用分支改为「diff 非空才写 watch」，watch 带版本对与 `impactReportId: "pending"`；返回值多 `impactPending: boolean`。
5. `ground.ts` `adoptGroundEntries`、`weave.ts` `adoptWeave`：末尾调 `closeImpactItems`。
6. `context.ts`：去掉 watch label 注入；write 阶段按 5.4 注入本章理由。
7. 路由：`/impact/recompute`、`/impact/resolve`、`/impact/:id`；`/workspace` 带 `impact`；`/ask/adopt` 在 `impactPending` 时启动后台 run。
8. 测试（core）：diff 相等不产 watch；`targetChapters` 硬规则；LLM 假函数返回受影响子集 → 两份报告 target 正确、索引状态 open；返回非法 JSON → 启发式命中名称 / 别名；两级都空 → degraded 空报告；`adoptGroundEntries` 自动关闭；`adoptWeave` 按 summary hash 关闭；全部关闭 → `acknowledged=true` 且 `impactBaseline` 前移；连续采用 v3→v4→v5 以 v3 为基线。测试（studio api）：三条新路由与 workspace 字段。

**PR-2 · studio UI（`packages/studio/src/components|pages|lib`）**

1. `lib/authoring-workspace.ts`：`AuthoringWorkspace.impact` 类型；`lib/impact-view.ts` 纯函数：按阶段取 open 项、合成黄条 / 等你过目文案、把 `reason+hint` 拼成 regenerate 的 `requirements`（可单测）。
2. `AuthoringGroundPanel`：6.2。
3. `OutlineWorkspace` + `AuthoringWeavePanel`：6.3。
4. `AuthoringWritePanel`：6.4；`BookStudy`：6.5；问心 toast：6.6。
5. 测试：`impact-view.test.ts`（文案与筛选）；现有面板测试补「有 open 项时默认筛选与预勾」「无 open 项 UI 与现状一致」两个断言；`ink-copy-glossary` 词表不引入禁用词（文案里只用「正典 / 设定 / 规划 / 章概要 / 核对」）。

### P1（另开，不阻塞 P0）

- **卷级影响**：`weave:volume:<n>` 项（卷目标 / OKR 与新正典冲突），理由展示在卷节点。
- **下游到落笔**：条目 / 章概要被重新采用后，对**已写并采用**的正文章节出「可能过时」标记（同一套 impact 机制，`from/to` 换成设定或规划版本对）；同样只标子集，不自动重写。
- **影响历史**：`GET /impact` 列表 + 抽屉，看历次 diff 与处置。
- **启发式增强**：别名表持久化、章概要里的人名共现统计，用于降级精度。
- **`maybe` 的二次确认**：对 `maybe` 项提供「让模型细看这一条」的单条精审（用 `ground.review / weave.review` 槽，给全文），P0 不做。

### 不动清单

- 不重开水墨 UI 轮：不改布局、配色、词表；只在既有目录 / 动作条 / 黄条位置加元素。
- run 契约：不增 `operation` 枚举值、不改 `AuthoringRunRecordSchema` 必填字段；分诊用 `stage: "ask", operation: "review"` + `scope` 区分。
- 不要求人肉全量：任何降级都不产生「全部需核对」。
- 不自动修改已采用材料；不自动重写落笔正文。
- 不改正典 markdown 格式、不改 `SettingsCatalog` 与 `volume_map.md` 的文件结构。
- 不新增模型槽；不把分诊接到旧管线（`SerialCockpit` / 旧书）——旧书 `authoringBook === false` 时整套 impact 不出现。
- 不碰 `packages/desktop`。

---

## 八、验收标准

### 8.1 「醉词」规模（157 条设定 / 50 章概要）

以一次典型改动为例——把「主角与核心欲望」里的核心欲望从复仇改为赎罪，同时在「主要冲突」加一句「醉词楼易主」：

| 项 | 标准 |
|---|---|
| 分诊调用次数 | ≤ 5 次（设定 3 批 + 章概要 1 批 + 余量），全部 `ask.review` |
| 单次输入 | ≤ 15k 汉字（索引式，不含条目全文） |
| 研墨默认视图 | 只显示 open 项；预期数量级 ≤ 25 条（≈ 15%），且 `affected` 中必须包含「沈砚」（主角条目）与「醉词楼」（地点条目）；每条有非空 `reason` 且提到触发字段 |
| 织卷默认视图 | 只显示 open 章；预期 ≤ 15 章（≈ 30%），概要提到「醉词楼」东家的章必须在列 |
| 作者动作 | 全部勾选 → 「按影响重新生成所选」一次 run → 采用 → 研墨 open 归零；织卷「按意见修订」一次 run → 采用 → 织卷 open 归零 |
| 黄条 | 两阶段归零后落笔黄条、本书页「等你过目」同时消失，manifest 两条 watch `acknowledged=true`，`impactBaseline.ask` = v4 |
| 全程作者手工阅读量 | 只读 open 项 + 理由；**不需要**打开任何未标记的条目 / 章 |

### 8.2 行为验收（自动化）

1. 重新采用**内容相同**的正典（含只改待定项）→ 无 watch、无报告、无 run。
2. `targetChapters` 200→240 → 必有 `weave:structure` open 项；旧结构 `adoptWeave` 仍被 `validateVolumePlan` 拒绝（现状），错误文案旁能看到该项理由。
3. 假 LLM 返回含不存在 id 的项 → 进 `unmapped`，不进 open。
4. 假 LLM 返回非 JSON → 该批 `method: "heuristic"`，命中名称 / 别名的条目为 `maybe`，其它批次不受影响。
5. 两级全失败 → 空报告 `degraded`，UI 显示单条可重算、可核对的提醒；重算成功后取代。
6. v3→v4 未核对完再采用 v5 → 新报告 `from=v3`；v3→v4 时已 `reviewed` 且在 v4→v5 未再变化的项沿用状态。
7. 研墨条目「手改保存」不关闭项；「采用」关闭。织卷同理。
8. `assembleAuthoringContext` 在研墨 / 织卷阶段不再包含「待核对：」文本；落笔阶段只在本章 open 时包含本章理由。
9. 升级前老 manifest（有无版本对的 watch）→ workspace 正常、黄条显示遗留提示、「标为已核对」可关闭。
10. 旧书（`authoringBook === false`）→ workspace 无 `impact`，UI 无任何新增元素。

### 8.3 合入门槛

`pnpm typecheck`、core 与 studio 相关测试全绿；不跑真模型即可合入。真模型下的分诊质量（8.1 的数量级）由作者在「醉词」上实机确认，作为 P0 收口而非合入条件；若实机发现 `affected` 漏掉明显条目，优先调 4.2 的提示词与索引截断长度，而不是放宽到全量。

---

## 九、风险与取舍

- **漏报**（真受影响却没标）比误报更伤：靠三点缓解——`maybe` 档位鼓励模型「不确定就列」、启发式作为第二层兜底、以及「全部 157」视图与「相对正典重算影响」始终可用。不追求零漏报，追求「作者不必人肉全扫」。
- **全局性改动**（主角改名、题材大换）会让分诊标出大半条目。这不是失败，UI 明示并引导用「按影响重新生成所选」批量处理；这仍比现状的「自己想哪些要改」好。
- **索引截断**（条目首 120 字、概要 200 字）可能丢掉正文深处的冲突。P0 接受；P1 的「让模型细看这一条」补精度。
- **分诊费用**：每次采用多 ≤ 5 次审查槽调用；作者可在配置里给 `ask.review` 配便宜模型（现有八槽机制），方案不新增开销入口。
- **连续采用与基线**：基线只在两阶段全部归零时前移，极端情况下作者长期不核对会让 `from` 很旧、diff 很大——这是如实反映「欠账」，不是 bug；「忽略」按钮就是给作者主动清账的。

---

## 附：涉及文件一览（P0）

| 包 | 文件 | 改动性质 |
|---|---|---|
| core | `authoring/types.ts` | 追加 schema 与可选字段 |
| core | `authoring/canon.ts` 或新 `authoring/impact-diff.ts` | `canonFieldDiff` |
| core | `authoring/context.ts` | 导出 4 个启发式工具；去掉 watch 注入；write 阶段注入本章理由 |
| core | 新 `authoring/stages/impact.ts` | 分诊、关闭、解析、降级 |
| core | `authoring/store.ts` | impact 报告读写 |
| core | `authoring/stages/ask.ts`、`authoring/book-create.ts` | diff 门槛、watch 带版本对 |
| core | `authoring/stages/ground.ts`、`authoring/stages/weave.ts` | 采用后 `closeImpactItems` |
| core | `authoring/index.ts`、`core/src/index.ts` | 导出 |
| studio | `api/authoring-routes.ts` | 三条新路由；workspace / adopt 响应字段 |
| studio | `lib/authoring-workspace.ts`、新 `lib/impact-view.ts` | 类型与纯函数 |
| studio | `components/AuthoringGroundPanel.tsx`、`pages/OutlineWorkspace.tsx`、`components/AuthoringWeavePanel.tsx`、`components/AuthoringWritePanel.tsx`、`pages/BookStudy.tsx`、问心页 toast | 6.2–6.6 |
