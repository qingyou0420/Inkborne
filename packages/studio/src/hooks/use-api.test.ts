import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildApiUrl,
  chapterMutationInvalidationPaths,
  deriveInvalidationPaths,
  fetchJson,
  invalidationPathsForAuthoringRunSse,
  invalidationPathsForChapterMutationSse,
  shouldCommitApiResult,
  shouldReuseInflightRefetch,
  StudioApiError,
} from "./use-api";
import {
  beginRecoveryRead,
  clearRequestDiagnostics,
  connectionReadyShouldRefetch,
  emitEngineConnection,
  endRecoveryRead,
  listRequestDiagnostics,
  resetRecoveryRead,
  shouldRetryRead,
} from "../lib/engine-connection";

describe("buildApiUrl", () => {
  it("returns null for blank paths so callers can skip requests", () => {
    expect(buildApiUrl("")).toBeNull();
    expect(buildApiUrl("   ")).toBeNull();
  });

  it("prefixes api paths once", () => {
    expect(buildApiUrl("/books")).toBe("/api/v1/books");
    expect(buildApiUrl("books")).toBe("/api/v1/books");
    expect(buildApiUrl("/api/v1/books")).toBe("/api/v1/books");
  });
});

describe("fetchJson", () => {
  it("surfaces API error payloads on non-ok responses", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Bad request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchJson("/books", {}, { fetchImpl })).rejects.toThrow("Bad request");
  });

  it("falls back to status text when the body is not JSON", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("boom", {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await expect(fetchJson("/books", {}, { fetchImpl })).rejects.toThrow("500 Internal Server Error");
  });

  it("surfaces nested api error messages from structured error payloads", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "INVALID_BOOK_ID", message: "Invalid book ID: ../bad" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchJson("/books/../bad", {}, { fetchImpl })).rejects.toThrow("Invalid book ID: ../bad");
  });

  it("throws BOOK_BUSY as StudioApiError with owner", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        error: {
          code: "BOOK_BUSY",
          message: "Book \"demo\" is locked by an active write.",
          owner: { bookId: "demo", taskId: "t1", stage: "write", inProcess: true },
        },
      }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchJson("/books/demo/truth/author_intent.md", { method: "PUT" }, { fetchImpl }))
      .rejects.toMatchObject({
        name: "StudioApiError",
        code: "BOOK_BUSY",
        owner: { bookId: "demo", taskId: "t1" },
      });
    expect(StudioApiError).toBeDefined();
  });

  it("localizes known runtime errors before throwing", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        error: "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
      }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchJson("/books/demo/write-next", { method: "POST" }, { fetchImpl })).rejects.toThrow(
      "最新第 1 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。",
    );
  });

  it("maps Failed to fetch to a transient copy when health still answers", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ ok: true, pid: 99 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new TypeError("Failed to fetch");
    });

    await expect(fetchJson("/books", {}, { fetchImpl })).rejects.toMatchObject({
      name: "StudioApiError",
      kind: "transient",
      message: "请求暂时失败，请重试；若正文已出现可先刷新",
    });
  });

  it("does not call a 500 Failed to fetch body a local engine outage", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Failed to fetch" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchJson("/books", {}, { fetchImpl })).rejects.toMatchObject({
      name: "StudioApiError",
      status: 500,
      kind: "upstream",
      message: "上游服务暂时失败，请稍后重试",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("merges overlapping GETs and does not self-restart after one retry while health stays up", async () => {
    clearRequestDiagnostics();
    emitEngineConnection({ status: "ready" }, { force: true });
    let bookGets = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ ok: true, pid: 3 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      bookGets += 1;
      throw new TypeError("Failed to fetch");
    });
    const readWithRetry = async () => {
      try {
        return await fetchJson("/books/fixture", {}, { fetchImpl });
      } catch (cause) {
        const kind = cause instanceof StudioApiError ? cause.kind : "unknown";
        if (!shouldRetryRead("GET", 0, kind)) throw cause;
        return fetchJson("/books/fixture", {}, { fetchImpl });
      }
    };
    await Promise.allSettled([readWithRetry(), readWithRetry()]);
    expect(bookGets).toBeLessThanOrEqual(2);
    const afterFirstCycle = bookGets;
    await Promise.allSettled([readWithRetry()]);
    expect(bookGets - afterFirstCycle).toBeLessThanOrEqual(2);
    expect(connectionReadyShouldRefetch("ready", "ready")).toBe(false);
    resetRecoveryRead("/api/v1/books/fixture");
    expect(beginRecoveryRead("/api/v1/books/fixture")).toBe(true);
    expect(beginRecoveryRead("/api/v1/books/fixture")).toBe(true);
    endRecoveryRead("/api/v1/books/fixture");
    expect(beginRecoveryRead("/api/v1/books/fixture")).toBe(false);
    const recovery = listRequestDiagnostics().find((row) => row.healthOk === true);
    expect(recovery?.category).toBe("transient");
  });

  it("reuses only the same URL in-flight refetch and ignores stale results", () => {
    expect(shouldReuseInflightRefetch({
      inflightUrl: "/api/v1/authoring/artifacts/v1",
      nextUrl: "/api/v1/authoring/artifacts/v1",
      inflightGeneration: 2,
      currentGeneration: 2,
    })).toBe(true);
    expect(shouldReuseInflightRefetch({
      inflightUrl: "/api/v1/authoring/artifacts/v1",
      nextUrl: "/api/v1/authoring/artifacts/v2",
      inflightGeneration: 2,
      currentGeneration: 2,
    })).toBe(false);
    expect(shouldReuseInflightRefetch({
      inflightUrl: undefined,
      nextUrl: "/api/v1/authoring/artifacts/v2",
      currentGeneration: 1,
    })).toBe(false);
    expect(shouldReuseInflightRefetch({
      inflightUrl: "/api/v1/authoring/artifacts/v1",
      nextUrl: "/api/v1/authoring/artifacts/v1",
      inflightGeneration: 1,
      currentGeneration: 2,
    })).toBe(false);
    expect(shouldCommitApiResult("/api/v1/books/old", "/api/v1/books/new", 1, 2)).toBe(false);
    expect(shouldCommitApiResult("/api/v1/books/new", "/api/v1/books/new", 2, 2)).toBe(true);
    expect(shouldCommitApiResult("/api/v1/books/old", "/api/v1/books/old", 1, 2)).toBe(false);
  });

  it("drops inflight ownership when the path becomes empty so the same URL can commit again", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "use-api.ts"), "utf8");
    expect(source).toMatch(/if \(!url\) \{[\s\S]*refetchInflight\.current = null/);
    expect(source).toMatch(/inflightGeneration === input\.currentGeneration/);
  });
});

