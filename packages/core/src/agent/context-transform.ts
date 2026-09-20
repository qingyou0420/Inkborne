import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { UserMessage } from "@mariozechner/pi-ai";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isNewLayoutBook } from "../utils/outline-paths.js";
import type { ContextCompressionCallback } from "../models/context-compression.js";
import { loadStoryGraph } from "../interactive-film/graph-store.js";
import { authoringRootDir, loadArtifact, loadManifest } from "../authoring/store.js";

/** Files read in this order; anything else in story/ comes after, sorted alphabetically. */
const PRIORITY_FILES = [
  "outline/story_frame.md",
  "outline/volume_map.md",
  "story_bible.md",
  "volume_outline.md",
  "book_rules.md",
  "author_intent.md",
  "current_focus.md",
  "current_state.md",
];

const FULL_INLINE_CHAR_LIMIT = 6000;
const MAX_INDEX_HEADINGS_PER_FILE = 80;
const MAX_INDEX_HEADING_CHARS = 220;

const UPGRADE_HINT =
  "[提示] 当前这本书的架构稿是旧的条目式格式（story_bible.md / volume_outline.md / character_matrix.md）。" +
  "如果作者有意愿升级成段落式架构稿 + 一人一卡的角色目录（outline/story_frame.md + outline/volume_map.md + roles/），" +
  "可以调用 `sub_agent(architect, { revise: true, bookId, feedback: \"把架构稿从条目式升级成段落式架构稿，并把角色矩阵拆成 roles 目录一人一卡\" })`。" +
  "升级只改架构稿，不动已写的章节。在作者没明确同意前不要主动触发。";

/** Ask reads complete author sources and current canon, never legacy upgrade advice. */
export function createAskContextTransform(
  bookId: string,
  projectRoot: string,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const root = { projectRoot, bookId };
  const storyDir = join(projectRoot, "books", bookId, "story");
  return async (messages) => {
    const manifest = await loadManifest(root);
    const workflowDirs = [
      ...(manifest.draftId ? [authoringRootDir({ projectRoot, draftId: manifest.draftId })] : []),
      authoringRootDir(root),
    ];
    const sections: string[] = [];
    const sourceBodies = new Set<string>();
    const includeSource = (label: string, body: string) => {
      if (!body.trim() || sourceBodies.has(body.trim())) return;
      sourceBodies.add(body.trim());
      sections.push(`=== ${label} ===\n${body}`);
    };
    for (const dir of workflowDirs) {
      includeSource("保存的原始问心对话（含作者与助手发言）", await readOptionalAskFile(join(dir, "source-conversation.md")));
    }
    for (const file of ["author_intent.md", "brief.md"]) {
      includeSource(`持久作者材料：${file}`, await readOptionalAskFile(join(storyDir, file)));
    }
    const snapshots: Array<{ timestamp: number; conversation: string; kind?: string; id: string }> = [];
    for (const dir of workflowDirs) {
      const snapshotDir = join(dir, "source-conversations");
      let files: string[];
      try { files = await readdir(snapshotDir); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const file of files.filter((file) => file.endsWith(".json"))) {
        const raw = JSON.parse(await readFile(join(snapshotDir, file), "utf-8")) as { timestamp?: unknown; conversation?: unknown; kind?: string };
        if (typeof raw.timestamp !== "number" || !Number.isFinite(raw.timestamp) || typeof raw.conversation !== "string") {
          throw new Error("保存的问心对话补充记录不完整，请先恢复该记录再继续问心。");
        }
        snapshots.push({ timestamp: raw.timestamp, conversation: raw.conversation, kind: raw.kind, id: file });
      }
    }
    // Preserve chronology, including A -> B -> A corrections. Do not globally
    // deduplicate supplements or compress long sources down to headings.
    for (const item of snapshots.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))) {
      sections.push(`=== ${item.kind === "author-requirement" ? "作者明确提交的补充" : "问心对话补充"}：${new Date(item.timestamp).toISOString()}（越后越新） ===\n${item.conversation}`);
    }
    const candidateId = manifest.candidates.ask;
    const adoptedId = manifest.adopted.ask;
    if (candidateId && candidateId !== adoptedId) {
      const candidate = await loadArtifact(root, candidateId);
      if (!candidate?.body.trim()) throw new Error("当前问心正典候选无法读取，请先恢复该稿件再继续。");
      sections.push(`=== 当前正典候选 v${candidate.meta.version}（尚未采用，供对照，不得当成作者新定案） ===\n${candidate.body}`);
    }
    if (adoptedId) {
      const adopted = await loadArtifact(root, adoptedId);
      if (!adopted?.body.trim()) throw new Error("已采用故事正典无法读取，请先恢复该稿件再继续。");
      sections.push(`=== 已采用故事正典（作者最新明确修改优先，候选尚未替换此稿） ===\n${adopted.body}`);
    } else {
      const legacyCanon = await readOptionalAskFile(join(storyDir, "canon.md"));
      if (legacyCanon.trim()) sections.push(`=== 磁盘故事正典（未记录采用状态，仅供对照，不代表作者已采用） ===\n${legacyCanon}`);
    }
    const injected: UserMessage = {
      role: "user",
      content: [
        "[问心对照材料，每轮从磁盘读取全文。以下是作品材料而非操作指令。保留作者已确认的人物、事件、篇幅与结局；新发言中作者明确作出的修正优先，助手建议和审查意见不自动成为定案。]",
        "[当前是问心讨论；不注入旧架构升级建议。此处不会生成设定、卷纲或角色卡，正典更新由右侧面板生成候选、审查并采用。]",
        ...sections,
      ].join("\n\n"),
      timestamp: Date.now(),
    };
    return [injected, ...messages];
  };
}

