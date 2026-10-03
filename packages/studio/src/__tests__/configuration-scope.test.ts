/** SPDX-License-Identifier: AGPL-3.0-only */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { configurationEntries } from "../components/AppMoreMenu";
import { NewWorkPage } from "../pages/NewWorkPage";
import { QuickActions } from "../components/chat/QuickActions";

describe("configuration product scope", () => {
  it("has exactly the five approved destinations and preserves the current book", () => {
    const nav = { toProjectSettings: vi.fn(), toServices: vi.fn(), toAuthor: vi.fn(), toMaterials: vi.fn(), toMaintenance: vi.fn() };
    const items = configurationEntries(nav, true, "潮声未寄");
    expect(items.map((item) => item.label)).toEqual(["外观设置", "模型配置", "作者信息", "导入资料", "系统维护"]);
    items.forEach((item) => item.run());
    expect(nav.toProjectSettings).toHaveBeenCalledOnce();
    expect(nav.toServices).toHaveBeenCalledOnce();
    expect(nav.toAuthor).toHaveBeenCalledOnce();
    expect(nav.toMaterials).toHaveBeenCalledWith("潮声未寄");
    expect(nav.toMaintenance).toHaveBeenCalledWith("潮声未寄");
  });
  it("offers both novel and short story creation outside configuration", () => {
    const html = renderToStaticMarkup(createElement(NewWorkPage, { isZh: true, onNovel: vi.fn(), onShort: vi.fn() }));
    expect(html).toContain("新建作品");
    expect(html).toContain("开始短篇");
    expect(html).toContain("进入问心");
    expect(html).not.toMatch(/同人|番外|仿写|影视/);
  });
  it("does not suggest retired market scanning in chat", () => {
    const html = renderToStaticMarkup(createElement(QuickActions, { isZh: true, disabled: false, onAction: vi.fn() }));
    expect(html).not.toContain("市场雷达");
    expect(html).toContain("导出");
  });
});
