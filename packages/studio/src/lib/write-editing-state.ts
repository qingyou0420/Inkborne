/** SPDX-License-Identifier: AGPL-3.0-only */

/** A produced candidate returns to reading; a miss keeps the mode from before the stream. */
export function editingAfterStream(input: {
  readonly wasEditing: boolean;
  readonly artifactProduced: boolean;
}): boolean {
  if (input.artifactProduced) return false;
  return input.wasEditing;
}
