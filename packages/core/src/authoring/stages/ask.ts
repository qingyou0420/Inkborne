/**
 * 问心: chat → canon candidate → optional review → adopt + lightweight book.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCanon, serializeCanon } from "../canon.js";
import { loadCanonDocument } from "../context.js";
import { asNumber, extractJsonObject } from "../json.js";
import { completeRole } from "../llm.js";
import { fillMissingAuthoringRoles, loadRoleApiKeys, resolveAuthoringRole } from "../model-config.js";
import { assertReportReusable, parseReviewPayload, reviewPrompt } from "../review.js";
import {
  AuthoringRunCancelledError,
  authoringRootDir,
  loadArtifact,
  loadManifest,
  loadReport,
  loadRun,
  newArtifactId,
  newRunId,
  saveArtifact,
  saveManifest,
  saveReport,
  saveRun,
  throwIfRunCancelled,
  type AuthoringStoreRoot,
} from "../store.js";
import { canonLengthRequiredError, createLightweightBook, hasConfirmedCanonLength, syncBookJsonTitle } from "../book-create.js";
import { nextCanonImpactState } from "./impact.js";
import {
  AuthoringRunRecordSchema,
  type AuthoringLlmFn,
  type AuthoringArtifactMeta,
  type AuthoringReviewReport,
  type AuthoringRunRecord,
  type CanonDocument,
  type ResolvedAuthoringRole,
} from "../types.js";
import type { z } from "zod";
import type { ProjectConfig } from "../../models/project.js";

export interface AskRuntime {
  readonly root: AuthoringStoreRoot;
  readonly project: ProjectConfig;
  readonly llm?: AuthoringLlmFn;
}

function rolesOf(project: ProjectConfig) {
  return fillMissingAuthoringRoles(project);
}

async function resolve(
  project: ProjectConfig,
  role: "ask.main" | "ask.review",
  projectRoot?: string,
): Promise<ResolvedAuthoringRole> {
  return resolveAuthoringRole({
    roleId: role,
    baseLlm: project.llm,
    roles: rolesOf(project),
    apiKeys: projectRoot ? await loadRoleApiKeys(projectRoot) : undefined,
  });
}

async function readAskSource(path: string): Promise<string> {
  try { return await readFile(path, "utf-8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

interface AskConversationSnapshot {
  readonly timestamp: number;
  readonly conversation: string;
  readonly id: string;
  readonly kind: "conversation" | "author-requirement";
}

async function readAskConversationSnapshots(root: AuthoringStoreRoot): Promise<AskConversationSnapshot[]> {
  const directory = join(authoringRootDir(root), "source-conversations");
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const snapshots: AskConversationSnapshot[] = [];
  for (const file of files.filter((file) => file.endsWith(".json"))) {
    const value = JSON.parse(await readFile(join(directory, file), "utf-8")) as Partial<AskConversationSnapshot>;
    if (!Number.isFinite(value.timestamp) || typeof value.conversation !== "string") {
      throw new Error("保存的问心对话补充记录不完整，请先恢复该记录再整理正典。");
    }
    snapshots.push({ timestamp: value.timestamp!, conversation: value.conversation, id: file,
      kind: value.kind === "author-requirement" ? "author-requirement" : "conversation" });
  }
  return snapshots;
}

/** Keep source material independent of generated candidates and review prose. */
async function askAuthorContext(root: AuthoringStoreRoot, conversation?: string, authorRequirement?: string): Promise<{
  prompt: string;
  inputRefs: AuthoringReviewReport["inputRefs"];
}> {
  const workflowDir = authoringRootDir(root);
  const sourcePath = join(workflowDir, "source-conversation.md");
  if (!root.bookId && conversation?.trim()) {
    await mkdir(workflowDir, { recursive: true });
    try {
      // The first source survives short follow-ups and failed generations.
      // Exclusive creation also prevents two concurrent calls overwriting it.
      await writeFile(sourcePath, conversation, { encoding: "utf-8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const sections: string[] = [];
  const inputRefs: AuthoringReviewReport["inputRefs"] = [];
  const seen = new Set<string>();
  const sourceRoots: AuthoringStoreRoot[] = [];
  let originalConversation = "";
  const include = (label: string, body: string, id: string, kind = "author-source") => {
    const key = body.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    sections.push(`【${label}】\n${body}`);
    inputRefs.push({ kind, id });
  };
  if (root.bookId) {
    // Older lightweight adoption retains a linked draft; the new atomic
    // creation path moves its workflow/source file into the book instead.
    const draftId = root.draftId ?? (await loadManifest(root)).draftId;
    if (draftId) {
      const draftRoot = { projectRoot: root.projectRoot, draftId };
      sourceRoots.push(draftRoot);
      originalConversation = await readAskSource(join(authoringRootDir(draftRoot), "source-conversation.md"));
      include("建书前保存的原始问心对话", originalConversation, `draft:${draftId}/source-conversation.md`);
    }
  }
  sourceRoots.push(root);
  const savedOriginal = await readAskSource(sourcePath);
  if (savedOriginal.trim()) originalConversation = savedOriginal;
  include("保存的原始问心对话", savedOriginal, "source-conversation.md");
  if (root.bookId) {
    const storyDir = join(root.projectRoot, "books", root.bookId, "story");
    for (const file of ["author_intent.md", "brief.md"]) {
      include(`持久作者材料：${file}`, await readAskSource(join(storyDir, file)), `story/${file}`);
    }
  }
  const snapshots = (await Promise.all(sourceRoots.map(readAskConversationSnapshots))).flat()
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  const appendSnapshot = async (text: string | undefined, kind: AskConversationSnapshot["kind"]) => {
    const sameKind = snapshots.filter((snapshot) => snapshot.kind === kind);
    const previous = sameKind.at(-1)?.conversation ?? (kind === "conversation" ? originalConversation : "");
    if (!text?.trim() || text === previous) return;
    if (kind === "conversation" && sameKind.length === 0 && seen.has(text.trim())) return;
    // Never overwrite the initial source. Each later submission is its own
    // record, so A → B → A preserves the author's explicit return to A.
    const timestamp = Math.max(Date.now(), (snapshots.at(-1)?.timestamp ?? 0) + 1);
    const id = `${timestamp}-${randomUUID()}.json`;
    const directory = join(workflowDir, "source-conversations");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, id), JSON.stringify({ timestamp, conversation: text, kind }), { encoding: "utf-8", flag: "wx" });
    snapshots.push({ timestamp, conversation: text, id, kind });
  };
  await appendSnapshot(conversation, "conversation");
  await appendSnapshot(authorRequirement, "author-requirement");
  const previousSnapshots = new Map<AskConversationSnapshot["kind"], string>();
  for (const snapshot of snapshots) {
    if (snapshot.conversation === previousSnapshots.get(snapshot.kind)) continue;
    previousSnapshots.set(snapshot.kind, snapshot.conversation);
    // Do not globally deduplicate history: the same words may be a newer
    // decision that reverses an intervening correction.
    const label = snapshot.kind === "author-requirement" ? "作者在整理或修订时明确提交的补充" : "作者对话与补充";
    sections.push(`【按时间保存的${label}：${new Date(snapshot.timestamp).toISOString()}，越后越新】\n${snapshot.conversation}`);
    inputRefs.push({ kind: "conversation", id: `source-conversations/${snapshot.id}` });
  }
  if (conversation?.trim()) inputRefs.push({ kind: "conversation", id: "ask-chat" });
  return {
    prompt: [
      "作者依据规则：持久原文与当前对话共同构成依据。较新对话中作者明确作出的修改优先于旧约定，其余已确认人物、关键事件、因果和结局继续保留。",
      "对话及材料可能同时包含作者发言与助手整理；模型提案、助手建议和审查意见不等于作者定案。只有作者明确确认的故事事实与要求才能覆盖原意；有疑问则列待确认，不自行改写既定核心。",
      "本次整理/审查的格式、校验与防虚构指令属于工作要求，不能自动变成小说的故事边界或新增题材禁令。",
      ...sections,
    ].join("\n\n"),
    inputRefs,
  };
}

const CANON_OUTPUT_INSTRUCTIONS = [
  "返回完整 JSON 对象，包含以下全部字段；未修改的字段也保留原内容：",
  "title: string（书名）；genre: string（题材，尚未确定可为空字符串）；",
  "targetChapters: 正整数或 null（目标章数）；chapterWordCount: 不小于 100 的整数或 null（每章字数）。未定篇幅使用 null，不要自行决定。",
  "oneLine: string（一句话故事）；proposition: string（核心命题）；protagonist: string（主角与核心欲望）；conflict: string（主要冲突）；",
  "voice: string（叙事视角与文风）；boundaries: string（故事边界）；direction: string（初始方向）；openQuestions: string[]（待定项）。",
  "所有 string 字段必须是字符串，不能使用对象或数组；多项内容请整理成同一字符串中的分段文字。openQuestions 的每一项也必须是字符串。",
  "JSON 字段名严格使用上述英文名称；面向作者的全部字段内容使用简体中文，人物称谓和术语沿用作者原命名，不要把 POV、arc、want、need 等英文分析标签写入正文内容。",
  "逐项对照完整作者对话与当前正典，整理已明确的主角身份与核心欲望、叙事视角与文风、故事边界、初始方向，不得把已有依据的内容遗漏为‘待补’。",
  "确无依据的部分写明具体待确认问题，并列入 openQuestions；保留作者主动待定的设定、开放结局和篇幅，不要杜撰事实或替作者自动决定。",
].join("\n");

function canonFromJson(raw: Record<string, unknown>, baseCanon?: CanonDocument): CanonDocument {
  let suppliedFields = 0;
  const field = (name: string, aliases: readonly string[]): { present: boolean; value?: unknown } => {
    const key = [name, ...aliases].find((key) => Object.prototype.hasOwnProperty.call(raw, key));
    if (key === undefined) return { present: false };
    suppliedFields += 1;
    return { present: true, value: raw[key] };
  };
  const text = (name: string, aliases: readonly string[], fallback = ""): string => {
    const entry = field(name, aliases);
    if (!entry.present) return fallback;
    if (typeof entry.value !== "string") {
      throw new Error(`正典字段 ${name} 必须是字符串，不能使用对象、数组或其他类型。请重新生成。`);
    }
    return entry.value.trim();
  };
  const number = (name: string, aliases: readonly string[], minimum: number, fallback?: number): number | undefined => {
    const entry = field(name, aliases);
    if (!entry.present) return fallback;
    if (entry.value === null) return undefined;
    const parsed = asNumber(entry.value);
    if (parsed === undefined || !Number.isInteger(parsed) || parsed < minimum) {
      throw new Error(`正典字段 ${name} 必须是至少 ${minimum} 的整数，未定时请使用 null。请重新生成。`);
    }
    return parsed;
  };
  const questions = field("openQuestions", ["待定项", "待确认问题"]);
  if (questions.present && (!Array.isArray(questions.value)
    || questions.value.some((item) => typeof item !== "string"))) {
    throw new Error("正典字段 openQuestions 必须是字符串数组。请重新生成。");
  }
  const canon: CanonDocument = {
    title: text("title", ["书名", "标题"], baseCanon?.title || "未命名") || baseCanon?.title || "未命名",
    genre: text("genre", ["题材", "类型"], baseCanon?.genre) || undefined,
    targetChapters: number("targetChapters", ["目标章数"], 1, baseCanon?.targetChapters),
    chapterWordCount: number("chapterWordCount", ["每章字数"], 100, baseCanon?.chapterWordCount),
    oneLine: text("oneLine", ["一句话故事"], baseCanon?.oneLine),
    proposition: text("proposition", ["核心命题"], baseCanon?.proposition),
    protagonist: text("protagonist", ["主角与核心欲望", "主角欲望", "主角"], baseCanon?.protagonist),
    conflict: text("conflict", ["主要冲突"], baseCanon?.conflict),
    voice: text("voice", ["叙事视角与文风", "视角与文风", "文风"], baseCanon?.voice),
    boundaries: text("boundaries", ["故事边界", "边界"], baseCanon?.boundaries),
    direction: text("direction", ["初始方向", "方向"], baseCanon?.direction),
    openQuestions: questions.present
      ? (questions.value as string[]).map((item) => item.trim()).filter(Boolean)
      : [...(baseCanon?.openQuestions ?? [])],
  };
  const hasContent = [canon.oneLine, canon.proposition, canon.protagonist, canon.conflict,
    canon.voice, canon.boundaries, canon.direction, ...canon.openQuestions]
    .some((value) => value.trim() && value.trim() !== "（待补）");
  if (suppliedFields === 0 || !hasContent) {
    throw new Error("模型未返回有效的正典内容，未保存候选稿。请重新生成。");
  }
  return canon;
}

type PreparedAskCanon = { meta: AuthoringArtifactMeta; body: string };
const preparingCanons = new Map<string, Promise<PreparedAskCanon>>();

/** Materialize an existing document as a candidate only after an explicit action. */
export async function prepareAskCanon(input: {
  readonly root: AuthoringStoreRoot;
}): Promise<PreparedAskCanon> {
  const key = authoringRootDir(input.root);
  const pending = preparingCanons.get(key);
  if (pending) return pending;
  const work = prepareExistingAskCanon(input.root);
  preparingCanons.set(key, work);
  try {
    return await work;
  } finally {
    if (preparingCanons.get(key) === work) preparingCanons.delete(key);
  }
}

async function prepareExistingAskCanon(root: AuthoringStoreRoot): Promise<PreparedAskCanon> {
  const findExisting = async () => {
    const manifest = await loadManifest(root);
    for (const id of [manifest.candidates.ask, manifest.adopted.ask]) {
      if (!id) continue;
      const artifact = await loadArtifact(root, id);
      if (!artifact) continue;
      if (artifact.meta.stage !== "ask" || artifact.meta.scope !== "canon") {
        throw new Error("正典版本记录不匹配，无法准备稿件。");
      }
      return artifact;
    }
    return undefined;
  };
  const existing = await findExisting();
  if (existing) return existing;
  const document = await loadCanonDocument(root);
  if (document.source === "compat" && (!root.bookId
    || ![document.canon.oneLine, document.canon.proposition, document.canon.boundaries].some((text) => text.trim()))) {
    throw new Error("尚无可用正典，请先根据对话整理正典。");
  }
  const body = document.path
    ? await readFile(document.path, "utf-8")
    : serializeCanon(document.canon);
  if (!body.trim()) throw new Error("尚无可用正典，请先根据对话整理正典。");
  // A regular generation may have completed while the legacy files were read.
  const completed = await findExisting();
  if (completed) return completed;
  const artifactId = newArtifactId("ask", "canon");
  const meta = await saveArtifact(root, {
    artifactId,
    stage: "ask",
    scope: "canon",
    version: 1,
    source: document.source === "compat" ? "compat" : "import",
    status: "candidate",
    bodyPath: `artifacts/${artifactId}/body.md`,
    inputRefs: [],
    createdAt: new Date().toISOString(),
    label: "正典 v1",
  }, body);
  const manifest = await loadManifest(root);
  await saveManifest(root, { ...manifest, candidates: { ...manifest.candidates, ask: artifactId } });
  return { meta, body };
}

async function persistAskRun(
  root: AuthoringStoreRoot,
  run: Omit<z.input<typeof AuthoringRunRecordSchema>, "updatedAt"> & { updatedAt?: string },
  onProgress?: (run: AuthoringRunRecord) => void,
): Promise<void> {
  await saveRun(root, { ...run, updatedAt: run.updatedAt ?? new Date().toISOString() });
  const saved = await loadRun(root, run.runId);
  if (saved) onProgress?.(saved);
}

export async function generateAskCanon(input: AskRuntime & {
  readonly conversation: string;
  readonly requirements?: string;
  /** Explicit author input only; unlike requirements, safe to retain as source. */
  readonly authorRequirement?: string;
  readonly baseCanon?: CanonDocument;
  readonly keepHandEdits?: boolean;
  readonly runId?: string;
  readonly onProgress?: (run: AuthoringRunRecord) => void;
}): Promise<{ artifactId: string; version: number; canon: CanonDocument; runId: string }> {
  const authorContext = await askAuthorContext(input.root, input.conversation, input.authorRequirement);
  const manifest = await loadManifest(input.root);
  const parentId = manifest.candidates.ask ?? manifest.adopted.ask;
  const parent = parentId ? await loadArtifact(input.root, parentId) : undefined;
  const baseCanon = input.baseCanon ?? (parent ? parseCanon(parent.body) : undefined);
  const keepHandEdits = input.keepHandEdits ?? Boolean(parent);
  const resolved = await resolve(input.project, "ask.main", input.root.projectRoot);
  const runId = input.runId ?? newRunId();
  const running = {
    runId,
    stage: "ask" as const,
    operation: "generate" as const,
    roleId: "ask.main" as const,
    status: "running" as const,
    bookId: input.root.bookId,
    draftId: input.root.draftId,
    progressLabel: "正在整理正典",
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [] as string[],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await persistAskRun(input.root, running, input.onProgress);
  const prompt = [
    "根据对话整理一份故事正典。只输出 JSON。",
    CANON_OUTPUT_INSTRUCTIONS,
    keepHandEdits ? "保留作者已手改的字段，只更新需要改的部分。" : "",
    input.requirements ? `本次整理要求（其中工作指令不自动成为故事设定）：${input.requirements}` : "",
    baseCanon ? `当前正典：\n${serializeCanon(baseCanon)}` : "",
    authorContext.prompt,
  ].filter(Boolean).join("\n");
  try {
    await throwIfRunCancelled(input.root, runId);
    const text = await completeRole(resolved, prompt, input.llm);
    await throwIfRunCancelled(input.root, runId);
    const canon = canonFromJson(extractJsonObject(text), baseCanon);
    const body = serializeCanon(canon);
    const version = (parent?.meta.version ?? 0) + 1;
    const artifactId = newArtifactId("ask", "canon");
    await saveArtifact(input.root, {
      artifactId,
      stage: "ask",
      scope: "canon",
      version,
      parentVersion: parent?.meta.version,
      parentArtifactId: parent?.meta.artifactId,
      source: "generate",
      status: "candidate",
      bodyPath: `artifacts/${artifactId}/body.md`,
      inputRefs: [],
      createdAt: new Date().toISOString(),
      runId,
      label: `正典 v${version}`,
    }, body);
    const nextManifest = await loadManifest(input.root);
    await saveManifest(input.root, {
      ...nextManifest,
      candidates: { ...nextManifest.candidates, ask: artifactId },
      lastRunId: runId,
    });
    const completed = {
      runId,
      stage: "ask" as const,
      operation: "generate" as const,
      roleId: "ask.main" as const,
      status: "completed" as const,
      bookId: input.root.bookId,
      draftId: input.root.draftId,
      progressLabel: "正典已整理",
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [artifactId],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await persistAskRun(input.root, completed, input.onProgress);
    return { artifactId, version, canon, runId };
  } catch (error) {
    if (error instanceof AuthoringRunCancelledError) {
      await persistAskRun(input.root, {
        ...running,
        status: "cancelled",
        progressLabel: "已放弃这次整理",
      }, input.onProgress);
      throw error;
    }
    const failed = {
      runId,
      stage: "ask" as const,
      operation: "generate" as const,
      roleId: "ask.main" as const,
      status: "failed" as const,
      error: error instanceof Error ? error.message : String(error),
      bookId: input.root.bookId,
      draftId: input.root.draftId,
      progressLabel: "整理正典失败",
      modelSnapshot: resolved.snapshot,
      producedArtifactIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await persistAskRun(input.root, failed, input.onProgress);
    throw error;
  }
}

export async function reviewAskCanon(input: AskRuntime & {
  readonly artifactId: string;
  readonly conversation?: string;
  readonly runId?: string;
  readonly onProgress?: (run: AuthoringRunRecord) => void;
}): Promise<AuthoringReviewReport> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  if (!loaded) throw new Error("找不到要审查的正典。");
  const authorContext = await askAuthorContext(input.root, input.conversation);
  const resolved = await resolve(input.project, "ask.review", input.root.projectRoot);
  const runId = input.runId ?? newRunId();
  const running = {
    runId,
    stage: "ask" as const,
    operation: "review" as const,
    roleId: "ask.review" as const,
    status: "running" as const,
    bookId: input.root.bookId,
    draftId: input.root.draftId,
    progressLabel: "正在审查正典",
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [] as string[],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await persistAskRun(input.root, running, input.onProgress);
  const extras = [
    authorContext.prompt,
    "核对正典是否完整整理了对话已明确的主角与核心欲望、叙事视角与文风、故事边界、初始方向；如有遗漏，请在 evidence 中引用依据，说明应补回什么。没有依据的内容应列为具体待确认问题，不要建议杜撰，也不要把作者主动待定当成缺陷。",
  ].filter(Boolean).join("\n");
  try {
  await throwIfRunCancelled(input.root, runId);
  const text = await completeRole(
    resolved,
    reviewPrompt("ask", "故事正典全文", loaded.body, extras),
    input.llm,
  );
  await throwIfRunCancelled(input.root, runId);
  const report = parseReviewPayload(text, {
    stage: "ask",
    targetRefs: [loaded.meta.artifactId],
    coverage: "故事正典全文",
    model: resolved.modelId,
    runId,
    inputRefs: [
      { kind: "artifact", id: loaded.meta.artifactId, version: loaded.meta.version },
      ...authorContext.inputRefs,
    ],
  });
  await saveReport(input.root, report);
  const completed = {
    runId,
    stage: "ask" as const,
    operation: "review" as const,
    roleId: "ask.review" as const,
    status: "completed" as const,
    reportId: report.reportId,
    bookId: input.root.bookId,
    draftId: input.root.draftId,
    progressLabel: "审查完成",
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [] as string[],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await persistAskRun(input.root, completed, input.onProgress);
  return report;
  } catch (error) {
    if (error instanceof AuthoringRunCancelledError) {
      await persistAskRun(input.root, {
        ...running,
        status: "cancelled",
        progressLabel: "已放弃这次审查",
      }, input.onProgress);
      throw error;
    }
    throw error;
  }
}

export async function reviseAskCanon(input: AskRuntime & {
  readonly artifactId: string;
  readonly reportId: string;
  readonly selectedIssueIds: readonly string[];
  readonly extraRequirement?: string;
  readonly conversation?: string;
  readonly reuseStale?: boolean;
  readonly runId?: string;
  readonly onProgress?: (run: AuthoringRunRecord) => void;
}): Promise<{ artifactId: string; version: number; canon: CanonDocument; runId: string }> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  const report = await loadReport(input.root, input.reportId);
  if (!loaded || !report) throw new Error("修订需要已有正典和审查报告。");
  assertReportReusable(report, loaded.meta.artifactId, input.reuseStale);
  const selected = report.issues.filter((issue) => input.selectedIssueIds.includes(issue.issueId));
  if (selected.length === 0) throw new Error("先选择要处理的意见。");
  const authorContext = await askAuthorContext(input.root, input.conversation, input.extraRequirement);
  const resolved = await resolve(input.project, "ask.main", input.root.projectRoot);
  const runId = input.runId ?? newRunId();
  const running = {
    runId,
    stage: "ask" as const,
    operation: "revise" as const,
    roleId: "ask.main" as const,
    status: "running" as const,
    bookId: input.root.bookId,
    draftId: input.root.draftId,
    reportId: input.reportId,
    progressLabel: "正在按意见修订正典",
    modelSnapshot: resolved.snapshot,
    producedArtifactIds: [] as string[],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await persistAskRun(input.root, running, input.onProgress);
  const prompt = [
    "按选中的审查意见更新正典。只输出 JSON。",
    CANON_OUTPUT_INSTRUCTIONS,
    `报告 ${report.reportId}，选中：`,
    JSON.stringify(selected, null, 2),
    authorContext.prompt,
    "当前正典：",
    loaded.body,
  ].filter(Boolean).join("\n");
  try {
    await throwIfRunCancelled(input.root, runId);
    const text = await completeRole(resolved, prompt, input.llm);
    await throwIfRunCancelled(input.root, runId);
    const canon = canonFromJson(extractJsonObject(text), parseCanon(loaded.body));
    const version = loaded.meta.version + 1;
    const artifactId = newArtifactId("ask", "canon");
    await saveArtifact(input.root, {
      artifactId,
      stage: "ask",
      scope: "canon",
      version,
      parentVersion: loaded.meta.version,
      parentArtifactId: loaded.meta.artifactId,
      source: "revise",
      status: "candidate",
      bodyPath: `artifacts/${artifactId}/body.md`,
      inputRefs: [{ kind: "report", id: report.reportId }],
      createdAt: new Date().toISOString(),
      label: `正典 v${version}`,
    }, serializeCanon(canon));
    const manifest = await loadManifest(input.root);
    await saveManifest(input.root, {
      ...manifest,
      candidates: { ...manifest.candidates, ask: artifactId },
    });
    const completed = {
      ...running,
      status: "completed" as const,
      progressLabel: "正典已修订",
      producedArtifactIds: [artifactId],
    };
    await persistAskRun(input.root, completed, input.onProgress);
    return { artifactId, version, canon, runId };
  } catch (error) {
    if (error instanceof AuthoringRunCancelledError) {
      await persistAskRun(input.root, {
        ...running,
        status: "cancelled",
        progressLabel: "已放弃这次修订",
      }, input.onProgress);
      throw error;
    }
    const failed = {
      ...running,
      status: "failed" as const,
      error: error instanceof Error ? error.message : String(error),
      progressLabel: "修订正典失败",
    };
    await persistAskRun(input.root, failed, input.onProgress);
    throw error;
  }
}

export async function adoptAskCanon(input: AskRuntime & {
  readonly artifactId: string;
  readonly language?: "zh" | "en";
}): Promise<{ bookId: string; created: boolean; artifactId: string; impactPending?: boolean }> {
  const loaded = await loadArtifact(input.root, input.artifactId);
  if (!loaded) throw new Error("找不到可采用的正典。");
  const canon = parseCanon(loaded.body);
  if (input.root.bookId) {
    const bookDir = join(input.root.projectRoot, "books", input.root.bookId);
    await writeFile(join(bookDir, "story", "canon.md"), loaded.body, "utf-8");
    await syncBookJsonTitle(bookDir, canon);
    const adopted = await saveArtifact(input.root, { ...loaded.meta, status: "adopted", bodyPath: "story/canon.md" }, loaded.body);
    const manifest = await loadManifest(input.root);
    const previous = manifest.adopted.ask;
    const impact = await nextCanonImpactState(input.root, manifest, previous, adopted);
    await saveManifest(input.root, {
      ...manifest,
      adopted: { ...manifest.adopted, ask: loaded.meta.artifactId },
      watches: impact.watches,
      impactBaseline: impact.impactBaseline,
    });
    return {
      bookId: input.root.bookId,
      created: false,
      artifactId: loaded.meta.artifactId,
      impactPending: impact.impactPending,
    };
  }
  if (!hasConfirmedCanonLength(canon)) {
    throw canonLengthRequiredError();
  }
  const created = await createLightweightBook({
    projectRoot: input.root.projectRoot,
    canon,
    draftId: input.root.draftId,
    language: input.language,
    fromArtifact: loaded,
  });
  return {
    bookId: created.bookId,
    created: created.created,
    artifactId: loaded.meta.artifactId,
    impactPending: created.impactPending,
  };
}
