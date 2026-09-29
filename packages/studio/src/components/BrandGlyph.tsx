/**
 * Geometric book-page mark used in the top chrome. Matches the ONE preview glyph.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function BrandGlyph({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <path d="M6 7h11c5 0 9 4 9 9v17H15a9 9 0 0 1-9-9V7Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M14 7v17a9 9 0 0 0 9 9h11V16a9 9 0 0 0-9-9H14Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M14 16h12" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
