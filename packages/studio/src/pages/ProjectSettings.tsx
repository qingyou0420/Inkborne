/** SPDX-License-Identifier: AGPL-3.0-only */
import { useState } from "react";
import { Globe, Palette, CircleHelp } from "lucide-react";
import { Drawer } from "../components/ui/drawer";
import {
  PROSE_LEADING_OPTIONS,
  PROSE_SIZE_OPTIONS,
  STUDIO_FONT_LABELS,
  type StudioFontId,
} from "../lib/appearance";
import { SettingsTabs } from "../components/SettingsTabs";
import { putApi, useApi } from "../hooks/use-api";
import { usePreferencesStore } from "../store/preferences";
import type { Theme } from "../hooks/use-theme";
import { useI18n, type TFunction } from "../hooks/use-i18n";

interface Nav {
  toDashboard: () => void;
  toServices: () => void;
  toProjectSettings?: (section?: "advanced") => void;
}

function SettingsCard({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <section className="border-b border-border pb-8 space-y-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-muted-foreground" aria-hidden="true">{icon}</span>
        <h2 className="text-base font-medium">{title}</h2>
        <button type="button" className="ml-auto rounded p-1 text-muted-foreground hover:text-foreground" aria-label={`${title} · ?`} onClick={() => setHelpOpen(true)}><CircleHelp size={17} /></button>
      </div>
      {children}
      <Drawer open={helpOpen} onClose={() => setHelpOpen(false)} title={title}>
        <p className="text-sm leading-7 text-muted-foreground">{description}</p>
      </Drawer>
    </section>
  );
}

