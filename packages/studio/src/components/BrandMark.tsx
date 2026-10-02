// 星芒图标：深海军蓝底、四芒星、细轨道线、金点。
// PNG is served from packages/studio/public/lightbound-mark.png.

export function BrandMark({ className }: { readonly className?: string }) {
  return (
    <img
      src="/lightbound-mark.png"
      alt="轻光之集"
      className={className}
      draggable={false}
    />
  );
}
