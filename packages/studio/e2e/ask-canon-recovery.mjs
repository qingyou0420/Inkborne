/** Isolated real-React regression: no InkOS server or model requests.
 * Run: node packages/studio/e2e/ask-canon-recovery.mjs
 * Optional: --baseline renders the committed component to reproduce the bug.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium, expect } from "@playwright/test";
import { directLucide } from "../build/lucide-direct.mjs";

const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(studio, "../..");
const output = resolve(root, process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) || "迭代与审查/问心正典按钮修复-2026-09-17");
const baseline = process.argv.includes("--baseline");
const body = '---\ntitle: "回归测试书"\ngenre: "古风"\ntargetChapters: 30\nchapterWordCount: 3000\n---\n\n# 故事正典\n\n原始正典正文保持完整。\n';
const artifact = (id = "ask-prepared", version = 1) => ({ artifactId: id, stage: "ask", scope: "canon", version, status: "candidate" });
const fixture = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { AskCanonPanel } from '/src/components/AskCanonPanel.tsx';
import { useChatStore } from '/src/store/chat/index.ts';
const draft = new URLSearchParams(location.search).get('draft') === '1';
useChatStore.setState({activeSessionId:'test-session',sessions:{'test-session':{
  sessionId:'test-session',bookId:draft ? null : 'fixture-book',sessionKind:draft ? 'book-create' : 'book',
  messages:[{role:'user',content:'写一个关于归乡的古风故事。',timestamp:1}],
  isStreaming:false,isChatStreaming:false
}}});
createRoot(document.getElementById('root')).render(<AskCanonPanel bookId={draft ? undefined : 'fixture-book'} isZh />);`;
const html = `<html lang="zh"><head><meta charset="utf-8"><style>
body{margin:0;padding:30px;background:white;color:#222;font:16px sans-serif}
#root{max-width:1100px;margin:auto}.ask-canon-editor{min-height:700px;width:100%;height:85vh}
[hidden]{display:none!important}button{min-height:34px}button:disabled{opacity:.4}textarea{min-height:250px}
</style></head><body><main id="root"></main><script type="module" src="/__canon_fixture.tsx"></script></body></html>`;
const baselineSource = baseline ? execFileSync("git", ["show", "HEAD:packages/studio/src/components/AskCanonPanel.tsx"], { cwd: root, encoding: "utf8" }) : null;
const server = await createServer({
  configFile: false, root: studio, logLevel: "error",
  plugins: [{
    name: "isolated-canon-fixture",
    resolveId(id) { if (id === "/__canon_fixture.tsx") return resolve(studio, "__canon_fixture.tsx"); },
    load(id) {
      if (id.replaceAll("\\", "/") === resolve(studio, "__canon_fixture.tsx").replaceAll("\\", "/")) return fixture;
      if (baselineSource && id.replaceAll("\\", "/").endsWith("/src/components/AskCanonPanel.tsx")) return baselineSource;
    },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith("/__canon_regression.html")) return next();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(await vite.transformIndexHtml(req.url, html));
    }); },
  }, react(), directLucide()],
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  resolve: { alias: { "@": resolve(studio, "src") } },
});
await server.listen();
const address = server.httpServer.address();
const origin = `http://127.0.0.1:${address.port}`;
const installedBrowser = [process.env.INKBORNE_TEST_BROWSER, "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((path) => path && existsSync(path));
const browser = await chromium.launch({ executablePath: installedBrowser, headless: true });
const results = [];

async function runCase(name, options, check) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const calls = [], unexpected = [], errors = [];
  let preparations = 0;
  let workspace = {
    canon: { title: "回归测试书", oneLine: "原始正典正文保持完整。" }, canonSource: options.candidate ? "canon" : "compat",
    reports: [], artifacts: [],
  };
  function setCandidate(id = "ask-prepared", content = body, version = 1) {
    workspace.candidateAsk = { ...artifact(id, version), body: content };
    workspace.artifacts.push(artifact(id, version));
  }
  if (options.candidate) setCandidate("ask-existing");
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(request.url()); await route.abort(); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    const path = url.pathname.replace("/api/v1", ""), method = request.method();
    let payload = null;
    try { payload = request.postDataJSON(); } catch { /* no body */ }
    if (method !== "GET") calls.push({ path, method, payload });
    const respond = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path === "/authoring/workspace" && method === "GET") return respond(workspace);
    if (path === "/authoring/drafts/ensure" && method === "POST") return respond({ draftId: "fixture-draft" });
    if (path === "/authoring/ask/prepare" && method === "POST") {
      preparations++;
      if (options.failPrepareOnce && preparations === 1) return respond({ error: "读取旧正典失败：测试故障" }, 500);
      setCandidate();
      return respond({ meta: artifact(), body });
    }
    if (path === "/authoring/ask/generate" && method === "POST") {
      setCandidate("ask-generated"); return respond({ artifactId: "ask-generated" });
    }
    if (path.startsWith("/authoring/artifacts/") && method === "PUT") {
      assert.equal(path, `/authoring/artifacts/${workspace.candidateAsk.artifactId}`);
      setCandidate("ask-edited", payload.body, 2); return respond({ artifactId: "ask-edited" });
    }
    if (path === "/authoring/ask/review" && method === "POST") {
      assert.equal(payload.artifactId, workspace.candidateAsk?.artifactId);
      workspace.reports = [{ reportId: "review-fixture", stage: "ask", coverage: "故事正典", actualReviewModel: "mock-independent-review", summary: "测试审查完成，原始正典保持完整。", targetRefs: [payload.artifactId], issues: options.revise ? [{ issueId: "missing-voice", title: "补回视角", severity: "improve", suggestion: "对照作者对话补回已确认的叙述方式。" }] : [] }];
      return respond(workspace.reports[0]);
    }
    if (path === "/authoring/ask/revise" && method === "POST") {
      assert.equal(payload.conversation, "user: 写一个关于归乡的古风故事。");
      assert.deepEqual(payload.selectedIssueIds, ["missing-voice"]);
      assert.equal(payload.reportId, "review-fixture");
      assert.match(payload.requirements, /保留作者的开放结局/);
      setCandidate("ask-revised", body + "\n补回了作者确认的视角。", 2);
      return respond({ artifactId: "ask-revised" });
    }
    if (path === "/authoring/ask/adopt" && method === "POST") {
      assert.equal(payload.artifactId, workspace.candidateAsk?.artifactId);
      workspace.adoptedAskId = payload.artifactId; return respond({ bookId: "fixture-book", message: "正典已采用" });
    }
    unexpected.push(`${method} ${path}`); return respond({ error: "Unexpected mocked endpoint" }, 404);
  });
  const started = Date.now();
  try {
    await page.goto(`${origin}/__canon_regression.html?draft=${options.draft ? "1" : "0"}`);
    await check({ page, calls, workspace: () => workspace });
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    results.push({ name, passed: true, durationMs: Date.now() - started, mutations: calls.map(({ path, method }) => `${method} ${path}`) });
    console.log(`PASS ${name}`);
  } catch (error) {
    mkdirSync(output, { recursive: true });
    await page.screenshot({ path: resolve(output, `${baseline ? "baseline" : "fixed"}-${name}.png`), fullPage: true }).catch(() => {});
    results.push({ name, passed: false, durationMs: Date.now() - started, error: String(error), unexpected, pageErrors: errors, mutations: calls.map(({ path, method }) => `${method} ${path}`) });
    console.error(`FAIL ${name}: ${String(error).slice(0, 400)}`);
  } finally { await context.close(); }
}

