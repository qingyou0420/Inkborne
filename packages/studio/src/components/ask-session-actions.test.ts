/** SPDX-License-Identifier: AGPL-3.0-only */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { ChatStore } from "../store/chat/types";
import { initialChatState } from "../store/chat/initialState";
import { createCreateSlice } from "../store/chat/slices/create/action";
import { createMessageSlice } from "../store/chat/slices/message/action";

const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock("../hooks/use-api", () => ({ fetchJson }));

function createTestStore() {
  return createStore<ChatStore>()((...args) => ({
    ...initialChatState,
    ...createMessageSlice(...args),
    ...createCreateSlice(...args),
  }));
}

function seed(store: ReturnType<typeof createTestStore>, bookId: string | null, title: string) {
  const id = store.getState().createDraftSession(bookId, bookId ? "book" : "book-create");
  store.setState((state) => ({
    sessions: { ...state.sessions, [id]: { ...state.sessions[id]!, title, isDraft: false } },
    sessionIdsByBook: { ...state.sessionIdsByBook, [bookId ?? "__null__"]: [...(state.sessionIdsByBook[bookId ?? "__null__"] ?? []), id] },
  }));
  return id;
}

describe("Ask record operations", () => {
  beforeEach(() => { fetchJson.mockReset(); });

  it("reports list failure without replacing an existing list with an empty result", async () => {
    const store = createTestStore();
    const id = seed(store, "a", "已有会话");
    fetchJson.mockRejectedValue(new Error("offline"));
    await expect(store.getState().loadSessionList("a", true)).rejects.toThrow("offline");
    expect(store.getState().sessionIdsByBook.a).toEqual([id]);
    await expect(store.getState().loadSessionList("a")).resolves.toEqual([]);
  });

  it("keeps failed deletion visible and its active stream connected", async () => {
    const store = createTestStore();
    const id = seed(store, "a", "正在讨论");
    const close = vi.fn();
    store.setState((state) => ({ sessions: { ...state.sessions, [id]: { ...state.sessions[id]!, stream: { close } as unknown as EventSource } } }));
    fetchJson.mockRejectedValue(new Error("cannot delete"));
    await expect(store.getState().deleteSession(id, true)).rejects.toThrow("cannot delete");
    expect(store.getState().sessions[id]?.title).toBe("正在讨论");
    expect(store.getState().activeSessionId).toBe(id);
    expect(store.getState().sessionIdsByBook.a).toEqual([id]);
    expect(close).not.toHaveBeenCalled();
    await expect(store.getState().deleteSession(id)).resolves.toBeUndefined();
    expect(store.getState().sessions[id]).toBeDefined();
  });

  it("deletes only the confirmed ID after server success and selects the same-book fallback", async () => {
    const store = createTestStore();
    const first = seed(store, "a", "保留");
    const target = seed(store, "a", "待删");
    const otherBook = seed(store, "b", "别书");
    store.getState().activateSession(target);
    let resolve!: (value: unknown) => void;
    fetchJson.mockReturnValue(new Promise((done) => { resolve = done; }));
    const deletion = store.getState().deleteSession(target, true);
    expect(store.getState().sessions[target]).toBeDefined();
    resolve({ ok: true });
    await deletion;
    expect(fetchJson).toHaveBeenCalledWith(`/sessions/${encodeURIComponent(target)}`, { method: "DELETE" });
    expect(store.getState().sessions[target]).toBeUndefined();
    expect(store.getState().sessionIdsByBook.a).toEqual([first]);
    expect(store.getState().sessions[otherBook]?.title).toBe("别书");
    expect(store.getState().activeSessionId).toBe(first);
  });

  it("restores the previous title and reports an unsuccessful rename", async () => {
    const store = createTestStore();
    const id = seed(store, null, "建书讨论");
    fetchJson.mockRejectedValue(new Error("write failed"));
    await expect(store.getState().renameSession(id, "新标题", true)).rejects.toThrow("write failed");
    expect(store.getState().sessions[id]?.title).toBe("建书讨论");
    fetchJson.mockResolvedValue({});
    await store.getState().renameSession(id, "新标题", true);
    expect(store.getState().sessions[id]?.title).toBe("新标题");
  });

  it("rejects a mismatched session response rather than restoring another conversation", async () => {
    const store = createTestStore();
    const id = seed(store, "a", "第一条");
    fetchJson.mockResolvedValue({ session: { sessionId: "other-session", bookId: "b", messages: [] } });
    await expect(store.getState().loadSessionDetail(id, true)).rejects.toThrow();
    expect(store.getState().sessions["other-session"]).toBeUndefined();
    expect(store.getState().activeSessionId).toBe(id);
  });

  it("restores the requested persisted pre-book conversation with its messages", async () => {
    const store = createTestStore();
    fetchJson.mockResolvedValue({ session: { sessionId: "123-ask", bookId: null, sessionKind: "book-create", title: "最初的设想", messages: [{ role: "user", content: "写一个故事", timestamp: 1 }] } });
    await store.getState().loadSessionDetail("123-ask", true);
    store.getState().activateSession("123-ask");
    expect(store.getState().sessions["123-ask"]).toMatchObject({ bookId: null, sessionKind: "book-create", title: "最初的设想", messages: [{ content: "写一个故事" }] });
    expect(store.getState().activeSessionId).toBe("123-ask");
  });
});
