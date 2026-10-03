/**
 * Settings left nav: 外观设置 / 模型配置.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useI18n, type TFunction } from "../hooks/use-i18n";

export function SettingsTabs({
  active,
  t,
  onModels,
  onAppearance,
}: {
  readonly active: "models" | "appearance" | "advanced";
  readonly t: TFunction;
  readonly onModels: () => void;
  readonly onAppearance: () => void;
  readonly onAdvanced?: () => void;
}) {
  const { lang } = useI18n();
  const current = active === "advanced" ? "appearance" : active;
  const tabs = [
    { id: "appearance" as const, label: lang === "en" ? "Appearance" : "外观设置", onClick: onAppearance },
    { id: "models" as const, label: t("settings.modelsTab"), onClick: onModels },
  ];
  return (
    <nav className="settings-tabs" aria-label={t("settings.title")}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={current === tab.id ? "active" : ""}
          aria-current={current === tab.id ? "page" : undefined}
          onClick={tab.onClick}
          disabled={!tab.onClick}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
