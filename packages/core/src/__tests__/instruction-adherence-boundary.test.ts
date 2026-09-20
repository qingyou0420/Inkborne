import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt, type AgentSystemPromptOptions } from "../agent/agent-system-prompt.js";
import type { SessionKind } from "../interaction/session.js";

// Fast structural guard for CI: verifies each surface exposes only the intended
// tool instructions. Real model adherence is covered by external/manual E2E runs.
// when INKOS_LIVE_E2E=1 is set.
type PromptCase = readonly [
  name: string,
  language: "zh" | "en",
  sessionKind: SessionKind,
  bookId: string | null,
  options: AgentSystemPromptOptions | undefined,
  mustContain: readonly string[],
  mustNotContain: readonly string[],
];

const CASES: readonly PromptCase[] = [
  ["chat/free-text proposes only", "zh", "chat", null, undefined, ["普通聊天助手", "propose_action"], ["sub_agent", "short_fiction_run", "play_start：", "play_revise：", "play_step：", "generate_cover："]],
  ["chat/en/free-text proposes only", "en", "chat", null, undefined, ["general chat assistant", "propose_action"], ["sub_agent", "short_fiction_run", "play_start:", "play_revise:", "play_step:", "generate_cover:"]],
  ["book-create/free-text discusses only", "zh", "book-create", null, undefined, ["整理正典", "采用并建书", "不要调用 propose_action"], ["可用工具：propose_action", "create_book", "sub_agent", "architect"]],
  ["book-create/confirmed runs architect", "zh", "book-create", null, { actionSource: "button", requestedIntent: "create_book" }, ["sub_agent", "architect"], ["short_fiction_run", "play_start", "play_step", "agent=\"writer\""]],
  ["short/free-text proposes only", "zh", "short", null, undefined, ["propose_action", "short_run"], ["short_fiction_run：", "short_fiction_run:"]],
  ["short/confirmed-run exposes runner", "zh", "short", null, { actionSource: "button", requestedIntent: "short_run" }, ["short_fiction_run"], ["propose_action", "generate_cover：", "sub_agent", "play_start"]],
  ["short/confirmed-cover exposes cover only", "zh", "short", null, { actionSource: "button", requestedIntent: "generate_cover" }, ["generate_cover", "不要重跑正文"], ["short_fiction_run", "sub_agent", "play_start"]],
  ["play/new-world proposes start", "zh", "play", null, { playWorldExists: false }, ["propose_action"], ["play_step：", "play_step:", "唯一要做的就是立即调用 play_step"]],
  ["play/en/new-world proposes start", "en", "play", null, { playWorldExists: false }, ["propose_action"], ["play_step:", "ONLY action this turn is to call play_step"]],
  ["play/active-world edit/revise/step only", "zh", "play", null, { playWorldExists: true }, ["play_edit", "play_revise", "play_step"], ["propose_action", "play_start：", "play_start:", "启动一个可玩的互动世界"]],
  ["play/en/active-world edit/revise/step only", "en", "play", null, { playWorldExists: true }, ["play_edit", "play_revise", "play_step"], ["propose_action", "play_start:", "start a playable interactive world"]],
  ["play/confirmed-start runs start only", "zh", "play", null, { actionSource: "button", requestedIntent: "play_start", playWorldExists: false }, ["play_start"], ["propose_action", "play_revise", "play_step：", "play_step:"]],
  ["book/active can write/edit only", "zh", "book", "demo-book", undefined, ["sub_agent", "writer", "auditor", "reviser"], ["agent=\"architect\"", "short_fiction_run", "play_start", "play_revise", "play_step"]],
  ["book/en active can write/edit only", "en", "book", "demo-book", undefined, ["sub_agent", "writer", "auditor", "reviser"], ["agent=\"architect\"", "short_fiction_run", "play_start", "play_revise", "play_step"]],
  ["edit/active deterministic only", "zh", "edit", "demo-book", undefined, ["read", "write_truth_file", "rename_entity", "patch_chapter_text"], ["sub_agent", "generate_cover", "short_fiction_run", "play_start", "play_revise", "play_step"]],
];

describe("instruction adherence prompt boundary", () => {
  it.each(CASES)("%s", (_name, language, sessionKind, bookId, options, mustContain, mustNotContain) => {
    const prompt = buildAgentSystemPrompt(bookId, language, sessionKind, options);
    for (const expected of mustContain) expect(prompt).toContain(expected);
    for (const forbidden of mustNotContain) expect(prompt).not.toContain(forbidden);
  });
});
