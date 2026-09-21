/**
 * Local cover upload / replace / clear for 本书.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useRef, useState } from "react";
import { fetchJson } from "../hooks/use-api";
import {
  BOOK_COVER_ACCEPT,
  validateBookCoverFile,
} from "../lib/book-cover";
import { DefaultCover } from "./DefaultCover";

export function BookCoverEditor({
  bookId,
  title,
  coverSrc,
  isZh,
  onChanged,
}: {
  readonly bookId: string;
  readonly title: string;
  readonly coverSrc?: string;
  readonly isZh: boolean;
  readonly onChanged: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasCover = Boolean(coverSrc);

  const upload = async (file: File) => {
    const invalid = validateBookCoverFile(file, isZh);
    if (invalid) {
      setError(invalid);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      await fetchJson(`/books/${encodeURIComponent(bookId)}/cover`, { method: "POST", body });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : (isZh ? "封面未保存，请重新选择。" : "Could not save the cover. Please select it again."));
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    setPending(true);
    setError(null);
    try {
      await fetchJson(`/books/${encodeURIComponent(bookId)}/cover`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : (isZh ? "封面未能移除。" : "Could not remove the cover."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="w-[7.5rem] shrink-0 space-y-2" data-testid="study-cover">
      <DefaultCover title={title} coverSrc={coverSrc} />
      <div className="flex flex-col items-stretch gap-1">
        <button
          type="button"
          className="btn-ghost text-xs"
          data-testid="study-cover-upload"
          disabled={pending}
          onClick={() => fileRef.current?.click()}
        >
          {hasCover
            ? (isZh ? "更换封面" : "Replace cover")
            : (isZh ? "上传封面" : "Upload cover")}
        </button>
        {hasCover ? (
          <button
            type="button"
            className="btn-ghost text-xs text-muted-foreground"
            data-testid="study-cover-remove"
            disabled={pending}
            onClick={() => void remove()}
          >
            {isZh ? "移除封面" : "Remove cover"}
          </button>
        ) : null}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={BOOK_COVER_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        data-testid="study-cover-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = "";
        }}
      />
      {error ? <p className="text-xs text-destructive" role="alert" data-testid="study-cover-error">{error}</p> : null}
    </div>
  );
}
