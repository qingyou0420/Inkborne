/**
 * S08/S09: eight independent authoring roles.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { postApi, putApi, useApi } from "../hooks/use-api";
import { Drawer } from "./ui/drawer";
import type { AuthoringRoleId } from "../lib/authoring-roles";

interface RoleConfig {
  readonly serviceRef?: string;
  readonly modelId?: string;
  readonly stream?: boolean;
  readonly temperature?: number;
  readonly apiFormat?: "chat" | "responses";
  readonly instructions?: string;
  readonly lastTestStatus?: string;
}

interface RolesResponse {
  readonly roles: Record<string, RoleConfig>;
  readonly meta: Record<string, { zh: string; en: string; stage: string; kind: string }>;
}

const STAGES = [
  { id: "ask", zh: "问心", en: "Ask" },
  { id: "ground", zh: "研墨", en: "Ground" },
  { id: "weave", zh: "织卷", en: "Weave" },
  { id: "write", zh: "落笔", en: "Write" },
] as const;

export function AuthoringRolesPanel({
  isZh,
  startRole,
  compact,
  onEditorClose,
}: {
  readonly isZh: boolean;
  readonly startRole?: AuthoringRoleId | null;
  readonly compact?: boolean;
  readonly onEditorClose?: () => void;
}) {
  const { data, loading, error, refetch } = useApi<RolesResponse>("/authoring/roles");
  const [editing, setEditing] = useState<AuthoringRoleId | null>(null);
  const [draft, setDraft] = useState<RoleConfig>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [filling, setFilling] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testFailed, setTestFailed] = useState(false);
  const initializedRole = useRef<AuthoringRoleId | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const startRoleRef = useRef(startRole);
  startRoleRef.current = startRole;
  const busy = saving || testing || filling;
  const ready = Boolean(data && !loading && !error);
  const roles = data?.roles ?? {};
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setTestResult(null); setTestFailed(false); setSaveError(null); }, [draft]);

  const open = (roleId: AuthoringRoleId) => {
    if (!ready || busyRef.current) return;
    setEditing(roleId);
    setDraft(roles[roleId] ?? {});
    setTestResult(null);
    setSaveError(null);
  };

  useEffect(() => {
    if (!startRole) { initializedRole.current = null; return; }
    if (!ready || busyRef.current || initializedRole.current === startRole) return;
    initializedRole.current = startRole;
    setEditing(startRole);
    setDraft((data?.roles ?? {})[startRole] ?? {});
    setTestResult(null);
    setSaveError(null);
  }, [startRole, data, ready, busy]);

  const payload = () => ({
    ...draft,
    apiFormat: draft.apiFormat === "chat" || draft.apiFormat === "responses" ? draft.apiFormat : null,
  });

  const testCurrent = async () => {
    if (!editing || !ready || busyRef.current) return;
    const requestedRole = startRole;
    busyRef.current = true;
    setTesting(true);
    setTestResult(null);
    setTestFailed(false);
    try {
      const result = await postApi<{ ok: boolean; error?: string; modelId?: string; serviceRef?: string }>(
        `/authoring/roles/${editing}/test`,
        payload(),
      );
      if (!mounted.current || startRoleRef.current !== requestedRole) return;
      setTestFailed(!result.ok);
      setTestResult(result.ok
        ? (isZh ? `通过 · ${result.modelId ?? ""} @ ${result.serviceRef ?? ""}` : `OK · ${result.modelId ?? ""} @ ${result.serviceRef ?? ""}`)
        : (result.error || (isZh ? "测试失败" : "Failed")));
    } catch (error) {
      if (!mounted.current || startRoleRef.current !== requestedRole) return;
      setTestFailed(true);
      setTestResult(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      if (mounted.current) setTesting(false);
    }
  };

  const save = async () => {
    if (!editing || !ready || busyRef.current) return;
    const requestedRole = startRole;
    busyRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await putApi(`/authoring/roles/${editing}`, payload());
      await refetch();
      if (!mounted.current || startRoleRef.current !== requestedRole) return;
      setEditing(null);
      onEditorClose?.();
    } catch (error) {
      if (mounted.current && startRoleRef.current === requestedRole) setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const fillMissing = async () => {
    if (!ready || busyRef.current) return;
    busyRef.current = true;
    setFilling(true);
    setSaveError(null);
    try {
      await postApi("/authoring/roles/fill-missing", {});
      await refetch();
    } catch (error) {
      if (mounted.current) setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      if (mounted.current) setFilling(false);
    }
  };

  const title = editing && data?.meta[editing]
    ? (isZh ? data.meta[editing]!.zh : data.meta[editing]!.en)
    : (isZh ? "模型配置" : "Model configuration");

  const closeEditor = () => {
    if (busyRef.current) return;
    setEditing(null);
    setSaveError(null);
    onEditorClose?.();
  };

  return (
    <section className={compact ? "" : "space-y-5"} data-testid="authoring-roles-panel">
      {!compact && (error || saveError) ? <p role="alert" className="text-sm text-destructive">{saveError || error}<button type="button" className="btn-ghost ml-2" disabled={loading || busy} onClick={() => void refetch()}>{isZh ? "重新读取" : "Retry"}</button></p> : null}
      {compact ? null : (
        <>
          <div>
            <h2 className="text-[23px] font-medium">{isZh ? "四位执笔者，四位审读者。" : "Four writers, four readers."}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {isZh
                ? "每一步的创作与审查分开保存。可以共用连接，改一个角色不会改另外七个。"
                : "Main and review for each stage are saved separately. Shared connections do not couple roles."}
            </p>
          </div>
          <div className="role-grid">
            <div>
              {STAGES.map((stage) => {
                const main = `${stage.id}.main` as AuthoringRoleId;
                return (
                  <RoleSlot
                    key={main}
                    glyph={(isZh ? stage.zh : stage.en).slice(0, 1)}
                    title={isZh ? `${stage.zh} · 创作` : `${stage.en} · Write`}
                    role={roles[main]}
                    kind="main"
                    isZh={isZh}
                    onEdit={() => open(main)}
                  />
                );
              })}
            </div>
            <div>
              {STAGES.map((stage) => {
                const review = `${stage.id}.review` as AuthoringRoleId;
                return (
                  <RoleSlot
                    key={review}
                    glyph={(isZh ? stage.zh : stage.en).slice(0, 1)}
                    title={isZh ? `${stage.zh} · 审查` : `${stage.en} · Review`}
                    role={roles[review]}
                    kind="review"
                    isZh={isZh}
                    onEdit={() => open(review)}
                  />
                );
              })}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void fillMissing()}
            disabled={busy || !ready}
            className="btn-ghost"
          >
            {isZh ? "从现有配置填充缺失项" : "Fill missing from current config"}
          </button>
        </>
      )}

      <Drawer open={Boolean(editing || startRole)} title={title} onClose={closeEditor}>
        {error || !data ? <p role={error ? "alert" : "status"} className="text-sm">{error || (isZh ? "正在读取模型配置…" : "Loading model configuration…")}{error ? <button type="button" className="btn-ghost ml-2" disabled={loading || busy} onClick={() => void refetch()}>{isZh ? "重试" : "Retry"}</button> : null}</p> : null}
        {saveError ? <RoleConfigError message={saveError} operation="save" serviceRef={draft.serviceRef} isZh={isZh} /> : null}
        <fieldset disabled={busy || !ready || !editing} className="space-y-3">
          <label className="block text-sm">
            {isZh ? "服务连接" : "Service"}
            <input
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-[9px]"
              value={draft.serviceRef ?? ""}
              onChange={(event) => setDraft((prev) => {
                const next = { ...prev, serviceRef: event.target.value };
                delete next.apiFormat;
                return next;
              })}
            />
          </label>
          <label className="block text-sm">
            {isZh ? "接口协议" : "API format"}
            <select
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-[9px]"
              value={draft.apiFormat ?? "inherit"}
              onChange={(event) => {
                const value = event.target.value;
                setDraft((prev) => {
                  if (value === "chat" || value === "responses") return { ...prev, apiFormat: value };
                  const next = { ...prev };
                  delete next.apiFormat;
                  return next;
                });
              }}
            >
              <option value="inherit">{isZh ? "继承连接" : "Inherit connection"}</option>
              <option value="chat">Chat Completions</option>
              <option value="responses">Responses</option>
            </select>
          </label>
          <label className="block text-sm">
            {isZh ? "模型" : "Model"}
            <input
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-[9px] font-mono break-all"
              value={draft.modelId ?? ""}
              onChange={(event) => setDraft((prev) => ({ ...prev, modelId: event.target.value }))}
            />
          </label>
          <label className="block text-sm">
            {isZh ? "温度" : "Temperature"}
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-[9px]"
              value={draft.temperature ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setDraft((prev) => ({
                  ...prev,
                  temperature: value === "" ? undefined : Number(value),
                }));
              }}
            />
          </label>
          <label className="block text-sm">
            {isZh ? "角色说明" : "Instructions"}
            <textarea
              className="mt-1 min-h-[140px] w-full rounded-md border border-border bg-background px-3 py-2"
              value={draft.instructions ?? ""}
              onChange={(event) => setDraft((prev) => ({ ...prev, instructions: event.target.value }))}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.stream !== false}
              onChange={(event) => setDraft((prev) => ({ ...prev, stream: event.target.checked }))}
            />
            {isZh ? "流式输出" : "Streaming"}
          </label>
          {testResult ? testFailed
            ? <RoleConfigError message={testResult} operation="test" serviceRef={draft.serviceRef} isZh={isZh} />
            : <p role="status" className="text-sm text-muted-foreground">{testResult}</p>
            : null}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button type="button" className="rounded-lg px-3 py-2 text-sm" onClick={closeEditor}>
              {isZh ? "取消" : "Cancel"}
            </button>
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
              disabled={busy || !ready}
              onClick={() => void testCurrent()}
            >
              {testing ? (isZh ? "测试中…" : "Testing…") : (isZh ? "测试此配置" : "Test this config")}
            </button>
            <button
              type="button"
              className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
              disabled={busy || !ready}
              onClick={() => void save()}
            >
              {saving ? (isZh ? "保存中…" : "Saving") : (isZh ? "保存配置" : "Save")}
            </button>
          </div>
        </fieldset>
      </Drawer>
    </section>
  );
}

function RoleConfigError({ message, operation, serviceRef, isZh }: {
  readonly message: string;
  readonly operation: "save" | "test";
  readonly serviceRef?: string;
  readonly isZh: boolean;
}) {
  // Compatible connections may report the protocol provider (e.g. openai),
  // which is not necessarily the service the user selected.
  const missingKey = /no api key\b|missing api[-_ ]?key|api[-_ ]?key.*(?:missing|required|not (?:set|configured))/i.test(message);
  const connection = serviceRef?.trim();
  const summary = missingKey
    ? (isZh
      ? `${connection ? `连接「${connection}」` : "当前连接"}缺少 API Key。请在「模型配置」中打开该连接，补全 API Key 后重试。`
      : `${connection ? `Connection “${connection}”` : "The selected connection"} has no API key. Open it in Model Config, add its API key, then retry.`)
    : (isZh
      ? `${operation === "save" ? "配置未保存" : "测试未通过"}。请检查服务连接与模型配置后重试，具体原因可查看错误详情。`
      : `${operation === "save" ? "Configuration was not saved" : "The test failed"}. Check the connection and model configuration, then retry. See error details for the reported cause.`);
  return (
    <div role="alert" className="text-sm text-destructive">
      <p>{summary}</p>
      <details className="mt-2">
        <summary className="cursor-pointer">{isZh ? "错误详情" : "Error details"}</summary>
        <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-xs">{message}</pre>
      </details>
    </div>
  );
}

function RoleSlot({
  glyph,
  title,
  role,
  kind,
  isZh,
  onEdit,
}: {
  readonly glyph: string;
  readonly title: string;
  readonly role?: RoleConfig;
  readonly kind: "main" | "review";
  readonly isZh: boolean;
  readonly onEdit: () => void;
}) {
  const model = role?.modelId?.trim()
    || (kind === "main" ? (isZh ? "未配置创作模型" : "Writing model unset") : (isZh ? "未配置审查模型" : "Review model unset"));
  return (
    <button type="button" onClick={onEdit} className="role-slot">
      <span className="role-glyph">{glyph}</span>
      <span className="min-w-0">
        <strong>{title}</strong>
        <small>{model}{role?.serviceRef ? ` · ${role.serviceRef}` : ""}</small>
      </span>
      <ChevronRight size={16} className="role-chevron" />
    </button>
  );
}
