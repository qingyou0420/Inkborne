import { getAppLanguage, tr } from "./app-language";

const TRANSIENT_NETWORK_MESSAGE_RE =
  /^(Failed to fetch|NetworkError when attempting to fetch resource\.?|NetworkError)$/i;

export function transientNetworkUserMessage(): string {
  return tr(
    "请求暂时失败，请重试；若正文已出现可先刷新",
    "Request failed temporarily. Retry, or refresh if the text already appeared.",
  );
}

export function isTransientNetworkFetchError(cause: unknown): boolean {
  if (cause instanceof DOMException && cause.name === "AbortError") return false;
  const message = (cause instanceof Error ? cause.message : String(cause)).trim();
  if (TRANSIENT_NETWORK_MESSAGE_RE.test(message)) return true;
  return message === transientNetworkUserMessage();
}

const KNOWN_RUNTIME_REPLACEMENTS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replacement: string;
}> = [
  {
    pattern: /Latest chapter (\d+) is state-degraded\. Repair state or rewrite that chapter before continuing\./g,
    replacement: "最新第 $1 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。",
  },
  {
    pattern: /Chapter (\d+) is not state-degraded\./g,
    replacement: "第 $1 章不是状态降级（state-degraded），无需按状态修复。",
  },
  {
    pattern: /Only the latest state-degraded chapter can be repaired safely \(latest is (\d+)\)\./g,
    replacement: "只能安全修复最新的状态降级（state-degraded）章节；当前最新章是第 $1 章。",
  },
  {
    pattern: /State repair still failed for chapter (\d+)\./g,
    replacement: "第 $1 章状态修复仍然失败。",
  },
  {
    pattern: /Studio LLM API key not set\. Open Studio services and save an API key for the selected service\./g,
    replacement: "Studio 模型 API Key 未设置。请打开“模型配置”，为当前服务保存 API Key。",
  },
  {
    pattern: /INKOS_LLM_API_KEY not set\. Run 'inkos config set-global' or add it to project \.env file\./g,
    replacement: "INKOS_LLM_API_KEY 未设置。请运行 `inkos config set-global`，或在项目 .env 文件中添加它。",
  },
  {
    pattern: /Book "([^"]+)" is locked by an active write(?: \([^)]+\))?\. .*/g,
    replacement: "写入被占用：书「$1」正在被写作任务写入。请等待当前任务结束，或确认没有进行中的任务后使用「强制释放」。",
  },
  {
    pattern: /This in-process lock is not recovered automatically while the holder is still alive\. Abort the running task or POST \/api\/v1\/books\/:id\/lock\/force-release, then retry\./g,
    replacement: "进程内锁在持有者仍存活时不会自动恢复。请中止正在运行的任务，或使用「强制释放」，然后再试。",
  },
  {
    pattern: /volume_map\.md has no entry for chapter (\d+)\./g,
    replacement: "volume_map.md 没有第 $1 章条目。请先排纲。",
  },
  {
    pattern: /story_frame\.md is empty or still a placeholder\./g,
    replacement: "story_frame.md 为空或仍是占位。请先写骨架。",
  },
  {
    pattern: /author_intent\.md is empty or still a placeholder\./g,
    replacement: "author_intent.md 为空或仍是占位。请先写作者意图。",
  },
  {
    pattern: /Chapter (\d+) is not approved\. Pass skipPreviousApproval to continue with 带病续写\./g,
    replacement: "上一章（第 $1 章）尚未通过。勾选「带病续写」才能继续。",
  },
  {
    pattern: /Chapter (\d+) has (\d+) critical audit issue\(s\) and cannot be approved without an explicit override\./g,
    replacement: "第 $1 章有 $2 条 critical 审稿问题，未记录覆盖理由不能通过。",
  },
  {
    pattern: /LLM stream produced no token for (\d+)ms/g,
    replacement: "模型已超过 $1 毫秒没有新的有效内容。请检查当前模型/服务的超时或流式兼容性。",
  },
  {
    pattern: /LLM stream produced no event within (\d+)ms/g,
    replacement: "模型在 $1 毫秒内没有开始输出。请检查当前模型/服务的超时或流式兼容性。",
  },
  {
    pattern: /LLM call exceeded overall timeout of (\d+)ms/g,
    replacement: "模型整次调用超过 $1 毫秒仍未完成。请检查当前模型/服务的超时或流式兼容性。",
  },
];

export function localizeKnownRuntimeMessage(message: string): string {
  if (TRANSIENT_NETWORK_MESSAGE_RE.test(message.trim())) {
    return transientNetworkUserMessage();
  }
  // Runtime messages arrive in English; in English mode show them as-is.
  if (getAppLanguage() === "en") return message;
  let localized = message;
  for (const entry of KNOWN_RUNTIME_REPLACEMENTS) {
    localized = localized.replace(entry.pattern, entry.replacement);
  }
  return localized;
}
