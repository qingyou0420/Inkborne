/**
 * Shared manuscript typography. Uses the existing appearance preference store.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { usePreferencesStore } from "../store/preferences";
import { PROSE_LEADING_OPTIONS, PROSE_SIZE_OPTIONS, STUDIO_FONT_LABELS, STUDIO_FONT_STACKS, type StudioFontId } from "../lib/appearance";
import { Drawer } from "./ui/drawer";
import "./write-workspace.css";

export function ReadingAppearanceDrawer({ open, onClose, isZh }: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly isZh: boolean;
}) {
  const proseFont = usePreferencesStore((state) => state.proseFont);
  const proseSize = usePreferencesStore((state) => state.proseSize);
  const proseLeading = usePreferencesStore((state) => state.proseLeading);
  const setAppearance = usePreferencesStore((state) => state.setAppearance);

  return (
    <Drawer open={open} title={isZh ? "正文排版" : "Manuscript appearance"} onClose={onClose} testId="reading-appearance-drawer">
      <div className="reading-appearance-controls">
        <fieldset>
          <legend>{isZh ? "字体" : "Typeface"}</legend>
          <div className="reading-font-options">
            {(Object.keys(STUDIO_FONT_LABELS) as StudioFontId[]).map((font) => (
              <label key={font} className={proseFont === font ? "selected" : ""}>
                <input type="radio" name="manuscript-font" value={font} checked={proseFont === font} onChange={() => setAppearance({ proseFont: font })} />
                <span style={{ fontFamily: STUDIO_FONT_STACKS[font] }}>{isZh ? STUDIO_FONT_LABELS[font].zh : STUDIO_FONT_LABELS[font].en}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>{isZh ? "字号" : "Text size"}</legend>
          <div className="reading-number-options">
            {PROSE_SIZE_OPTIONS.map((size) => (
              <label key={size} className={proseSize === size ? "selected" : ""}>
                <input type="radio" name="manuscript-size" checked={proseSize === size} onChange={() => setAppearance({ proseSize: size })} />
                <span>{size}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>{isZh ? "行距" : "Line spacing"}</legend>
          <div className="reading-number-options">
            {PROSE_LEADING_OPTIONS.map((leading) => (
              <label key={leading} className={proseLeading === leading ? "selected" : ""}>
                <input type="radio" name="manuscript-leading" checked={proseLeading === leading} onChange={() => setAppearance({ proseLeading: leading })} />
                <span>{leading.toFixed(1)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="reading-appearance-sample prose-body" style={{ fontFamily: STUDIO_FONT_STACKS[proseFont], fontSize: proseSize, lineHeight: proseLeading }}>
          {isZh ? "雨在傍晚停了。窗外的树影落进屋里，一页故事还没有写完。" : "The rain stopped at dusk. Shadows of the trees fell across the room. One page of the story remained unwritten."}
        </p>
        <p className="text-sm text-muted-foreground">{isZh ? "已同步到正文编辑与阅读页。" : "Applied to the manuscript editor and reader."}</p>
      </div>
    </Drawer>
  );
}
