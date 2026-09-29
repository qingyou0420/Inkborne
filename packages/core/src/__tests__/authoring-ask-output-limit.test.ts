// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptAskCanon, generateAskCanon, reviewAskCanon, reviseAskCanon } from "../authoring/stages/ask.js";
import { authoringRootDir, loadArtifact, loadManifest } from "../authoring/store.js";
import type { CanonDocument } from "../authoring/types.js";
import { PartialResponseError } from "../llm/provider.js";
import { ProjectConfigSchema } from "../models/project.js";

const ORIGINAL = `作者已定：船女阿渡寻找弟弟，亲属关系不得改写。\n${"封河、寻人、还船的顺序不变。".repeat(900)}\n作者原文最后一条：结局保留开放。`;
const CORRECTION = "作者补充：春汛发生在寻人之后，不改变此前的人物关系。";
const CANON: CanonDocument = {
  title: "渡口旧约", genre: "古风", targetChapters: 80, chapterWordCount: 3000,
  oneLine: "船女寻找失散的弟弟。", proposition: "守约与自由能否两全。",
  protagonist: "阿渡想找回弟弟并保住渡船。", conflict: "封河令与渡人承诺相撞。",
  voice: "以阿渡的观察为主。", boundaries: "结局保留开放。",
  direction: "从封河令传到渡口开始。", openQuestions: [],
};
const REVIEW = { summary: "补回已定事件因果。", issues: [
  { issueId: "cause", title: "补回春汛", severity: "improve", suggestion: "春汛在寻人之后。" },
] };

describe("Ask output limits through the actual provider and SDK transport", () => {
  let projectRoot: string;
  let finish: "stop" | "length";
  let reply: string;
  let outbound: Array<Record<string, unknown>>;
  const project = ProjectConfigSchema.parse({
    name: "ask-output-test", version: "0.1.0",
    llm: {
      provider: "openai", service: "custom:zenmux", configSource: "studio",
      baseUrl: "https://ask-output.invalid/api/v1", apiKey: "offline-test-only",
      apiFormat: "chat", model: "google/gemini-3.1-pro-preview", stream: true,
    },
    authoringRoles: {
      "ask.main": { modelId: "google/gemini-3.1-pro-preview" },
      "ask.review": { modelId: "anthropic/claude-opus-5" },
    },
  });

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "ask-output-"));
    finish = "stop";
    reply = JSON.stringify(CANON);
    outbound = [];
    vi.stubEnv("INKOS_AGENT_LLM_STUB", "");
    // Only HTTP is replaced; role resolution, default budgets, provider,
    // pi-ai request construction, stream parsing and artifact storage are real.
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : "{}");
      const body = JSON.parse(String(raw)) as Record<string, unknown>;
      outbound.push(body);
      const chunks = [
        { id: "ask-output-test", object: "chat.completion.chunk", model: body.model,
          choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] },
        { id: "ask-output-test", object: "chat.completion.chunk", model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: finish }],
          usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 } },
      ];
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    }));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it.each(["generate", "review", "revise"] as const)(
    "%s keeps the adopted canon, candidate and original source when the stream reaches length",
    async (operation) => {
      const draftRoot = { projectRoot, draftId: "first" };
      const generated = await generateAskCanon({ root: draftRoot, project, conversation: ORIGINAL });
      const adopted = await adoptAskCanon({ root: draftRoot, project, artifactId: generated.artifactId });
      const root = { projectRoot, bookId: adopted.bookId };
      reply = JSON.stringify(REVIEW);
      const report = await reviewAskCanon({ root, project, artifactId: generated.artifactId });
      const manifest = await loadManifest(root);
      const artifact = await loadArtifact(root, generated.artifactId);
      const canonPath = join(projectRoot, "books", adopted.bookId, "story", "canon.md");
      const canonBefore = await readFile(canonPath, "utf-8");
      const workflow = authoringRootDir(root);
      const artifactsBefore = await readdir(join(workflow, "artifacts"));
      const reportsBefore = await readdir(join(workflow, "reviews"));

      // Deliberately cut inside a JSON string: it must never become a draft.
      reply = `{"protagonist":"${"文".repeat(13183)}`;
      finish = "length";
      outbound = [];
      const ctx = { root, project, conversation: CORRECTION };
      const pending = operation === "generate"
        ? generateAskCanon(ctx)
        : operation === "review"
          ? reviewAskCanon({ ...ctx, artifactId: generated.artifactId })
          : reviseAskCanon({ ...ctx, artifactId: generated.artifactId, reportId: report.reportId, selectedIssueIds: ["cause"] });
      const error: unknown = await pending.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(PartialResponseError);
      expect(error).toMatchObject({ reason: "output-limit", partialContent: reply });
      expect(outbound).toHaveLength(1);
      const body = outbound[0]!;
      expect(body.model).toBe(operation === "review" ? "anthropic/claude-opus-5" : "google/gemini-3.1-pro-preview");
      expect(body.max_tokens ?? body.max_completion_tokens).toBe(operation === "review" ? 128_000 : 65_535);
      expect(JSON.stringify(body.messages)).toContain(ORIGINAL.split("\n").at(-1)!);
      expect(JSON.stringify(body.messages)).toContain(CORRECTION);
      expect(await loadManifest(root)).toEqual(manifest);
      expect(await loadArtifact(root, generated.artifactId)).toEqual(artifact);
      expect(await readFile(canonPath, "utf-8")).toBe(canonBefore);
      expect(await readdir(join(workflow, "artifacts"))).toEqual(artifactsBefore);
      expect(await readdir(join(workflow, "reviews"))).toEqual(reportsBefore);
      expect(await readFile(join(authoringRootDir(draftRoot), "source-conversation.md"), "utf-8")).toBe(ORIGINAL);
      const sources = await readdir(join(workflow, "source-conversations"));
      const savedSources = await Promise.all(sources.map(async (file) =>
        JSON.parse(await readFile(join(workflow, "source-conversations", file), "utf-8")) as { conversation: string }));
      expect(savedSources.map((source) => source.conversation)).toContain(CORRECTION);
    },
  );
});
