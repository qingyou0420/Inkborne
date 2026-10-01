import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRODUCT_VERSION } from "../lib/product-version";

const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(studioRoot, "..", "..");

function read(rel: string): string {
  return readFileSync(join(studioRoot, rel), "utf8");
}

describe("studio product chrome branding", () => {
  it("ships BrandMark and the circular Inkborne mark, not InkOS or the old tile", () => {
    expect(existsSync(join(studioRoot, "src/components/InkosLogo.tsx"))).toBe(false);
    expect(existsSync(join(studioRoot, "src/components/FantaWriterLogo.tsx"))).toBe(false);
    expect(existsSync(join(studioRoot, "src/components/BrandMark.tsx"))).toBe(true);
    expect(existsSync(join(studioRoot, "public/inkborne-mark.png"))).toBe(true);
    expect(existsSync(join(studioRoot, "public/inkborne-mark.svg"))).toBe(true);
    const markSvg = read("public/inkborne-mark.svg");
    expect(markSvg).toMatch(/<title>墨生万象 \/ Inkborne<\/title>/);
    expect(markSvg).toMatch(/#22272d/);
    expect(markSvg).not.toMatch(/#16382a/);
    expect(existsSync(join(studioRoot, "public/fantawriter-mark.png"))).toBe(false);
    expect(existsSync(join(studioRoot, "public/favicon.ico"))).toBe(true);

    const sidebar = read("src/components/Sidebar.tsx");
    const language = read("src/pages/LanguageSelector.tsx");
    const indexHtml = read("index.html");
    const app = read("src/App.tsx");
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };

    expect(PRODUCT_VERSION).toBe(rootPkg.version);

    expect(sidebar).not.toMatch(/InkosLogo/);
    expect(sidebar).not.toMatch(/InkOS/);
    expect(sidebar).not.toMatch(/FantaWriterLogo/);
    expect(sidebar).not.toMatch(/幻想作家/);
    expect(sidebar).toMatch(/BrandMark/);
    expect(sidebar).toMatch(/sidebar-brand/);
    // PR-2：页脚文案随改名更新
    expect(sidebar).toMatch(/轻光之集 · Lightbound · v\{PRODUCT_VERSION\}/);
    expect(sidebar).toMatch(/nav\.createSection/);
    expect(sidebar.indexOf("data-testid=\"sidebar-brand\"")).toBeGreaterThan(
      sidebar.indexOf("data-testid=\"sidebar-system-list\""),
    );

    expect(language).not.toMatch(/InkOS/);
    expect(language).toMatch(/BrandMark/);
    // PR-2：欢迎页文案随改名更新
    expect(language).toMatch(/轻光之集/);
    expect(language).toMatch(/Lightbound/);

    expect(app).not.toMatch(/InkOS/);
    expect(app).toMatch(/BrandMark/);
    // PR-2：启动加载页文案随改名更新
    expect(app).toMatch(/轻光之集/);
    expect(app).not.toMatch(/幻想作家/);

    // PR-2：标题文案随改名更新
    expect(indexHtml).toMatch(/轻光之集 \/ Lightbound/);
    expect(indexHtml).not.toMatch(/InkOS/);
    expect(indexHtml).toMatch(/inkborne-mark\.png/);

    const css = read("src/index.css");
    expect(css).not.toMatch(/fonts\.googleapis\.com/);
    expect(css).toMatch(/LXGW WenKai/);
  });

  it("keeps user-facing i18n free of the old product name and cockpit label", () => {
    const i18n = read("src/hooks/use-i18n.ts");
    expect(i18n).not.toMatch(/InkOS Studio|InkOS 互动|InkOS Play/);
    expect(i18n).not.toMatch(/幻想作家|FantaWriter|驾驶舱/);
    expect(i18n).not.toMatch(/连载书房|创作书房/);
    expect(i18n).toMatch(/打开一本书进入本书/);
    // PR-2：检查更新说明随改名更新
    expect(i18n).toMatch(/轻光之集/);
    expect(i18n).toMatch(/Lightbound/);
    expect(i18n).not.toMatch(/墨生万象|Inkborne/);
  });
});