describe("deriveInvalidationPaths", () => {
  it("refreshes book collections after creating a book", () => {
    expect(deriveInvalidationPaths("/books/create")).toEqual(["/api/v1/books"]);
    expect(deriveInvalidationPaths("/spinoff/init")).toEqual(["/api/v1/books"]);
    expect(deriveInvalidationPaths("/imitation/init")).toEqual(["/api/v1/books"]);
  });

  it("refreshes both collections and the current book after book mutations", () => {
    expect(deriveInvalidationPaths("/books/demo/write-next")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
    ]);
    expect(deriveInvalidationPaths("/books/demo/chapters/3/approve")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
    ]);
    expect(deriveInvalidationPaths("/books/demo/cover")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
    ]);
  });

  it("refreshes daemon state after daemon mutations", () => {
    expect(deriveInvalidationPaths("/daemon/start")).toEqual(["/api/v1/daemon"]);
    expect(deriveInvalidationPaths("/daemon/stop")).toEqual(["/api/v1/daemon"]);
  });

  it("refreshes project data after project mutations", () => {
    expect(deriveInvalidationPaths("/project")).toEqual(["/api/v1/project"]);
    expect(deriveInvalidationPaths("/project/language")).toEqual(["/api/v1/project", "/api/v1/project/language"]);
  });

  it("refreshes shorts after short metadata mutations", () => {
    expect(deriveInvalidationPaths("/shorts/明日来信")).toEqual([
      "/api/v1/shorts",
      "/api/v1/shorts/明日来信",
    ]);
    expect(deriveInvalidationPaths(`/shorts/${encodeURIComponent("明日来信")}`)).toEqual([
      "/api/v1/shorts",
      `/api/v1/shorts/${encodeURIComponent("明日来信")}`,
    ]);
  });

  it("refreshes story-card, stage, and the book after a story-card put", () => {
    expect(deriveInvalidationPaths("/books/x/story-card")).toEqual([
      "/api/v1/books/x/story-card",
      "/api/v1/books/x/stage",
      "/api/v1/books/x",
    ]);
  });

  it("refreshes story-card and stage after applying a truth proposal", () => {
    expect(deriveInvalidationPaths("/books/zui-ci/truth-proposals/abc/apply")).toEqual([
      "/api/v1/books/zui-ci/story-card",
      "/api/v1/books/zui-ci/stage",
    ]);
    expect(deriveInvalidationPaths("/api/v1/books/zui-ci/truth-proposals/abc/apply")).toEqual([
      "/api/v1/books/zui-ci/story-card",
      "/api/v1/books/zui-ci/stage",
    ]);
  });

  it("refreshes the works list after deleting a book", () => {
    expect(deriveInvalidationPaths("/books/ghost")).toEqual([
      "/api/v1/books",
      "/api/v1/books/ghost",
    ]);
    expect(deriveInvalidationPaths("/api/v1/books/ghost")).toEqual([
      "/api/v1/books",
      "/api/v1/books/ghost",
    ]);
  });

  it("refreshes the chapter body after rewrite or restore", () => {
    expect(deriveInvalidationPaths("/books/demo/rewrite/3")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
      "/api/v1/books/demo/chapters/3",
      "/api/v1/books/demo/chapters/3/workspace",
    ]);
    expect(deriveInvalidationPaths("/books/demo/revise/3")).toEqual(
      chapterMutationInvalidationPaths("demo", 3),
    );
    expect(deriveInvalidationPaths("/books/demo/chapters/3/versions/v1/restore")).toEqual(
      chapterMutationInvalidationPaths("demo", 3),
    );
    expect(invalidationPathsForChapterMutationSse({
      event: "rewrite:complete",
      data: { bookId: "demo", chapterNumber: 3 },
    })).toEqual(chapterMutationInvalidationPaths("demo", 3));
    expect(invalidationPathsForChapterMutationSse({
      event: "revise:complete",
      data: { bookId: "demo", chapter: 3 },
    })).toEqual(chapterMutationInvalidationPaths("demo", 3));
    expect(invalidationPathsForChapterMutationSse({
      event: "rewrite:complete",
      data: { bookId: "demo" },
    })).toEqual([]);
    expect(invalidationPathsForChapterMutationSse({
      event: "write:complete",
      data: { bookId: "demo", chapterNumber: 4 },
    })).toEqual([]);
  });

  it("refreshes the book workspace when an authoring run settles over SSE", () => {
    expect(invalidationPathsForAuthoringRunSse({
      event: "authoring:run",
      data: { bookId: "demo", status: "completed", runId: "run-1" },
    })).toEqual(["/api/v1/authoring/workspace?bookId=demo"]);
    expect(invalidationPathsForAuthoringRunSse({
      event: "authoring:run",
      data: { draftId: "draft-1", status: "failed" },
    })).toEqual(["/api/v1/authoring/workspace?draftId=draft-1"]);
    expect(invalidationPathsForAuthoringRunSse({
      event: "authoring:run",
      data: { bookId: "demo", status: "running" },
    })).toEqual([]);
    expect(invalidationPathsForAuthoringRunSse({
      event: "write:complete",
      data: { bookId: "demo", status: "completed" },
    })).toEqual([]);
  });
});

describe("fetchJson delete invalidation", () => {
  it("broadcasts book-collection invalidation after a successful book delete", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });

    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, bookId: "ghost" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    try {
      await fetchJson("/books/ghost", { method: "DELETE" }, { fetchImpl });
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent<{ paths: ReadonlyArray<string> }>;
      expect(event.type).toBe("inkos:api-invalidate");
      expect(event.detail.paths).toEqual(["/api/v1/books", "/api/v1/books/ghost"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still invalidates the shorts list when DELETE 明日来信 is already gone", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });

    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Short not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    try {
      await expect(
        fetchJson(`/shorts/${encodeURIComponent("明日来信")}`, { method: "DELETE" }, { fetchImpl }),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent<{ paths: ReadonlyArray<string> }>;
      expect(event.detail.paths).toEqual([
        "/api/v1/shorts",
        `/api/v1/shorts/${encodeURIComponent("明日来信")}`,
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
