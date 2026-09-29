import { useState } from "react";
import { BrandMark } from "../components/BrandMark";

export function LanguageSelector({ onSelect }: { onSelect: (lang: "zh" | "en") => void }) {
  const [hovering, setHovering] = useState<"zh" | "en" | null>(null);
  const [selected, setSelected] = useState<"zh" | "en" | null>(null);

  const handleSelect = (lang: "zh" | "en") => {
    setSelected(lang);
    // Brief pause for the selection animation before transitioning
    setTimeout(() => onSelect(lang), 400);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-8">
      <div className="mb-16 text-center">
        <BrandMark className="w-24 h-24 mx-auto mb-5 rounded-full" />
        <div className="font-serif text-5xl font-medium text-foreground">墨生万象</div>
        <div className="mt-2 text-base text-muted-foreground tracking-[0.18em]">Inkborne</div>
      </div>

      {/* Language cards — generous, distinct, immersive */}
      <div className="flex gap-8 mb-16">
        <button
          onClick={() => handleSelect("zh")}
          onMouseEnter={() => setHovering("zh")}
          onMouseLeave={() => setHovering(null)}
          className={`group w-80 border rounded-lg p-10 text-left transition-all duration-300 ${
            selected === "zh"
              ? "border-primary bg-primary/10 scale-[1.02]"
              : hovering === "zh"
                ? "border-primary/50 bg-card"
                : "border-border bg-card/50"
          }`}
        >
          <div className="font-serif text-3xl mb-4 text-foreground">中文创作</div>
          <div className="text-base text-foreground/70 leading-relaxed mb-6">
            玄幻 · 仙侠 · 都市 · 恐怖 · 通用
          </div>
          <div className="text-sm text-muted-foreground">
            番茄小说 · 起点中文网 · 飞卢
          </div>
        </button>

        <button
          onClick={() => handleSelect("en")}
          onMouseEnter={() => setHovering("en")}
          onMouseLeave={() => setHovering(null)}
          className={`group w-80 border rounded-lg p-10 text-left transition-all duration-300 ${
            selected === "en"
              ? "border-primary bg-primary/10 scale-[1.02]"
              : hovering === "en"
                ? "border-primary/50 bg-card"
                : "border-border bg-card/50"
          }`}
        >
          <div className="font-serif text-3xl italic mb-4 text-foreground">English Writing</div>
          <div className="text-base text-foreground/70 leading-relaxed mb-6">
            LitRPG · Progression · Romantasy · Sci-Fi · Isekai
          </div>
          <div className="text-sm text-muted-foreground">
            Royal Road · Kindle Unlimited · Scribble Hub
          </div>
        </button>
      </div>

      <div className="text-sm text-muted-foreground">
        可在「配置 → 创作语言」中更改 · Change later in Configuration → Writing language
      </div>
    </div>
  );
}
