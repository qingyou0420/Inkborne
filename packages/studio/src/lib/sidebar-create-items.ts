/** Visible entries in the Studio left-sidebar create block. Other modes stay implemented, just hidden. */
export const SIDEBAR_CREATE_ITEM_KEYS = ["nav.createNovel", "nav.createShort"] as const;

export type SidebarCreateItemKey = (typeof SIDEBAR_CREATE_ITEM_KEYS)[number];

/**
 * Left-nav section order: author chip → create → 问心记录 → tools → system.
 * Menu buttons in create / tools / system use a 2-column CreateItem grid.
 * 问心记录 stays a full-width expandable list (titles + relative time do not fit two columns).
 */
export const SIDEBAR_SECTION_ORDER = ["author", "create", "sessions", "tools", "system"] as const;

export type SidebarSectionId = (typeof SIDEBAR_SECTION_ORDER)[number];

/** Tools list: 文风学习 / 题材模板. Import, doctor, radar stay implemented but hidden. */
export const SIDEBAR_TOOL_ITEM_KEYS = ["nav.style", "nav.genreTemplates"] as const;

export type SidebarToolItemKey = (typeof SIDEBAR_TOOL_ITEM_KEYS)[number];

/**
 * System settings (2-column grid): 模型配置 / 项目设置 / 资料设置 / 自动模式 / 实时动态 / 检查更新.
 * `nav.logs` still routes to `#/logs`. `nav.authorProfile` still routes to `#/author`.
 */
export const SIDEBAR_SYSTEM_ITEM_KEYS = [
  "nav.config",
  "nav.projectSettings",
  "nav.authorProfile",
  "nav.daemon",
  "nav.logs",
  "nav.checkUpdate",
] as const;

export type SidebarSystemItemKey = (typeof SIDEBAR_SYSTEM_ITEM_KEYS)[number];
