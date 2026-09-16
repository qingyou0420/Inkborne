/** Internal navigation waits for the active editor's save/discard decision.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export type NavigationGuard = () => boolean | Promise<boolean>;
const guards = new Set<NavigationGuard>();
let pending = false;

export function registerNavigationGuard(guard: NavigationGuard): () => void {
  guards.add(guard);
  return () => { guards.delete(guard); };
}

export function isNavigationPending(): boolean { return pending; }

export function runGuardedNavigation(commit: () => void): Promise<boolean> {
  if (pending) return Promise.resolve(false);
  if (guards.size === 0) {
    commit();
    return Promise.resolve(true);
  }
  pending = true;
  return (async () => {
    try {
      for (const guard of Array.from(guards)) {
        if (guards.has(guard) && !await guard()) return false;
      }
      commit();
      return true;
    } catch {
      // Failed saves must leave the current editor and draft mounted.
      return false;
    } finally { pending = false; }
  })();
}
