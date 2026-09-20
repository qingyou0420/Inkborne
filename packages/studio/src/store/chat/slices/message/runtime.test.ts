import { describe, expect, it } from "vitest";
import type { Message, ToolExecution } from "../../types";
import { createSessionRuntime, deriveResolvedProposals, deserializeMessages, extractErrorMessage, extractToolError, hasInFlightExecution, markRunningToolsFailed, mergeTaskExecution, withToolExecutions } from "./runtime";

function exec(overrides: Partial<ToolExecution> & { id: string; tool: string }): ToolExecution {
  const { id, tool, ...rest } = overrides;
  return {
    id,
    tool,
    label: tool,
    status: "completed",
    startedAt: 1,
    ...rest,
  };
}

describe("chat runtime error copy", () => {
  it("localizes known assistant errors", () => {
    expect(extractErrorMessage({
      message: "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
    })).toBe("最新第 1 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。");
  });

  it("localizes known tool errors", () => {
    expect(extractToolError({
      content: [
        {
          type: "text",
          text: "Latest chapter 2 is state-degraded. Repair state or rewrite that chapter before continuing.",
        },
      ],
    })).toBe("最新第 2 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。");
  });
});

describe("createSessionRuntime", () => {
  it("carries playMode on the session runtime", () => {
    const rt = createSessionRuntime({ sessionId: "s1", bookId: null, sessionKind: "play", playMode: "guided", title: null });
    expect(rt.playMode).toBe("guided");
  });
});

describe("deriveResolvedProposals", () => {
  it("marks a proposed play start as confirmed when play_start completed later", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "proposal-1",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "play_start",
              targetSessionKind: "play",
              instruction: "启动旧影院",
            },
          }),
        ],
      },
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolExecutions: [
          exec({
            id: "play-1",
            tool: "play_start",
            details: { kind: "play_world_started" },
          }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "proposal-1": "confirmed" });
  });

  it("marks a proposed interactive-film creation as confirmed when the tool completed later", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "proposal-1",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "interactive_film_create",
              targetSessionKind: "interactive-film",
              instruction: "制作鸦冠之宴",
            },
          }),
        ],
      },
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolExecutions: [
          exec({
            id: "interactive-1",
            tool: "interactive_film_create",
            details: { kind: "interactive_film_created" },
          }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "proposal-1": "confirmed" });
  });

  it("marks a proposed book creation as confirmed only by an architect sub-agent", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "proposal-1",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "create_book",
              targetSessionKind: "book-create",
              instruction: "建一本债务悬疑",
            },
          }),
          exec({ id: "writer-1", tool: "sub_agent", agent: "writer" }),
          exec({ id: "architect-1", tool: "sub_agent", agent: "architect" }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "proposal-1": "confirmed" });
  });

  it("marks a proposed book creation as confirmed when 问心 ask_create completed on restore", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "proposal-1",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "create_book",
              targetSessionKind: "book-create",
              instruction: "建一本渡河记",
            },
          }),
        ],
      },
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolExecutions: [
          exec({
            id: "ask-create-1",
            tool: "ask_create",
            agent: "ask",
            details: { kind: "book_created", bookId: "du-he-ji", adopted: false },
          }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "proposal-1": "confirmed" });
  });

  it("confirms only one matching proposal per completed production action", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "old-proposal",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "play_start",
              targetSessionKind: "play",
              instruction: "启动旧广播站",
            },
          }),
          exec({
            id: "new-proposal",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "play_start",
              targetSessionKind: "play",
              instruction: "启动水文站",
            },
          }),
        ],
      },
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolExecutions: [
          exec({
            id: "play-1",
            tool: "play_start",
            details: { kind: "play_world_started" },
          }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "new-proposal": "confirmed" });
  });
});