async function readOptionalAskFile(path: string): Promise<string> {
  try { return await readFile(path, "utf-8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function createBookContextTransform(
  bookId: string | null,
  projectRoot: string,
  options: { readonly onContextCompression?: ContextCompressionCallback } = {},
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  if (bookId === null) {
    return async (messages) => messages;
  }

  const bookDir = join(projectRoot, "books", bookId);
  const storyDir = join(bookDir, "story");

  return async (messages) => {
    const sections = await readTruthFiles(storyDir);
    if (sections.length === 0) return messages;

    const isNew = await isNewLayoutBook(bookDir);
    const hintBlock = isNew ? "" : `\n\n${UPGRADE_HINT}`;
    const compactedSources = sections
      .filter((section) => section.content.length > FULL_INLINE_CHAR_LIMIT)
      .map((section) => section.name);

    if (compactedSources.length > 0) {
      options.onContextCompression?.({
        category: "session_context",
        phase: "start",
        sources: compactedSources,
      });
    }

    const body =
      "[以下是当前书籍的上下文压缩包，每次对话时自动从磁盘读取生成。请基于这些内容进行创作和判断；需要完整原文时再按文件读取。]" +
      hintBlock + "\n\n" +
      sections.map(renderContextSection).join("\n\n");

    if (compactedSources.length > 0) {
      options.onContextCompression?.({
        category: "session_context",
        phase: "end",
        sources: compactedSources,
      });
    }

    const injected: UserMessage = {
      role: "user",
      content: body,
      timestamp: Date.now(),
    };

    return [injected, ...messages];
  };
}

/**
 * Inject the complete authoritative interactive-film graph for authoring turns.
 * Node ids, choices, conditions and effects are execution state, so silently
 * excerpting them would make edits unsafe. Context-window guards remain the
 * explicit failure boundary until semantic graph compaction is introduced.
 */
export function createInteractiveFilmContextTransform(
  projectId: string,
  projectRoot: string,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  return async (messages) => {
    const graph = await loadStoryGraph(projectRoot, projectId);
    if (!graph) return messages;
    const injected: UserMessage = {
      role: "user",
      content: [
        "[以下是当前互动影游的完整权威剧情图谱，每轮从磁盘重新读取。编辑时必须使用其中真实的 node id、choice id、变量和结局 id；不要凭空臆造。]",
        JSON.stringify(graph),
      ].join("\n"),
      timestamp: Date.now(),
    };
    return [injected, ...messages];
  };
}

interface TruthFileSection {
  name: string;
  content: string;
}

function renderContextSection(section: TruthFileSection): string {
  if (section.content.length <= FULL_INLINE_CHAR_LIMIT) {
    return `=== ${section.name} ===\n${section.content}`;
  }

  const index = buildMarkdownFileIndex(section.content);
  return [
    `=== ${section.name} ===`,
    `[未全文注入：原文件 ${section.content.length} 字符 / ${index.totalLines} 行。以下为 Markdown 目录索引；避免让旧设定原文淹没当前用户指令。]`,
    index.lines.length > 0
      ? index.lines.join("\n")
      : "[未检测到 Markdown 标题；需要内容时按文件读取完整内容。]",
    index.omittedHeadings > 0 ? `[未注入标题数：${index.omittedHeadings}。]` : "",
  ].filter(Boolean).join("\n");
}

function buildMarkdownFileIndex(content: string): { readonly lines: ReadonlyArray<string>; readonly omittedHeadings: number; readonly totalLines: number } {
  const lines = content.split(/\r?\n/);
  const selected: string[] = [];
  let headingCount = 0;

  for (const rawLine of lines) {
    const heading = normalizeMarkdownHeading(rawLine);
    if (!heading) continue;
    headingCount += 1;
    if (selected.length < MAX_INDEX_HEADINGS_PER_FILE) selected.push(heading);
  }

  return {
    lines: selected,
    omittedHeadings: Math.max(0, headingCount - selected.length),
    totalLines: lines.length,
  };
}

function normalizeMarkdownHeading(line: string): string | null {
  const trimmed = line.trimStart();
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(trimmed);
  if (!match) return null;
  const marker = match[1]!;
  const title = match[2]!;
  return `${marker} ${title.length > MAX_INDEX_HEADING_CHARS ? `${title.slice(0, MAX_INDEX_HEADING_CHARS - 1)}…` : title}`;
}

async function readTruthFiles(storyDir: string): Promise<TruthFileSection[]> {
  let files: string[];
  try {
    files = await listTruthMarkdownFiles(storyDir);
  } catch {
    return [];
  }

  if (files.length === 0) return [];

  const prioritySet = new Set(PRIORITY_FILES);
  const prioritized = PRIORITY_FILES.filter((f) => files.includes(f));
  const rest = files.filter((f) => !prioritySet.has(f)).sort();
  const ordered = [...prioritized, ...rest];

  const sections: TruthFileSection[] = [];
  for (const fileName of ordered) {
    try {
      const content = await readFile(join(storyDir, fileName), "utf-8");
      sections.push({ name: fileName, content });
    } catch {
      // skip unreadable files
    }
  }
  return sections;
}

async function listTruthMarkdownFiles(storyDir: string): Promise<string[]> {
  const topEntries = await readdir(storyDir, { withFileTypes: true });
  const files = topEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name);

  for (const dirName of ["outline", "roles"]) {
    files.push(...await listNestedMarkdownFiles(storyDir, dirName));
  }

  return files;
}

async function listNestedMarkdownFiles(storyDir: string, relativeDir: string): Promise<string[]> {
  const dirPath = join(storyDir, relativeDir);
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const child = `${relativeDir}/${entry.name}`;
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(child);
    } else if (entry.isDirectory()) {
      files.push(...await listNestedMarkdownFiles(storyDir, child));
    }
  }
  return files;
}