async function allActionsEnabled(page) {
  for (const name of ["编辑", "审查", "采用"]) await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
}
async function assertEdit({ page, calls, workspace }) {
  await allActionsEnabled(page);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "书名", exact: true })).toHaveValue("回归测试书");
  await expect(page.getByTestId("ask-candidate-body")).toHaveValue(/原始正典正文保持完整/);
  await page.getByRole("textbox", { name: "书名", exact: true }).fill("修改后的测试书");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await allActionsEnabled(page);
  assert.match(workspace().candidateAsk.body, /修改后的测试书/);
  assert.match(workspace().candidateAsk.body, /原始正典正文保持完整/);
  assert.equal(workspace().adoptedAskId, undefined, "Editing must not adopt");
  assert.equal(calls.filter((call) => call.path === "/authoring/ask/adopt").length, 0);
}
async function assertReview({ page, calls, workspace }) {
  await allActionsEnabled(page);
  await page.getByRole("button", { name: "审查", exact: true }).click();
  await expect(page.getByText("测试审查完成，原始正典保持完整。", { exact: true })).toBeVisible();
  assert.equal(workspace().adoptedAskId, undefined, "Review must not adopt");
  assert.equal(calls.filter((call) => call.path === "/authoring/ask/review").length, 1);
}
async function assertAdopt({ page, calls, workspace }) {
  await allActionsEnabled(page);
  await page.getByRole("button", { name: "采用", exact: true }).click();
  await expect(page.getByRole("button", { name: "已采用", exact: true })).toBeDisabled();
  assert.equal(workspace().adoptedAskId, workspace().candidateAsk.artifactId);
  assert.equal(calls.filter((call) => call.path === "/authoring/ask/adopt").length, 1);
}

