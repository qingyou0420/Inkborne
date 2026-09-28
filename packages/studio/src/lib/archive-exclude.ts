/**
 * Paths that must not ride along in a project/export archive.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function isExcludedFromProjectArchive(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.endsWith("/")) return false;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (base === ".DS_Store") return true;
  if (base === ".env") return true;
  if (normalized === ".inkos/secrets.json" || normalized.endsWith("/.inkos/secrets.json")) return true;
  if (base === "secrets.json" || base === "research-search.json") return true;
  return false;
}
