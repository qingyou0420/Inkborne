// 墨生万象 / Inkborne circular mark: open book, mountain path, gold star.
// PNG is served from packages/studio/public/inkborne-mark.png.

export function BrandMark({ className }: { readonly className?: string }) {
  return (
    <img
      src="/inkborne-mark.png"
      alt="轻光之集"
      className={className}
      draggable={false}
    />
  );
}