try {
  for (const [action, check] of [["edit", assertEdit], ["review", assertReview], ["adopt", assertAdopt]]) {
    await runCase(`legacy-${action}`, {}, async (state) => {
      await check(state);
      assert.equal(state.calls[0]?.path, "/authoring/ask/prepare");
      assert.equal(state.calls.filter((call) => call.path === "/authoring/ask/prepare").length, 1);
    });
  }
  await runCase("prepare-failure-retry", { failPrepareOnce: true }, async (state) => {
    await allActionsEnabled(state.page);
    await state.page.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(state.page.getByRole("alert")).toContainText("读取旧正典失败");
    await allActionsEnabled(state.page);
    await assertEdit(state);
    assert.equal(state.calls.filter((call) => call.path === "/authoring/ask/prepare").length, 2);
  });
  for (const [action, check] of [["edit", assertEdit], ["review", assertReview], ["adopt", assertAdopt]]) {
    await runCase(`existing-${action}`, { candidate: true }, async (state) => {
      await check(state);
      assert.equal(state.calls.filter((call) => call.path === "/authoring/ask/prepare").length, 0);
    });
  }
  await runCase("empty-draft-generate", { draft: true }, async ({ page, calls }) => {
    await expect(page.getByRole("button", { name: "整理正典", exact: true })).toBeEnabled();
    for (const name of ["编辑", "审查", "采用"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "整理正典", exact: true }).click();
    await allActionsEnabled(page);
    assert.equal(calls.filter((call) => call.path === "/authoring/ask/prepare").length, 0);
    assert.equal(calls.filter((call) => call.path === "/authoring/ask/generate").length, 1);
  });
  await runCase("revision-retains-conversation", { candidate: true, revise: true }, async (state) => {
    await assertReview(state);
    await state.page.getByRole("button", { name: "全选", exact: true }).click();
    await state.page.getByRole("button", { name: "按 1 条意见修改", exact: true }).click();
    await state.page.getByRole("textbox", { name: "保留内容", exact: true }).fill("保留作者的开放结局");
    await state.page.getByRole("button", { name: "生成新候选", exact: true }).click();
    await expect(state.page.getByText("补回了作者确认的视角。", { exact: false })).toBeVisible();
    assert.equal(state.calls.filter((call) => call.path === "/authoring/ask/revise").length, 1);
    assert.equal(state.workspace().adoptedAskId, undefined);
  });
} finally {
  await browser.close(); await server.close();
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, `${baseline ? "baseline" : "fixed"}-react-regression.json`), JSON.stringify({ baseline, browser: installedBrowser ?? "playwright Chromium", passed: results.filter((result) => result.passed).length, total: results.length, results }, null, 2));
}
console.log(`${results.filter((result) => result.passed).length}/${results.length} real React browser cases passed (${baseline ? "baseline" : "current source"}).`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
