---
name: 墨生万象 · 水墨书房
description: 留白中的墨意，阅读与写作在前。
colors:
  ink: "#303a33"
  ink-hover: "#222b25"
  paper: "#fafaf7"
  warm-paper: "#f6f2e9"
  mist-paper: "#edf0ed"
  prose: "#292b29"
  secondary-text: "#626a64"
  rule: "#dfe2da"
  night-paper: "#292c2b"
  night-prose: "#e6e5df"
  night-secondary-text: "#adb4ae"
typography:
  display:
    fontFamily: "InkCalligraphy, InkWenkai, KaiTi, serif"
    fontSize: "clamp(33px, 3.2vw, 45px)"
    fontWeight: 400
    lineHeight: 1.5
  headline:
    fontFamily: "InkSerif, Noto Serif SC, Songti SC, serif"
    fontSize: "30px"
    fontWeight: 500
    lineHeight: 1.4
  body:
    fontFamily: "InkSerif, Noto Serif SC, Songti SC, serif"
    fontSize: "19px"
    fontWeight: 500
    lineHeight: 2
  label:
    fontFamily: "InkSans, Microsoft YaHei, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
rounded:
  control: "5px"
  field: "4px"
spacing:
  compact: "8px"
  control: "12px"
  section: "24px"
  gutter: "40px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "8px 17px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
  task-input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.prose}"
    rounded: "{rounded.field}"
    padding: "12px 14px"
---

# Design System: 墨生万象

## Overview

**水墨书房。** 简洁、安静，水墨只点缀页面留白。核心内容始终是问心、研墨、织卷、落笔；视觉参考不产生新的产品功能。使用者在本地长时间创作，内容可读、操作明确、文稿不丢失，比装饰丰富更重要。

本规范依据用户的完整访谈与2026-09-16开工指令。其具体页面结构见 `迭代与审查/中国水墨UI重构-2026-09-16/重构规格-待整体确认.md`；历史文件名不表示仍在等待确认。

## Colors

日间默认素白，可换暖纸、雾灰；夜间为深炭灰与柔和灰白。主题颜色由 `packages/studio/src/ink-design.css` 最后统一应用，配置持久化在现有 appearance 偏好中。

墨色用于主要动作、当前阶段；边线仅划分文稿、目录与审查。错误用现有暖红文字与可操作的恢复入口。普通状态不铺满绿色卡片。

## Typography

四阶段名称使用本地 Ma Shan Zheng 书法字体，首页33–45px，导航27–29px。按钮、表单、辅助状态使用清晰黑体。文稿默认本地思源宋体19px、2倍行高，仍可选择黑体、文楷及17/19/21/23px。已有显式字体偏好保留。

段落可选择、可复制；只读 Markdown 按标题、段落、列表排版。正典结构化字段显示为普通资料；编辑时字段与正文分开，用户无需直接处理 YAML。

## Layout

桌面优先，主要规格1480×960及最小1100×720。零本与新开一本使用同一新书引导；多本采用疏朗封面书架。只保留一个全局配置入口。

问心初始聊天单列，有正典才展示右稿；审查时暂收聊天，文稿与报告并排。研墨与织卷采用目录加文稿；落笔为可收起章节目录加正文。审查为非模态右栏，宽380px，小桌面340px，主内容和固定底栏预留同等空间。1250px以下打开审查会暂时隐藏目录，关闭恢复原布局。侧栏顶部对齐当前工作区。

辅助说明进入帮助或展开控件；必要的保存状态、错误、报告过期信息留在作用位置。文稿有足够底部空间，不被固定操作栏覆盖。

## Elevation & Depth

文稿平铺纸面，不嵌套多层卡片。审查以细分隔线区分，无遮罩。配置、历史及任务窗口使用现有弹层；真正阻断操作的对话框高于审查和成果操作栏。只保留轻微状态过渡，尊重减少动态效果偏好。

## Shapes

控件4–5px小圆角。头像是圆形，封面接近直角。不使用全页纸纹、墨迹动画、印章按钮、山水大背景或小说情节装饰软件外壳。

水墨原图为 `packages/studio/public/assets/ink-study-v1.png`，仅用于首页右下留白；低高度缩小、小窗口隐藏，可配置关闭。素材与提示词同目录保存。字体来源与许可记录在 `public/fonts/FONT-SOURCES.md`。

## Components

- `ManuscriptView`：只读排版，不修改保存源文。
- `AuthoringReviewDrawer` / `ReadingSidePanel`：稿件与意见并读；报告过期可见，选意见后进入任务窗口，不直接覆盖成果。
- `RegenerateDialog`：保留内容、修改重点、适用的审查意见及范围；错误保留输入。新结果保存为候选。
- 成果操作：阅读态唯一一组编辑／审查／采用。编辑态保存／取消；历史、重新生成、比较在成果次要菜单。
- 导航保护：未保存修改离开前选择保存／放弃／继续编辑。保存失败继续留在当前稿件。
- 旧版已采用资料保留其真实写入语义，明确标示保存到已采用资料或卷纲。

## Do's and Don'ts

保持现有 logo；书法仅用于四阶段名称；八个模型槽独立。优先留白和对齐，不重复标题、按钮或同功能入口。保留作者资料、小说文件及全部既有工具的可达路径。不要因 ONE 或其他设计参考添加灵感、手记、个人空间等功能。代码测试通过与用户实机视觉验收是两种证据，分别记录。
