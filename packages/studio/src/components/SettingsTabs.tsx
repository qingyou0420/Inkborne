/**
 * Settings left nav: 模型配置 / 外观与字体 / 高级.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { TFunction } from "../hooks/use-i18n";

export function SettingsTabs({
  active,
  t,
  onModels,
  onAppearance,
  onAdvanced,
}: {
  readonly active: "models" | "appearance" | "advanced";
  readonly t: TFunction;
  readonly onModels: () => void;
  readonly onAppearance: () => void;
  readonly onAdvanced?: () => void;
}) {
  const tabs = [
    { id: "models" as const, label: t("settings.modelsTab"), onClick: onModels },
    { id: "appearance" as const, label: t("settings.appearanceTab"), onClick: onAppearance },
    { id: "advanced" as const, label: t("settings.advancedTab"), onClick: onAdvanced },
  ];
  return (
    <nav className="settings-tabs" aria-label={t("settings.title")}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={active === tab.id ? "active" : ""}
          aria-current={active === tab.id ? "page" : undefined}
          onClick={tab.onClick}
          disabled={!tab.onClick}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
