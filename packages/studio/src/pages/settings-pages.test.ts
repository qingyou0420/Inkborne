/** SPDX-License-Identifier: AGPL-3.0-only */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSettings } from "./ProjectSettings";
import { ServiceListPage } from "./ServiceListPage";
import { SettingsTabs } from "../components/SettingsTabs";

const state = vi.hoisted(() => ({
  reads: [] as string[],
  projectLoading: false,
  projectError: null as string | null,
}));

vi.mock("../hooks/use-i18n", () => ({
  useI18n: () => ({ lang: "zh", t: (key: string) => key }),
}));
vi.mock("../hooks/use-api", () => ({
  fetchJson: vi.fn(),
  putApi: vi.fn(),
  postApi: vi.fn(),
  useApi: (path: string) => {
    state.reads.push(path);
    const base = { loading: false, error: null, refetch: async () => {} };
    if (path === "/project") return {
      ...base, data: { language: "en" }, loading: state.projectLoading, error: state.projectError,
    };
    if (path === "/authoring/roles") return {
      ...base,
      data: {
        roles: Object.fromEntries(["ask", "ground", "weave", "write"].flatMap((stage) =>
          ["main", "review"].map((kind) => [`${stage}.${kind}`, { modelId: `${stage}-${kind}-saved`, serviceRef: "saved-connection" }]),
        )),
        meta: {},
      },
    };
    return { ...base, data: null };
  },
}));
vi.mock("../store/service", () => ({
  useServiceStore: (selector: (value: unknown) => unknown) => selector({
    services: [], servicesLoading: false, fetchServices: () => {}, refreshServices: () => {},
  }),
}));

const noop = () => {};
const t = (key: string) => key;
const appearanceProps: ComponentProps<typeof ProjectSettings> = {
  nav: { toDashboard: noop, toServices: noop, toProjectSettings: noop },
  theme: "light", t, setTheme: noop,
};

beforeEach(() => {
  state.reads = [];
  state.projectLoading = false;
  state.projectError = null;
});

describe("focused appearance and model settings", () => {
  it("keeps appearance and writing language reachable from old advanced links without reading retired settings", () => {
    const html = renderToStaticMarkup(createElement(ProjectSettings, { ...appearanceProps, section: "advanced" }));
    expect(html).toContain("外观设置");
    for (const control of ["settings-theme", "settings-ui-font", "settings-prose-font", "settings-prose-size", "settings-prose-leading", "settings-studio-image", "settings-writing-language"]) {
      expect(html).toContain(`data-testid="${control}"`);
    }
    expect(html).toContain("日间纸色");
    expect(html).not.toContain("settings-advanced");
    expect(state.reads).toEqual(["/project"]);
  });

  it("does not present a retained language as current while its settings are loading or failed", () => {
    for (const mode of ["loading", "error"]) {
      state.projectLoading = mode === "loading";
      state.projectError = mode === "error" ? "读取失败" : null;
      const html = renderToStaticMarkup(createElement(ProjectSettings, appearanceProps));
      const language = html.split('data-testid="settings-writing-language"')[1]!.split("</section>")[0]!;
      expect(language.match(/disabled=""/g)).toHaveLength(2);
      expect(language).not.toContain('aria-pressed="true"');
      expect(html).toContain(mode === "loading" ? "正在读取创作语言" : "读取失败");
    }
  });

  it("renders all eight saved roles before collapsed connections, with no bulk model editor", () => {
    const html = renderToStaticMarkup(createElement(ServiceListPage, {
      nav: { toDashboard: noop, toServiceDetail: noop, toProjectSettings: noop },
    }));
    for (const stage of ["ask", "ground", "weave", "write"]) {
      for (const kind of ["main", "review"]) expect(html).toContain(`${stage}-${kind}-saved`);
    }
    expect(html.indexOf('data-testid="authoring-roles-panel"')).toBeLessThan(html.indexOf('data-testid="model-connections"'));
    expect(html).toMatch(/<details[^>]*data-testid="model-connections"[^>]*>/);
    expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/);
    expect(html).toContain("短篇封面生成");
    expect(html).not.toContain("model-price-per-million");
    expect(html).not.toContain("主力模型");
    expect(state.reads).toEqual(["/authoring/roles"]);
  });

  it("offers exactly appearance and models while retaining the advanced-route alias", () => {
    const html = renderToStaticMarkup(createElement(SettingsTabs, {
      active: "advanced", t, onModels: noop, onAppearance: noop, onAdvanced: noop,
    }));
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain('aria-current="page">外观设置</button>');
    expect(html).not.toContain("settings.advancedTab");
  });
});
