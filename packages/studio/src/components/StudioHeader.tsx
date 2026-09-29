/**
 * Global chrome: one way home and one configuration entry.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import { AppMoreMenu, type AppMoreNav } from "./AppMoreMenu";
import { BrandGlyph } from "./BrandGlyph";

export interface StudioHeaderNav extends AppMoreNav {
  toDashboard: () => void;
  toServices: () => void;
  toProjectSettings: () => void;
}

export function StudioHeader({
  nav,
  t,
  isZh,
  sse,
  currentBookId,
}: {
  readonly nav: StudioHeaderNav;
  readonly t: TFunction;
  readonly isZh: boolean;
  readonly isDark: boolean;
  readonly onToggleTheme: () => void;
  readonly studyCurrent: boolean;
  readonly sse: { messages: ReadonlyArray<SSEMessage> };
  readonly currentBookId?: string;
}) {
  return (
    <header className="studio-chrome-header shrink-0 border-b border-border">
      <div className="header-inner">
        <button
          type="button"
          className="brand"
          onClick={nav.toDashboard}
          aria-label={isZh ? "墨生万象，回到书架" : "Inkborne, back to the bookshelf"}
        >
          <BrandGlyph className="brand-mark-svg" />
          <span className="brand-name">墨生万象</span>
        </button>
        <div className="header-actions">
          <AppMoreMenu
            nav={nav}
            sse={sse}
            t={t}
            isZh={isZh}
            currentBookId={currentBookId}
          />
        </div>
      </div>
    </header>
  );
}
