/**
 * S08/S09: eight independent authoring roles.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useState } from "react";
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

export function AuthoringRolesPanel({ isZh }: { readonly isZh: boolean }) {
  const { data, refetch } = useApi<RolesResponse>("/authoring/roles");
  const [editing, setEditing] = useState<AuthoringRoleId | null>(null);
  const [draft, setDraft] = useState<RoleConfig>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const roles = data?.roles ?? {};

  const open = (roleId: AuthoringRoleId) => {
    setEditing(roleId);
    setDraft(roles[roleId] ?? {});
    setTestResult(null);
  };

  const payload = () => ({
    ...draft,
    apiFormat: draft.apiFormat === "chat" || draft.apiFormat === "responses" ? draft.apiFormat : null,
  });

  const testCurrent = async () => {
    if (!editing) return;
    setTesting(true);
    try {
      const result = await postApi<{ ok: boolean; error?: string; modelId?: string; serviceRef?: string }>(
        `/authoring/roles/${editing}/test`,
        payload(),
      );
      setTestResult(result.ok
        ? (isZh ? `通过 · ${result.modelId ?? ""} @ ${result.serviceRef ?? ""}` : `OK · ${result.modelId ?? ""} @ ${result.serviceRef ?? ""}`)
        : (result.error || (isZh ? "测试失败" : "Failed")));
    } catch (error) {
      setTestResult(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await putApi(`/authoring/roles/${editing}`, payload());
      await refetch();
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const fillMissing = async () => {
    await postApi("/authoring/roles/fill-missing", {});
    await refetch();
  };

  const title = editing && data?.meta[editing]
    ? (isZh ? data.meta[editing]!.zh : data.meta[editing]!.en)
    : "";

  return (
    <section className="space-y-4 rounded-2xl border border-border/50 bg-card/70 p-5 shadow-sm">
      <div>
        <h2 className="font-serif text-lg">{isZh ? "四步八角色" : "Eight authoring roles"}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {isZh
            ? "每一步的创作与审查分开保存。可以共用连接，改一个角色不会改另外七个。"
            : "Main and review for each stage are saved separately. Shared connections do not couple roles."}
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {STAGES.map((stage) => {
          const main = `${stage.id}.main` as AuthoringRoleId;
          const review = `${stage.id}.review` as AuthoringRoleId;
          return (
            <div key={stage.id} className="space-y-2 rounded-xl border border-border/60 bg-secondary/20 p-3">
              <div className="text-sm font-semibold">{isZh ? stage.zh : stage.en}</div>
              <RoleCard isZh={isZh} kind="main" role={roles[main]} onEdit={() => open(main)} />
              <RoleCard isZh={isZh} kind="review" role={roles[review]} onEdit={() => open(review)} />
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => void fillMissing()}
        className="rounded-lg border border-border px-3 py-2 text-sm"
      >
        {isZh ? "从现有配置填充缺失项" : "Fill missing from current config"}
      </button>

      <Drawer open={Boolean(editing)} title={title} onClose={() => setEditing(null)}>
        <div className="space-y-3">
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
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-[9px] font-mono"
              value={draft.modelId ?? ""}
              onChange={(event) => setDraft((prev) => ({ ...prev, modelId: event.target.value }))}
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
          {testResult ? <p className="text-sm text-muted-foreground">{testResult}</p> : null}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button type="button" className="rounded-lg px-3 py-2 text-sm" onClick={() => setEditing(null)}>
              {isZh ? "取消" : "Cancel"}
            </button>
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
              disabled={testing}
              onClick={() => void testCurrent()}
            >
              {testing ? (isZh ? "测试中…" : "Testing…") : (isZh ? "测试此配置" : "Test this config")}
            </button>
            <button
              type="button"
              className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? (isZh ? "保存中…" : "Saving") : (isZh ? "保存配置" : "Save")}
            </button>
          </div>
        </div>
      </Drawer>
    </section>
  );
}

function RoleCard({
  isZh,
  kind,
  role,
  onEdit,
}: {
  readonly isZh: boolean;
  readonly kind: "main" | "review";
  readonly role?: RoleConfig;
  readonly onEdit: () => void;
}) {
  const label = kind === "main" ? (isZh ? "创作" : "Main") : (isZh ? "审查" : "Review");
  return (
    <button
      type="button"
      onClick={onEdit}
      className="flex w-full items-start justify-between rounded-lg bg-background/70 px-3 py-2 text-left"
    >
      <div>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="font-mono text-sm">{role?.modelId || (isZh ? "未配置" : "Unset")}</div>
      </div>
      <span className="text-xs text-muted-foreground">{role?.serviceRef}</span>
    </button>
  );
}
