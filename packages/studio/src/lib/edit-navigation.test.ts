import { afterEach, describe, expect, it, vi } from "vitest";
import { isNavigationPending, registerNavigationGuard, runGuardedNavigation } from "./edit-navigation";
import { navigateWithGuard, type HashRoute } from "../hooks/use-hash-route";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const guard = (callback: () => boolean | Promise<boolean>) => { const cleanup = registerNavigationGuard(callback); cleanups.push(cleanup); return cleanup; };

describe("editor navigation", () => {
  it("keeps the current page mounted until the save decision resolves and ignores repeated navigation", async () => {
    let finish!: (accepted: boolean) => void;
    const prompt = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    guard(prompt);
    const firstCommit = vi.fn();
    const duplicateCommit = vi.fn();
    const first = runGuardedNavigation(firstCommit);
    expect(isNavigationPending()).toBe(true);
    expect(firstCommit).not.toHaveBeenCalled();
    expect(await runGuardedNavigation(duplicateCommit)).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
    finish(true);
    expect(await first).toBe(true);
    expect(firstCommit).toHaveBeenCalledTimes(1);
    expect(duplicateCommit).not.toHaveBeenCalled();
    expect(isNavigationPending()).toBe(false);
  });
  it("keeps the editor after continue editing or save failure, allowing a later retry", async () => {
    const decision = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce(true);
    guard(decision);
    const commit = vi.fn();
    expect(await runGuardedNavigation(commit)).toBe(false);
    expect(await runGuardedNavigation(commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(await runGuardedNavigation(commit)).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it("does not let an earlier saved editor bypass another dirty document", async () => {
    guard(() => true);
    guard(() => false);
    const commit = vi.fn();
    expect(await runGuardedNavigation(commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });
  it("removes stale guards and keeps ordinary navigation synchronous", async () => {
    const removed = vi.fn(() => false);
    guard(removed)();
    const commit = vi.fn();
    const task = runGuardedNavigation(commit);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
    expect(await task).toBe(true);
  });
  it("keeps the active session and typed message intact when switching creative mode is declined", async () => {
    guard(() => false);
    const state = { session: "ask-session", input: "尚未发送的想法" };
    const commit = vi.fn();
    const result = await navigateWithGuard({ page: "book-ask", bookId: "book" }, { page: "chat" }, commit, () => {
      state.session = "short-session";
      state.input = "";
    });
    expect(result).toBe(false);
    expect(state).toEqual({ session: "ask-session", input: "尚未发送的想法" });
    expect(commit).not.toHaveBeenCalled();
  });
  it("creates the target session only after approval, before committing the route, with no nested guard", async () => {
    let approve!: (accepted: boolean) => void;
    const check = vi.fn(() => new Promise<boolean>((resolve) => { approve = resolve; }));
    guard(check);
    const events: string[] = [];
    const current: HashRoute = { page: "book-ask", bookId: "book" };
    const next: HashRoute = { page: "chat" };
    const task = navigateWithGuard(current, next, () => events.push("route"), () => events.push("session"));
    expect(events).toEqual([]);
    expect(await navigateWithGuard(current, next, () => events.push("duplicate-route"), () => events.push("duplicate-session"))).toBe(false);
    approve(true);
    expect(await task).toBe(true);
    expect(events).toEqual(["session", "route"]);
    expect(check).toHaveBeenCalledTimes(1);
  });
  it("can switch sessions on the same chat route but still honors the active editor guard", async () => {
    const decide = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    guard(decide);
    const mutation = vi.fn();
    const commit = vi.fn();
    expect(await navigateWithGuard({ page: "chat" }, { page: "chat" }, commit, mutation)).toBe(false);
    expect(mutation).not.toHaveBeenCalled();
    expect(await navigateWithGuard({ page: "chat" }, { page: "chat" }, commit, mutation)).toBe(true);
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
