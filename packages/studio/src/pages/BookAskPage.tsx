/**
 * 问心 page: full-page book chat.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useApi } from "../hooks/use-api";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import type { Theme } from "../hooks/use-theme";
import { AskCanonPanel } from "../components/AskCanonPanel";
import { ChatPage } from "./ChatPage";

interface Nav {
  readonly toDashboard: () => void;
  readonly toBook: (id: string) => void;
  readonly toServices: () => void;
  readonly toFilm: (projectId: string) => void;
  readonly toFilmStudio: (projectId: string) => void;
}

export function BookAskPage({
  bookId,
  nav,
  theme,
  t,
  sse,
}: {
  readonly bookId: string;
  readonly nav: Nav;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly sse: { messages: ReadonlyArray<SSEMessage>; connected: boolean };
}) {
  const { error } = useApi<{ book?: { title?: string } }>(`/books/${bookId}`);

  if (error) return <div className="text-destructive p-8">Error: {error}</div>;

  return (
    <div className="flex h-full min-h-0 flex-1">
      <ChatPage
        activeBookId={bookId}
        mode="book"
        nav={nav}
        theme={theme}
        t={t}
        sse={sse}
      />
      <AskCanonPanel bookId={bookId} isZh={t("settings.title") === "项目设置"} />
    </div>
  );
}
