/**
 * Browser-safe chapter heading cleanup. No filesystem or model calls.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export {
  collapseDuplicateChapterHeadings,
  ensureSingleChapterHeading,
  hasLeadingChapterHeading,
  parseChapterHeadingLine,
  parseChapterNumberToken,
  splitChapterHeading,
} from "./authoring/chapter-heading.js";