export function ProjectSettings({ nav, theme, t, setTheme }: {
  nav: Nav;
  theme: Theme;
  t: TFunction;
  setTheme?: (next: Theme) => void;
  /** Older settings links resolve to appearance without exposing retired panels. */
  section?: "advanced";
}) {
  const { lang } = useI18n();
  const isZh = lang !== "en";
  const { data: projectData, loading, error, refetch: refetchProject } = useApi<{ language?: string }>("/project");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const uiFont = usePreferencesStore((s) => s.uiFont);
  const proseFont = usePreferencesStore((s) => s.proseFont);
  const proseSize = usePreferencesStore((s) => s.proseSize);
  const proseLeading = usePreferencesStore((s) => s.proseLeading);
  const showStudioImage = usePreferencesStore((s) => s.showStudioImage);
  const paperTone = usePreferencesStore((s) => s.paperTone);
  const setAppearance = usePreferencesStore((s) => s.setAppearance);

  const saveLanguage = async (language: "zh" | "en") => {
    if (saving || loading || error || !projectData) return;
    setSaving(true);
    setNotice(null);
    try {
      await putApi("/project", { language });
      await refetchProject();
      setNotice({ tone: "success", message: t("settings.saved") });
    } catch (e) {
      setNotice({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-layout">
      <SettingsTabs
        active="appearance"
        t={t}
        onModels={nav.toServices}
        onAppearance={() => nav.toProjectSettings?.()}
      />
      <div className="space-y-8 min-w-0">
        <h1 className="text-[32px] font-medium leading-10">{isZh ? "外观设置" : "Appearance"}</h1>
        {notice && (
          <div role={notice.tone === "error" ? "alert" : "status"} className="ink-notice text-sm" data-tone={notice.tone === "error" ? "danger" : undefined}>
            {notice.message}
          </div>
        )}
      <SettingsCard title={t("settings.appearance")} description={t("settings.appearanceHint")} icon={<Palette size={18} />}>
      <div id="settings-appearance" />
        <div className="setting-row flex items-center justify-between gap-4 border-b border-border py-4">
          <span className="text-sm">{isZh ? "日间纸色" : "Day paper"}</span>
          <div className="segmented" aria-label={isZh ? "日间纸色" : "Day paper"}>
            {(["white", "warm", "mist"] as const).map((tone) => <button key={tone} type="button" className={paperTone === tone ? "active" : ""} aria-pressed={paperTone === tone} onClick={() => setAppearance({ paperTone: tone })}>{isZh ? {white:"素白",warm:"暖纸",mist:"雾灰"}[tone] : {white:"White",warm:"Warm",mist:"Mist"}[tone]}</button>)}
          </div>
        </div>
        <div className="setting-row flex items-center justify-between gap-4 border-b border-border py-4">
          <div>
            <label className="text-sm">{t("settings.theme")}</label>
          </div>
          <div className="segmented" data-testid="settings-theme">
            {(["light", "dark"] as const).map((item) => (
              <button
                key={item}
                type="button"
                className={theme === item ? "active" : ""}
                aria-pressed={theme === item}
                onClick={() => setTheme?.(item)}
              >
                {item === "light" ? t("settings.themeLight") : t("settings.themeDark")}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row flex items-center justify-between gap-4 border-b border-border py-4">
          <div>
            <label className="text-sm">{t("settings.uiFont")}</label>
          </div>
          <div className="segmented" data-testid="settings-ui-font">
            {(Object.keys(STUDIO_FONT_LABELS) as StudioFontId[]).map((id) => (
              <button
                key={id}
                type="button"
                className={uiFont === id ? "active" : ""}
                aria-pressed={uiFont === id}
                onClick={() => setAppearance({ uiFont: id })}
              >
                {isZh ? STUDIO_FONT_LABELS[id].zh : STUDIO_FONT_LABELS[id].en}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row flex items-center justify-between gap-4 border-b border-border py-4">
          <div>
            <label className="text-sm">{t("settings.proseFont")}</label>
          </div>
          <div className="segmented" data-testid="settings-prose-font">
            {(Object.keys(STUDIO_FONT_LABELS) as StudioFontId[]).map((id) => (
              <button
                key={id}
                type="button"
                className={proseFont === id ? "active" : ""}
                aria-pressed={proseFont === id}
                onClick={() => setAppearance({ proseFont: id })}
              >
                {isZh ? STUDIO_FONT_LABELS[id].zh : STUDIO_FONT_LABELS[id].en}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row flex items-center justify-between gap-4 border-b border-border py-4">
          <div>
            <label className="text-sm">{t("settings.proseSize")}</label>
          </div>
          <div className="segmented" data-testid="settings-prose-size">
            {PROSE_SIZE_OPTIONS.map((size) => (
              <button
                key={size}
                type="button"
                className={proseSize === size ? "active" : ""}
                aria-pressed={proseSize === size}
                onClick={() => setAppearance({ proseSize: size })}
              >
                {size}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row flex items-center justify-between gap-4 border-b border-border py-4">
          <div>
            <label className="text-sm">{t("settings.proseLeading")}</label>
          </div>
          <div className="segmented" data-testid="settings-prose-leading">
            {PROSE_LEADING_OPTIONS.map((leading) => (
              <button
                key={leading}
                type="button"
                className={proseLeading === leading ? "active" : ""}
                aria-pressed={proseLeading === leading}
                onClick={() => setAppearance({ proseLeading: leading })}
              >
                {leading.toFixed(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row flex items-center justify-between gap-4 border-b border-border py-4">
          <div>
            <label className="text-sm">{isZh ? "留白中的水墨点缀" : "Ink ornament"}</label>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={isZh ? "留白中的水墨点缀" : "Ink ornament"}
            aria-checked={showStudioImage}
            data-testid="settings-studio-image"
            onClick={() => setAppearance({ showStudioImage: !showStudioImage })}
            className={`relative h-[25px] w-[43px] shrink-0 rounded-full ${showStudioImage ? "bg-seal" : "bg-border-strong"}`}
          >
            <span className={`absolute top-[3px] left-[3px] h-[19px] w-[19px] rounded-full bg-background transition-transform ${showStudioImage ? "translate-x-[18px]" : ""}`} />
          </button>
        </div>
        <div className="font-specimen" data-testid="settings-font-specimen">
          <h3>{t("settings.fontSpecimenTitle")}</h3>
          <p>{t("settings.fontSpecimenBody")}</p>
        </div>
      </SettingsCard>
        <SettingsCard title={t("settings.writingLanguage")} description={t("settings.writingLanguageHint")} icon={<Globe size={18} />}>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
              <button type="button" className="btn-ghost ml-2" disabled={loading} onClick={() => void refetchProject()}>{isZh ? "重新读取" : "Retry"}</button>
            </p>
          ) : loading ? <p role="status" className="text-sm text-muted-foreground">{isZh ? "正在读取创作语言…" : "Loading writing language…"}</p> : null}
          <div className="segmented" data-testid="settings-writing-language" aria-label={t("settings.writingLanguage")}>
            {(["zh", "en"] as const).map((language) => {
              const selected = Boolean(projectData && !loading && !error) && (projectData?.language === "en" ? "en" : "zh") === language;
              return (
                <button
                  key={language}
                  type="button"
                  disabled={saving || loading || Boolean(error) || !projectData}
                  aria-pressed={selected}
                  className={selected ? "active" : ""}
                  onClick={() => void saveLanguage(language)}
                >
                  {language === "zh" ? t("config.chinese") : t("config.english")}
                </button>
              );
            })}
          </div>
        </SettingsCard>
      </div>
    </div>
  );
}
