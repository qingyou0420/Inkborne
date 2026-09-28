import { describe, expect, it } from "vitest";
import { localizeKnownRuntimeMessage } from "./error-copy";

describe("localizeKnownRuntimeMessage", () => {
  it("localizes the state-degraded continuation blocker", () => {
    expect(localizeKnownRuntimeMessage(
      "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
    )).toBe("最新第 1 章状态待修。继续写下一章前，请先修复这一章的状态，或重写这一章。");
  });

  it("localizes related state repair errors while preserving unknown messages", () => {
    expect(localizeKnownRuntimeMessage("Chapter 3 is not state-degraded.")).toBe(
      "第 3 章不是状态待修，不用按状态修复。",
    );
    expect(localizeKnownRuntimeMessage(
      "Only the latest state-degraded chapter can be repaired safely (latest is 5).",
    )).toBe("只能安全修复最新一章的状态待修；当前最新章是第 5 章。");
    expect(localizeKnownRuntimeMessage("Bad request")).toBe("Bad request");
  });

  it("localizes common LLM configuration errors", () => {
    const studioMessage = localizeKnownRuntimeMessage(
      "Studio LLM API key not set. Open Studio services and save an API key for the selected service.",
    );
    expect(studioMessage).toContain("还没有保存模型密钥");
    expect(studioMessage).not.toMatch(/kkaiapi/i);

    const cliMessage = localizeKnownRuntimeMessage(
      "INKOS_LLM_API_KEY not set. Run 'inkos config set-global' or add it to project .env file.",
    );
    expect(cliMessage).toContain("还没有设置模型密钥");
    expect(cliMessage).not.toMatch(/kkaiapi/i);
  });

  it("localizes P1 write-preflight and approve-blocked messages", () => {
    const volume = localizeKnownRuntimeMessage("volume_map.md has no entry for chapter 2.");
    expect(volume).toContain("第 2 章");
    expect(volume).toContain("卷纲");
    expect(volume).not.toContain("volume_map");
    const critical = localizeKnownRuntimeMessage(
      "Chapter 4 has 3 critical audit issue(s) and cannot be approved without an explicit override.",
    );
    expect(critical).toContain("第 4 章");
    expect(critical).toContain("严重");
    expect(critical).not.toContain("critical");
  });

  it("localizes leftover English stream-idle errors", () => {
    const message = localizeKnownRuntimeMessage("LLM stream produced no token for 60000ms");
    expect(message).toContain("没有新的有效内容");
    expect(message).toContain("流式兼容性");
    expect(message).not.toMatch(/produced no token/i);
  });

  it("localizes in-process write locks as 写入被占用, not a read failure", () => {
    const message = localizeKnownRuntimeMessage(
      'Book "醉词" is locked by an active write (pid:123 started:2026-09-06T00:00:00.000Z). This in-process lock is not recovered automatically while the holder is still alive. Abort the running task or POST /api/v1/books/:id/lock/force-release, then retry.',
    );
    expect(message).toContain("写入被占用");
    expect(message).toContain("醉词");
    expect(message).not.toContain("读取");
    expect(message).not.toContain("force-release");
    expect(message).not.toMatch(/pid/i);
  });

  it("strips a leading Error: prefix", () => {
    expect(localizeKnownRuntimeMessage("Error: Bad request")).toBe("Bad request");
  });
});
