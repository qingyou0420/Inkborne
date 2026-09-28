/**
 * Hide API keys before an upstream error is stored or shown.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const SK_KEY = /\bsk-[A-Za-z0-9_\-]{8,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ASSIGNED = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|password)\b(\s*[:=]\s*)(['"]?)[^\s'"]{8,}\3/gi;
const LONG_KEY = /\b[A-Za-z0-9_\-]{40,}\b/g;

function looksLikeSecret(token: string): boolean {
  if (token.length < 40) return false;
  return /[A-Za-z]/.test(token) && /\d/.test(token);
}

/** Replace sk- keys, bearer tokens, and other obvious key strings with 「已隐藏」. */
export function redactSecrets(text: string): string {
  return text
    .replace(SK_KEY, "已隐藏")
    .replace(BEARER, "Bearer 已隐藏")
    .replace(ASSIGNED, "$1$2已隐藏")
    .replace(LONG_KEY, (token) => (looksLikeSecret(token) ? "已隐藏" : token));
}