describe("deserializeMessages", () => {
  it("restores tool executions from legacyDisplay for tool-only assistant messages", () => {
    const messages = deserializeMessages([
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        legacyDisplay: {
          toolExecutions: [
            exec({
              id: "interactive-1",
              tool: "interactive_film_create",
              details: { kind: "interactive_film_created", baseDir: "interactive-films/crow-crown-banquet" },
            }),
          ],
        },
      } as any,
    ]);

    expect(messages[0]?.toolExecutions?.[0]?.tool).toBe("interactive_film_create");
    expect(messages[0]?.parts?.[0]?.type).toBe("tool");
  });
});

describe("withToolExecutions", () => {
  it("adds returned tool executions before final text content", () => {
    const message = withToolExecutions({
      role: "assistant",
      content: "完成。",
      timestamp: 1,
    }, [
      exec({
        id: "script-1",
        tool: "script_create",
        details: { kind: "script_created" },
      }),
    ]);

    expect(message.toolExecutions?.map((execution) => execution.tool)).toEqual(["script_create"]);
    expect(message.parts?.map((part) => part.type)).toEqual(["tool", "text"]);
    expect(message.content).toBe("完成。");
  });
});

describe("mergeTaskExecution", () => {
  it("adds a persisted running task as a background-tagged restorable tool card", () => {
    const execution = exec({
      id: "short-task-1",
      tool: "short_fiction_run",
      status: "running",
      logs: ["正在生成大纲"],
      startedAt: 10,
    });

    const messages = mergeTaskExecution([], execution);

    // 任务快照必然来自后台生产任务：恢复出的卡带 background 标记，
    // 供无 id 事件的回退路由跳过它。
    const tagged = { ...execution, background: true };
    expect(messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        timestamp: 10,
        toolExecutions: [tagged],
        parts: [{ type: "tool", execution: tagged }],
      }),
    ]);
  });

  it("updates the existing task card instead of duplicating it", () => {
    const running = exec({ id: "task-1", tool: "script_create", status: "running", startedAt: 10 });
    const completed = exec({
      id: "task-1",
      tool: "script_create",
      status: "completed",
      result: "完成",
      startedAt: 10,
      completedAt: 20,
    });

    const messages = mergeTaskExecution(mergeTaskExecution([], running), completed);

    // 终态快照替换整个 execution 时不能丢 background 标记
    const tagged = { ...completed, background: true };
    expect(messages).toHaveLength(1);
    expect(messages[0]?.toolExecutions).toEqual([tagged]);
    expect(messages[0]?.parts).toEqual([{ type: "tool", execution: tagged }]);
  });
});

describe("hasInFlightExecution", () => {
  it("finds an execution that is still running in the session messages", () => {
    const running = exec({ id: "task-1", tool: "short_fiction_run", status: "running", startedAt: 10 });
    const messages = mergeTaskExecution([], running);

    expect(hasInFlightExecution(messages, "task-1")).toBe(true);
  });

  it("does not treat a completed execution or an unknown id as in flight", () => {
    const completed = exec({
      id: "task-1",
      tool: "short_fiction_run",
      status: "completed",
      startedAt: 10,
      completedAt: 20,
    });
    const messages = mergeTaskExecution([], completed);

    expect(hasInFlightExecution(messages, "task-1")).toBe(false);
    expect(hasInFlightExecution(messages, "task-2")).toBe(false);
  });
});

describe("markRunningToolsFailed", () => {
  it("ends active tool cards immediately when the user stops a task", () => {
    const running = exec({ id: "task-1", tool: "short_fiction_run", status: "running", startedAt: 10 });
    const message: Message = {
      role: "assistant",
      content: "",
      timestamp: 10,
      toolExecutions: [running],
      parts: [{ type: "tool", execution: running }],
    };

    const messages = markRunningToolsFailed([message], "已由用户停止", 20);

    expect(messages[0]?.toolExecutions?.[0]).toMatchObject({
      status: "error",
      error: "已由用户停止",
      completedAt: 20,
    });
    expect(messages[0]?.parts?.[0]).toMatchObject({
      type: "tool",
      execution: {
        status: "error",
        error: "已由用户停止",
        completedAt: 20,
      },
    });
  });
});
