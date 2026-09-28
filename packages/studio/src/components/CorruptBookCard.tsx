/**
 * A shelf card for a book whose book.json could not be read.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function CorruptBookCard({
  message,
  snapshotPath,
  testId = "corrupt-book-card",
  onOpen,
}: {
  readonly message: string;
  readonly snapshotPath?: string | null;
  readonly testId?: string;
  readonly onOpen?: () => void;
}) {
  const body = (
    <>
      <p className="text-sm font-medium text-foreground">这本书打不开</p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground whitespace-pre-wrap">{message}</p>
      {snapshotPath ? (
        <p className="mt-2 break-all font-mono text-xs text-muted-foreground" data-testid="corrupt-book-snapshot">
          快照：{snapshotPath}
        </p>
      ) : null}
    </>
  );
  const className = "w-full rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-left";
  if (!onOpen) {
    return <div className={className} data-testid={testId}>{body}</div>;
  }
  return (
    <button type="button" className={className} data-testid={testId} onClick={onOpen}>
      {body}
    </button>
  );
}
