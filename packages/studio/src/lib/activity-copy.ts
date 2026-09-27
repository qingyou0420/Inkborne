/**
 * Author-facing sentences for the live AI activity feed.
 * Maps already-broadcast SSE events; does not invent a new backend.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export interface ActivityBookRef {
  readonly id: string;
  readonly title: string;
}

export interface ActivityLine {
  readonly time: string;
  readonly bookTitle: string;
  readonly text: string;
}

const ACTIVITY_PREFIXES = [
  "write:",
  "draft:",
  "weave:",
  "revise:",
  "rewrite:",
  "agent:",
  "tool:",
  "book:",
  "short:",
  "import:",
  "style:",
  "daemon:",
  "audit:",
] as const;

const ACTIVITY_EXACT = new Set(["llm:progress", "task:snapshot", "log"]);

export function isActivityEvent(event: string): boolean {
  if (ACTIVITY_EXACT.has(event)) return true;
  return ACTIVITY_PREFIXES.some((prefix) => event.startsWith(prefix));
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? data as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bookTitleOf(
  data: Record<string, unknown>,
  books: ReadonlyArray<ActivityBookRef>,
): string {
  const id = asString(data.bookId) ?? asString(data.shortId);
  if (id) {
    const hit = books.find((book) => book.id === id);
    if (hit?.title) return hit.title;
  }
  const nested = data.book && typeof data.book === "object"
    ? asString((data.book as { title?: unknown }).title)
    : undefined;
  return nested ?? asString(data.title) ?? "";
}

function chapterLabel(data: Record<string, unknown>, isZh: boolean): string {
  const n = asNumber(data.chapterNumber) ?? asNumber(data.chapter);
  if (!n) return "";
  return isZh ? `第 ${n} 章` : `ch. ${n}`;
}

function formatClock(timestamp: number | undefined): string {
  const date = new Date(timestamp && Number.isFinite(timestamp) ? timestamp : Date.now());
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function toolLabel(data: Record<string, unknown>): string {
  return asString(data.tool) ?? asString(data.name) ?? asString(data.tag) ?? "";
}

export function formatActivityEvent(
  msg: { readonly event: string; readonly data: unknown; readonly timestamp?: number },
  books: ReadonlyArray<ActivityBookRef>,
  isZh: boolean,
): ActivityLine | null {
  if (!isActivityEvent(msg.event)) return null;
  const data = asRecord(msg.data);
  const bookTitle = bookTitleOf(data, books);
  const chapter = chapterLabel(data, isZh);
  const chars = asNumber(data.totalChars) ?? asNumber(data.wordCount) ?? asNumber(data.chineseChars);
  const tool = toolLabel(data);
  const message = asString(data.message);
  const time = formatClock(msg.timestamp);

  const withBook = (text: string): ActivityLine => ({ time, bookTitle, text });

  switch (msg.event) {
    case "write:start":
    case "draft:start":
      return withBook(isZh
        ? `落笔 · ${chapter || "下一章"} 起草中`
        : `Writing · ${chapter || "next chapter"} drafting`);
    case "write:complete":
    case "draft:complete":
      return withBook(isZh
        ? `落笔 · ${chapter || "一章"} 完成${chars ? ` · ${chars.toLocaleString()} 字` : ""}`
        : `Writing · ${chapter || "a chapter"} done${chars ? ` · ${chars.toLocaleString()} chars` : ""}`);
    case "write:error":
    case "draft:error":
      return withBook(isZh ? "落笔未完成" : "Writing did not finish");
    case "llm:progress":
      return withBook(isZh
        ? `落笔 · ${chapter || "起草中"}${chars ? ` … ${chars.toLocaleString()} 字` : ""}`
        : `Writing · ${chapter || "drafting"}${chars ? ` … ${chars.toLocaleString()} chars` : ""}`);
    case "weave:start":
      return withBook(isZh ? "织卷进行中" : "Weaving volumes");
    case "weave:complete":
      return withBook(isZh ? "织卷完成" : "Weaving finished");
    case "weave:error":
      return withBook(isZh ? "织卷未完成" : "Weaving did not finish");
    case "revise:start":
      return withBook(isZh ? "修订进行中" : "Revising");
    case "revise:complete":
      return withBook(isZh ? "修订完成" : "Revision finished");
    case "rewrite:start":
      return withBook(isZh ? "重写进行中" : "Rewriting");
    case "rewrite:complete":
      return withBook(isZh ? "重写完成" : "Rewrite finished");
    case "agent:start":
      return withBook(isZh ? "问心 · 正在思考" : "Ask · thinking");
    case "agent:complete":
      return withBook(isZh ? "问心 · 一轮结束" : "Ask · turn finished");
    case "agent:error":
      return withBook(isZh ? "问心未完成" : "Ask did not finish");
    case "tool:start":
      return withBook(isZh
        ? `问心 · 工具「${tool || "操作"}」`
        : `Ask · tool “${tool || "action"}”`);
    case "tool:end":
      return withBook(isZh
        ? `问心 · 工具「${tool || "操作"}」完成`
        : `Ask · tool “${tool || "action"}” done`);
    case "book:created":
      return withBook(isZh ? "新书已落下" : "New book created");
    case "book:deleted":
      return withBook(isZh ? "书目已从书架取下" : "Book removed from shelf");
    case "book:error":
      return withBook(isZh ? "书籍操作未完成" : "Book action did not finish");
    case "short:updated":
      return withBook(isZh ? "短篇已更新" : "Short updated");
    case "short:deleted":
      return withBook(isZh ? "短篇已删除" : "Short deleted");
    case "import:start":
      return withBook(isZh ? "导入进行中" : "Import running");
    case "import:complete":
      return withBook(isZh ? "导入完成" : "Import finished");
    case "style:start":
      return withBook(isZh ? "文风分析进行中" : "Style analysis running");
    case "style:complete":
      return withBook(isZh ? "文风分析完成" : "Style analysis finished");
    case "daemon:started":
      return withBook(isZh ? "自动模式已启动" : "Auto mode started");
    case "daemon:stopped":
      return withBook(isZh ? "自动模式已停止" : "Auto mode stopped");
    case "daemon:chapter":
      return withBook(isZh
        ? `自动模式 · ${chapter || "一章"} 已写`
        : `Daemon · ${chapter || "a chapter"} written`);
    case "audit:complete":
      return withBook(isZh ? "审稿完成" : "Review finished");
    case "audit:error":
      return withBook(isZh ? "审稿未通过" : "Review did not pass");
    case "log":
      if (!message) return null;
      return withBook(message);
    case "task:snapshot":
      return withBook(isZh ? "任务状态已更新" : "Task snapshot updated");
    default:
      if (message) return withBook(message);
      return withBook(isZh ? "引擎有新动态" : "Engine activity");
  }
}

export function deriveActivityHeadline(
  messages: ReadonlyArray<{ readonly event: string; readonly data: unknown }>,
  books: ReadonlyArray<ActivityBookRef>,
  isZh: boolean,
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
    const data = asRecord(msg.data);
    const title = bookTitleOf(data, books);
    if (msg.event === "write:start" || msg.event === "draft:start" || msg.event === "llm:progress") {
      const chapter = chapterLabel(data, isZh);
      if (isZh) return title ? `正在写《${title}》${chapter}` : `正在写${chapter || "一章"}`;
      return title ? `Writing “${title}” ${chapter}`.trim() : `Writing ${chapter || "a chapter"}`;
    }
    if (msg.event === "weave:start") {
      return isZh
        ? (title ? `正在织《${title}》` : "正在织卷")
        : (title ? `Weaving “${title}”` : "Weaving");
    }
    if (msg.event === "agent:start") {
      return isZh
        ? (title ? `正在问心《${title}》` : "正在问心")
        : (title ? `Asking about “${title}”` : "Ask in progress");
    }
  }
  return isZh ? "引擎空闲" : "Engine idle";
}
