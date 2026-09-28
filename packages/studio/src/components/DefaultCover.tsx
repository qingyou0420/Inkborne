/**
 * Default bookshelf cover: uploaded image, or a title-only 3:4 placeholder.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useState } from "react";

export function DefaultCover({
  title,
  coverSrc,
}: {
  readonly title: string;
  readonly coverSrc?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (coverSrc && failedSrc !== coverSrc) {
    return (
      <img
        src={coverSrc}
        alt={title}
        className="aspect-[3/4] w-full rounded-md border border-border/50 object-cover"
        onError={() => setFailedSrc(coverSrc)}
      />
    );
  }
  return (
    <div
      className="flex aspect-[3/4] w-full items-start rounded-md border border-border/60 bg-secondary/40 px-2 py-2"
      data-testid="default-cover"
    >
      <div className="font-serif text-[13px] leading-5 text-foreground line-clamp-3">{title}</div>
    </div>
  );
}
