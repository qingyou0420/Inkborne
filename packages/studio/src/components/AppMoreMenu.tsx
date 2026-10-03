/** Global settings only; work actions live beside the work.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Settings2 } from "lucide-react";
import type { SSEMessage } from "../hooks/use-sse";
import type { TFunction } from "../hooks/use-i18n";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

export interface AppMoreNav {
  toServices: () => void;
  toProjectSettings: () => void;
  toAuthor: () => void;
  toMaterials: (bookId?: string) => void;
  toMaintenance: (bookId?: string) => void;
}

export function configurationEntries(nav: AppMoreNav, isZh: boolean, bookId?: string) {
  return [
    { id: "settings-appearance", label: isZh ? "外观设置" : "Appearance", run: nav.toProjectSettings },
    { id: "nav-models", label: isZh ? "模型配置" : "Models", run: nav.toServices },
    { id: "more-author", label: isZh ? "作者信息" : "Author profile", run: nav.toAuthor },
    { id: "more-materials", label: isZh ? "导入资料" : "Import materials", run: () => nav.toMaterials(bookId) },
    { id: "more-maintenance", label: isZh ? "系统维护" : "System maintenance", run: () => nav.toMaintenance(bookId) },
  ];
}

export function AppMoreMenu({ nav, isZh, currentBookId }: {
  readonly nav: AppMoreNav;
  readonly sse: { messages: ReadonlyArray<SSEMessage> };
  readonly t: TFunction;
  readonly isZh: boolean;
  readonly currentBookId?: string;
}) {
  return <DropdownMenu>
    <DropdownMenuTrigger data-testid="nav-settings" className="ink-config-trigger" aria-label={isZh ? "配置" : "Settings"}>
      <Settings2 size={18} /><span>{isZh ? "配置" : "Settings"}</span>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="ink-config-menu w-48">
      {configurationEntries(nav, isZh, currentBookId).map((entry) => (
        <DropdownMenuItem key={entry.id} data-testid={entry.id} onClick={entry.run}>{entry.label}</DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>;
}
