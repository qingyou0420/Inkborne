/**
 * Default model settings: connection row + main/review model row.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useState } from "react";
import { fetchJson, putApi } from "../hooks/use-api";
import { tr } from "../lib/app-language";
import { AUTHORING_ROLE_ORDER } from "../lib/authoring-roles";
import { probeServiceForDetail } from "../pages/service-detail-state";

interface ServiceEntry {
  readonly service?: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly pricePerMillion?: number;
}

interface ServicesConfig {
  readonly service?: string | null;
  readonly defaultModel?: string | null;
  readonly services?: ReadonlyArray<ServiceEntry>;
}

interface SecretView {
  readonly configured?: boolean;
  readonly last4?: string;
  readonly apiKey?: string;
  readonly locationHint?: string;
}

interface RolesResponse {
  readonly roles?: Record<string, { modelId?: string; serviceRef?: string }>;
}

function serviceIdOf(entry: ServiceEntry): string {
  if (entry.service === "custom") return `custom:${entry.name ?? "自定义"}`;
  return entry.service ?? "";
}

function pickConnection(config: ServicesConfig): { id: string; baseUrl: string; name: string } {
  const services = config.services ?? [];
  const current = config.service?.trim() ?? "";
  const named = services.find((entry) => serviceIdOf(entry) === current);
  if (named) {
    return {
      id: current,
      baseUrl: named.baseUrl ?? "",
      name: named.service === "custom" ? (named.name ?? current) : current,
    };
  }
  const custom = services.find((entry) => entry.service === "custom" && entry.name);
  if (custom) {
    return { id: serviceIdOf(custom), baseUrl: custom.baseUrl ?? "", name: custom.name ?? "自定义" };
  }
  return { id: "custom:自定义", baseUrl: "", name: "自定义" };
}

export function SimpleModelSettings() {
  const [serviceId, setServiceId] = useState("custom:自定义");
  const [serviceName, setServiceName] = useState("自定义");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [last4, setLast4] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [mainModel, setMainModel] = useState("");
  const [reviewModel, setReviewModel] = useState("");
  const [pricePerMillion, setPricePerMillion] = useState("");
  const [hadPrice, setHadPrice] = useState(false);
  const [hint, setHint] = useState("密钥只存在本机用户数据目录（与应用配置、日志放在一起），不会放进书稿文件夹。");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await fetchJson<ServicesConfig>("/services/config");
        if (cancelled) return;
        const picked = pickConnection(config);
        setServiceId(picked.id);
        setServiceName(picked.name);
        setBaseUrl(picked.baseUrl);
        const roles = await fetchJson<RolesResponse>("/authoring/roles");
        if (cancelled) return;
        const main = roles.roles?.["write.main"]?.modelId || config.defaultModel || "";
        const review = roles.roles?.["write.review"]?.modelId || main;
        setMainModel(main);
        setReviewModel(review);
        const priced = (config.services ?? []).find((entry) => typeof entry.pricePerMillion === "number" && entry.pricePerMillion > 0);
        if (priced?.pricePerMillion) {
          setPricePerMillion(String(priced.pricePerMillion));
          setHadPrice(true);
        }
        const secret = await fetchJson<SecretView>(`/services/${encodeURIComponent(picked.id)}/secret`);
        if (cancelled) return;
        setConfigured(Boolean(secret.configured) || Boolean(secret.apiKey));
        setLast4(secret.last4 || (secret.apiKey ? secret.apiKey.slice(-4) : ""));
        if (secret.locationHint) setHint(secret.locationHint);
      } catch {
        /* 空项目也能先填这两行 */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const revealKey = async () => {
    if (showKey) {
      setShowKey(false);
      return;
    }
    if (!apiKey && configured) {
      const secret = await fetchJson<SecretView>(`/services/${encodeURIComponent(serviceId)}/secret?reveal=1`);
      setApiKey(secret.apiKey ?? "");
      setLast4(secret.last4 || secret.apiKey?.slice(-4) || last4);
    }
    setShowKey(true);
  };

  const testConnection = async () => {
    if (!baseUrl.trim() && serviceId.startsWith("custom:")) {
      setStatus(tr("请先填写接口地址", "Enter the API address first"));
      return;
    }
    setBusy(true);
    setStatus(tr("正在测试连接…", "Testing connection…"));
    try {
      const result = await probeServiceForDetail(serviceId, {
        apiKey: apiKey.trim(),
        apiFormat: "chat",
        stream: true,
        ...(serviceId.startsWith("custom:") ? { baseUrl: baseUrl.trim() } : {}),
      });
      if (!result.ok) {
        setStatus(result.error || tr("连接失败", "Connection failed"));
        return;
      }
      const detected = result.selectedModel || result.models?.[0]?.id || "";
      if (detected && !mainModel.trim()) setMainModel(detected);
      if (detected && !reviewModel.trim()) setReviewModel(detected);
      setStatus(tr(`连接成功${detected ? `，看到模型 ${detected}` : ""}`, `Connected${detected ? `, saw ${detected}` : ""}`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : tr("连接失败", "Connection failed"));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const nextMain = mainModel.trim();
    const nextReview = reviewModel.trim() || nextMain;
    if (!nextMain) {
      setStatus(tr("请填写主力模型", "Enter the main model"));
      return;
    }
    if (serviceId.startsWith("custom:") && !baseUrl.trim()) {
      setStatus(tr("请先填写接口地址", "Enter the API address first"));
      return;
    }
    const price = Number(pricePerMillion.trim());
    const savedPrice = pricePerMillion.trim() && Number.isFinite(price) && price > 0 ? price : 0;
    setBusy(true);
    setStatus(tr("正在保存…", "Saving…"));
    try {
      const typedKey = apiKey.trim();
      if (typedKey) {
        await putApi(`/services/${encodeURIComponent(serviceId)}/secret`, { apiKey: typedKey });
        setConfigured(true);
        setLast4(typedKey.slice(-4));
      }
      if (serviceId.startsWith("custom:") || savedPrice > 0 || hadPrice) {
        await putApi("/services/config", {
          service: serviceId,
          defaultModel: nextMain,
          services: [{
            service: serviceId.startsWith("custom:") ? "custom" : serviceId,
            ...(serviceId.startsWith("custom:") ? {
              name: serviceName || "自定义",
              baseUrl: baseUrl.trim(),
              models: [nextMain, nextReview].filter((model, index, list) => model && list.indexOf(model) === index),
            } : {}),
            pricePerMillion: savedPrice,
          }],
        });
      }
      await putApi("/project/default-model", { service: serviceId, defaultModel: nextMain });
      for (const roleId of AUTHORING_ROLE_ORDER) {
        const modelId = roleId.endsWith(".review") ? nextReview : nextMain;
        await putApi(`/authoring/roles/${roleId}`, { serviceRef: serviceId, modelId });
      }
      setMainModel(nextMain);
      setReviewModel(nextReview);
      setStatus(tr("已保存。八个角色都用这两行；要单独改某一步，打开项目设置里的高级。", "Saved. All eight roles use these two rows."));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : tr("保存失败", "Save failed"));
    } finally {
      setBusy(false);
    }
  };

  const keyPlaceholder = configured
    ? tr(`已保存，末四位 ${last4 || "····"}`, `Saved, last 4 ${last4 || "····"}`)
    : "sk-...";

  return (
    <section className="space-y-4 rounded-2xl border border-border/50 bg-card/70 p-5">
      <div>
        <h2 className="text-base font-bold">{tr("连接和模型", "Connection and models")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
      </div>
      <div className="grid gap-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto]">
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={tr("接口地址，例如 https://api.deepseek.com/v1", "API address")}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono"
        />
        <div className="relative">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={keyPlaceholder}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-16 text-sm font-mono"
          />
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
            onClick={() => void revealKey()}
          >
            {showKey ? tr("隐藏", "Hide") : tr("显示一次", "Show once")}
          </button>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void testConnection()}
          className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
        >
          {tr("测试", "Test")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
        >
          {tr("保存", "Save")}
        </button>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>{tr("主力模型", "Main model")}</span>
          <input
            value={mainModel}
            onChange={(event) => setMainModel(event.target.value)}
            placeholder="deepseek-v4-pro"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span>{tr("审查模型", "Review model")}</span>
          <input
            value={reviewModel}
            onChange={(event) => setReviewModel(event.target.value)}
            placeholder={tr("留空则和主力模型相同", "Leave blank to use the main model")}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span>{tr("估算单价（元 / 百万 token，可留空）", "Estimate (yuan / million tokens, optional)")}</span>
          <input
            value={pricePerMillion}
            onChange={(event) => setPricePerMillion(event.target.value)}
            inputMode="decimal"
            placeholder={tr("例如 2，只用来估算，不计费", "e.g. 2, estimate only")}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono"
            data-testid="model-price-per-million"
          />
        </label>
      </div>
      {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
    </section>
  );
}
