import { describe, it, expect, afterEach } from "vitest";
import { buildPartsFromEvents, type StreamEvent } from "../parts-builder";
import { setAppLanguage } from "../../../lib/app-language";

describe("buildPartsFromEvents", () => {
  it("produces thinking → text parts from basic conversation", () => {
    const parts = buildPartsFromEvents([
      { type: "thinking:start" },
      { type: "thinking:delta", text: "Let me think..." },
      { type: "thinking:end" },
      { type: "draft:delta", text: "Here is " },
      { type: "draft:delta", text: "the answer." },
    ]);

    expect(parts).toEqual([
      { type: "thinking", content: "Let me think...", streaming: false },
      { type: "text", content: "Here is the answer." },
    ]);
  });

  it("interleaves text and tool calls chronologically", () => {
    const parts = buildPartsFromEvents([
      { type: "draft:delta", text: "Let me read the file..." },
      { type: "tool:start", id: "t1", tool: "read" },
      { type: "tool:end", id: "t1", result: "file content" },
      { type: "draft:delta", text: "Here is the analysis." },
    ]);

    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: "text", content: "Let me read the file..." });
    expect(parts[1].type).toBe("tool");
    if (parts[1].type === "tool") {
      expect(parts[1].execution.tool).toBe("read");
      expect(parts[1].execution.status).toBe("completed");
    }
    expect(parts[2]).toEqual({ type: "text", content: "Here is the analysis." });
  });

  it("moves pre-tool text to thinking when tool starts", () => {
    const parts = buildPartsFromEvents([
      { type: "thinking:start" },
      { type: "thinking:delta", text: "Reasoning here" },
      { type: "thinking:end" },
      { type: "draft:delta", text: "I will call writer now" },
      { type: "tool:start", id: "t1", tool: "sub_agent", agent: "writer", stages: ["准备章节输入", "撰写章节草稿"] },
      { type: "log:stage", stageName: "准备章节输入" },
      { type: "log:stage", stageName: "撰写章节草稿" },
      { type: "tool:end", id: "t1" },
      { type: "draft:delta", text: "Chapter written." },
    ]);

    // Pre-tool text "I will call writer now" should become thinking, not a text part
    expect(parts[0].type).toBe("thinking");
    if (parts[0].type === "thinking") {
      expect(parts[0].content).toContain("Reasoning here");
      expect(parts[0].content).toContain("I will call writer now");
    }
    expect(parts[1].type).toBe("tool");
    if (parts[1].type === "tool") {
      expect(parts[1].execution.agent).toBe("writer");
      expect(parts[1].execution.stages).toHaveLength(2);
      expect(parts[1].execution.stages![0].status).toBe("completed");
      expect(parts[1].execution.stages![1].status).toBe("completed");
    }
    expect(parts[2]).toEqual({ type: "text", content: "Chapter written." });
  });

  it("handles multiple tool calls in sequence", () => {
    const parts = buildPartsFromEvents([
      { type: "tool:start", id: "t1", tool: "read" },
      { type: "tool:end", id: "t1" },
      { type: "tool:start", id: "t2", tool: "grep" },
      { type: "tool:end", id: "t2" },
      { type: "tool:start", id: "t3", tool: "sub_agent", agent: "writer", stages: ["准备章节输入"] },
      { type: "tool:end", id: "t3" },
      { type: "draft:delta", text: "Done." },
    ]);

    expect(parts).toHaveLength(4);
    expect(parts[0].type).toBe("tool"); // read
    expect(parts[1].type).toBe("tool"); // grep
    expect(parts[2].type).toBe("tool"); // writer
    expect(parts[3]).toEqual({ type: "text", content: "Done." });
  });

  it("tracks pipeline stages and progress on running tool", () => {
    const parts = buildPartsFromEvents([
      { type: "tool:start", id: "t1", tool: "sub_agent", agent: "writer", stages: ["步骤1", "步骤2"] },
      { type: "log:stage", stageName: "步骤1" },
      { type: "llm:progress", status: "thinking", elapsedMs: 5000, totalChars: 0, chineseChars: 0 },
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("tool");
    if (parts[0].type === "tool") {
      const exec = parts[0].execution;
      expect(exec.status).toBe("running");
      expect(exec.stages![0].status).toBe("active");
      expect(exec.stages![0].progress?.status).toBe("thinking");
      expect(exec.stages![1].status).toBe("pending");
    }
  });

  it("renders session context compression as a visible running card when no tool is active", () => {
    const parts = buildPartsFromEvents([
      {
        type: "context:compression",
        category: "session_context",
        phase: "start",
        sources: ["story/current_state.md"],
      },
      {
        type: "context:compression",
        category: "session_context",
        phase: "end",
        sources: ["story/current_state.md"],
      },
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("tool");
    if (parts[0].type === "tool") {
      expect(parts[0].execution.tool).toBe("context_compression");
      expect(parts[0].execution.label).toBe("整理会话记忆");
      expect(parts[0].execution.status).toBe("completed");
      expect(parts[0].execution.stages?.[0]).toMatchObject({
        label: "整理会话记忆",
        status: "completed",
      });
    }
  });

  it("renders story context compression as a visible stage inside the running writer tool", () => {
    const parts = buildPartsFromEvents([
      { type: "tool:start", id: "t1", tool: "sub_agent", agent: "writer", stages: ["准备章节输入", "撰写章节草稿"] },
      {
        type: "context:compression",
        category: "story_context",
        phase: "start",
        protectedTokens: 1200,
        compressibleTokens: 9000,
        budgetTokens: 6000,
      },
      {
        type: "context:compression",
        category: "story_context",
        phase: "end",
        protectedTokens: 1200,
        compressibleTokens: 9000,
        budgetTokens: 6000,
      },
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("tool");
    if (parts[0].type === "tool") {
      const compressionStage = parts[0].execution.stages?.find((stage) => stage.label === "压缩故事上下文");
      expect(compressionStage).toMatchObject({
        label: "压缩故事上下文",
        status: "completed",
      });
    }
  });

  it("shows context compression token budget and source trace while running", () => {
    const parts = buildPartsFromEvents([
      { type: "tool:start", id: "t1", tool: "sub_agent", agent: "writer", stages: ["准备章节输入"] },
      {
        type: "context:compression",
        category: "story_context",
        phase: "start",
        protectedTokens: 1200,
        compressibleTokens: 9000,
        budgetTokens: 6000,
        sources: [
          "story/chapter_summaries.md#recent_titles",
          "story/pending_hooks.md#active",
          "story/outline/volume_map.md#volume_2",
          "story/roles/主要角色/林月.md",
        ],
      },
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("tool");
    if (parts[0].type === "tool") {
      const compressionStage = parts[0].execution.stages?.find((stage) => stage.label === "压缩故事上下文");
      expect(compressionStage?.progress?.status).toContain("保护 1200");
      expect(compressionStage?.progress?.status).toContain("可压缩 9000");
      expect(compressionStage?.progress?.status).toContain("预算 6000");
      expect(compressionStage?.progress?.status).toContain("来源 4: story/chapter_summaries.md#recent_titles");
      expect(compressionStage?.progress?.status).toContain("+1");
    }
  });

  it("handles multi-turn thinking (append, not overwrite)", () => {
    const parts = buildPartsFromEvents([
      { type: "thinking:start" },
      { type: "thinking:delta", text: "First thought" },
      { type: "thinking:end" },
      { type: "tool:start", id: "t1", tool: "read" },
      { type: "tool:end", id: "t1" },
      { type: "thinking:start" },
      { type: "thinking:delta", text: "Second thought" },
      { type: "thinking:end" },
      { type: "draft:delta", text: "Final answer" },
    ]);

    // Two thinking parts, tool in between, then text
    const thinkingParts = parts.filter(p => p.type === "thinking");
    expect(thinkingParts).toHaveLength(2);
    expect(thinkingParts[0].type === "thinking" && thinkingParts[0].content).toBe("First thought");
    expect(thinkingParts[1].type === "thinking" && thinkingParts[1].content).toBe("Second thought");
    expect(parts.map(p => p.type)).toEqual(["thinking", "tool", "thinking", "text"]);
  });

  it("marks tool error correctly", () => {
    const parts = buildPartsFromEvents([
      { type: "tool:start", id: "t1", tool: "sub_agent", agent: "writer" },
      { type: "tool:end", id: "t1", isError: true, result: "timeout" },
    ]);

    expect(parts[0].type).toBe("tool");
    if (parts[0].type === "tool") {
      expect(parts[0].execution.status).toBe("error");
      expect(parts[0].execution.error).toBe("timeout");
    }
  });

  it("preserves structured tool details for generated artifacts", () => {
    const details = {
      kind: "short_fiction_created",
      storyId: "demo",
      coverImagePath: "shorts/demo/final/cover.png",
    };
    const parts = buildPartsFromEvents([
      { type: "tool:start", id: "t1", tool: "short_fiction_run" },
      { type: "tool:end", id: "t1", result: "Short fiction completed.", details },
    ]);

    expect(parts[0].type).toBe("tool");
    if (parts[0].type === "tool") {
      expect(parts[0].execution.details).toEqual(details);
    }
  });

  it("labels play tools as first-class pipeline actions", () => {
    const parts = buildPartsFromEvents([
      { type: "tool:start", id: "p1", tool: "play_start" },
      { type: "tool:end", id: "p1", result: "started" },
      { type: "tool:start", id: "p2", tool: "play_step" },
      { type: "tool:end", id: "p2", result: "advanced" },
      { type: "tool:start", id: "p3", tool: "play_edit" },
      { type: "tool:end", id: "p3", result: "updated" },
      { type: "tool:start", id: "p4", tool: "play_revise" },
      { type: "tool:end", id: "p4", result: "revised" },
    ]);

    expect(parts).toHaveLength(4);
    expect(parts[0].type === "tool" ? parts[0].execution.label : "").toBe("启动互动世界");
    expect(parts[1].type === "tool" ? parts[1].execution.label : "").toBe("推进互动世界");
    expect(parts[2].type === "tool" ? parts[2].execution.label : "").toBe("编辑互动世界");
    expect(parts[3].type === "tool" ? parts[3].execution.label : "").toBe("重做互动回合");
  });

  it("labels narrative forecast tools as first-class planning actions", () => {
    const parts = buildPartsFromEvents([
      { type: "tool:start", id: "f1", tool: "create_narrative_forecast" },
      { type: "tool:end", id: "f1", result: "created" },
      { type: "tool:start", id: "f2", tool: "get_narrative_forecast" },
      { type: "tool:end", id: "f2", result: "fresh" },
      { type: "tool:start", id: "f3", tool: "select_narrative_branch" },
      { type: "tool:end", id: "f3", result: "selected" },
    ]);

    expect(parts[0].type === "tool" ? parts[0].execution.label : "").toBe("剧情多线推演");
    expect(parts[1].type === "tool" ? parts[1].execution.label : "").toBe("核验剧情推演");
    expect(parts[2].type === "tool" ? parts[2].execution.label : "").toBe("采用候选分支");
  });

  it("does not render model narration after a completed play tool as authoritative text", () => {
    const parts = buildPartsFromEvents([
      { type: "tool:start", id: "p1", tool: "play_step" },
      {
        type: "tool:end",
        id: "p1",
        result: "advanced",
        details: {
          kind: "play_turn_advanced",
          sceneText: "工具生成的权威场景。",
          suggestedActions: ["检查票根"],
        },
      },
      { type: "draft:delta", text: "模型又复述了一遍场景。" },
    ]);

    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe("tool");
    expect(parts[1].type).toBe("thinking");
    expect(parts.some((part) => part.type === "text")).toBe(false);
  });

  it("does not render model narration after a revised play turn as authoritative text", () => {
    const parts = buildPartsFromEvents([
      { type: "tool:start", id: "p1", tool: "play_revise" },
      {
        type: "tool:end",
        id: "p1",
        result: "revised",
        details: {
          kind: "play_turn_revised",
          sceneText: "工具生成的新版本场景。",
          suggestedActions: ["检查录音笔"],
        },
      },
      { type: "draft:delta", text: "模型又复述了一遍新版本。" },
    ]);

    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe("tool");
    expect(parts[1].type).toBe("thinking");
    expect(parts.some((part) => part.type === "text")).toBe(false);
  });

  it("labels proposed action confirmations", () => {
    const parts = buildPartsFromEvents([
      { type: "tool:start", id: "a1", tool: "propose_action" },
      { type: "tool:end", id: "a1", result: "confirm", details: { kind: "proposed_action" } },
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0].type === "tool" ? parts[0].execution.label : "").toBe("确认动作");
  });

  it("localizes known tool errors", () => {
    const parts = buildPartsFromEvents([
      { type: "tool:start", id: "t1", tool: "sub_agent", agent: "writer" },
      {
        type: "tool:end",
        id: "t1",
        isError: true,
        result: "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
      },
    ]);

    expect(parts[0].type).toBe("tool");
    if (parts[0].type === "tool") {
      expect(parts[0].execution.error).toBe(
        "最新第 1 章状态待修。继续写下一章前，请先修复这一章的状态，或重写这一章。",
      );
    }
  });
});

describe("buildPartsFromEvents in English app language", () => {
  afterEach(() => {
    setAppLanguage("zh");
  });

  it("resolves agent and tool labels in English", () => {
    setAppLanguage("en");
    const parts = buildPartsFromEvents([
      { type: "tool:start", id: "t1", tool: "read" },
      { type: "tool:end", id: "t1" },
      { type: "tool:start", id: "t2", tool: "sub_agent", agent: "writer" },
      { type: "tool:end", id: "t2" },
    ]);

    expect(parts[0].type === "tool" ? parts[0].execution.label : "").toBe("Read file");
    expect(parts[1].type === "tool" ? parts[1].execution.label : "").toBe("Write");
  });

  it("labels session context compression and its progress in English", () => {
    setAppLanguage("en");
    const parts = buildPartsFromEvents([
      {
        type: "context:compression",
        category: "session_context",
        phase: "start",
        protectedTokens: 1200,
        compressibleTokens: 9000,
        budgetTokens: 6000,
        sources: ["story/current_state.md"],
      },
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("tool");
    if (parts[0].type === "tool") {
      expect(parts[0].execution.label).toBe("Organize session memory");
      const stage = parts[0].execution.stages?.[0];
      expect(stage?.label).toBe("Organize session memory");
      expect(stage?.progress?.status).toContain("protected 1200");
      expect(stage?.progress?.status).toContain("compressible 9000");
      expect(stage?.progress?.status).toContain("budget 6000");
      expect(stage?.progress?.status).toContain("sources 1");
    }
  });

  it("keeps English runtime error messages untouched", () => {
    setAppLanguage("en");
    const parts = buildPartsFromEvents([
      { type: "tool:start", id: "t1", tool: "sub_agent", agent: "writer" },
      {
        type: "tool:end",
        id: "t1",
        isError: true,
        result: "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
      },
    ]);

    expect(parts[0].type).toBe("tool");
    if (parts[0].type === "tool") {
      expect(parts[0].execution.error).toBe(
        "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
      );
    }
  });
});
