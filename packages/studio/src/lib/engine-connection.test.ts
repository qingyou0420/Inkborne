/** SPDX-License-Identifier: AGPL-3.0-only */
import { describe, expect, it, vi } from "vitest";
import {
  ENGINE_CONNECTION_EVENT,
  ENGINE_UNREACHABLE_MESSAGE,
  TRANSIENT_CONNECTION_MESSAGE,
  UPSTREAM_FETCH_MESSAGE,
  applyApiFetchOutcome,
  beginRecoveryRead,
  classifyHttpFailureMessage,
  classifyNetworkFailure,
  clearRequestDiagnostics,
  connectionReadyShouldRefetch,
  emitEngineConnection,
  endRecoveryRead,
  exportRequestDiagnostics,
  invalidatePathMatches,
  listRequestDiagnostics,
  mergeInflightGet,
  recordRequestDiagnostic,
  resetRecoveryRead,
  routeTemplate,
  shouldRetryRead,
} from "./engine-connection";

describe("engine connection classification", () => {
  it("keeps previous data when a later fetch fails", () => {
    expect(applyApiFetchOutcome({ title: "醉词" }, { ok: false, error: "timeout" })).toEqual({
      data: { title: "醉词" },
      error: "timeout",
    });
  });

  it("retries only the first GET after a transient failure", () => {
    expect(shouldRetryRead("GET", 0, "transient")).toBe(true);
    expect(shouldRetryRead("GET", 1, "transient")).toBe(false);
    expect(shouldRetryRead("POST", 0, "transient")).toBe(false);
    expect(shouldRetryRead("GET", 0, "unreachable")).toBe(false);
  });

  it("does not treat an HTTP Failed to fetch body as a local engine outage", () => {
    expect(classifyHttpFailureMessage("Failed to fetch")).toEqual({
      kind: "upstream",
      message: UPSTREAM_FETCH_MESSAGE,
    });
  });

  it("probes health once for concurrent network failures", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, pid: 11 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const [first, second] = await Promise.all([
      classifyNetworkFailure("Failed to fetch", { fetchImpl }),
      classifyNetworkFailure("NetworkError", { fetchImpl }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ kind: "transient", message: TRANSIENT_CONNECTION_MESSAGE, healthOk: true });
    expect(second.kind).toBe("transient");
  });

  it("uses a reconnect copy when health is down", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const classified = await classifyNetworkFailure("Failed to fetch", { fetchImpl });
    expect(classified.kind).toBe("unreachable");
    expect(classified.message).toBe(ENGINE_UNREACHABLE_MESSAGE);
    expect(classified.message).not.toContain("重启应用");
  });

  it("records bounded diagnostics without request bodies", () => {
    clearRequestDiagnostics();
    recordRequestDiagnostic({
      method: "GET",
      route: routeTemplate("/api/v1/books/醉词"),
      durationMs: 12,
      category: "transient",
      rawKind: "TypeError",
      healthOk: true,
    });
    const rows = listRequestDiagnostics();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.route).toBe("/api/v1/books/:id");
    expect(JSON.stringify(rows[0])).not.toContain("apiKey");
    const exported = exportRequestDiagnostics();
    expect(exported).toContain("transient");
    expect(exported).not.toContain("apiKey");
  });

  it("does not broadcast ready from a health-ok probe while already ready", async () => {
    const events: string[] = [];
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    target.addEventListener(ENGINE_CONNECTION_EVENT, (event) => {
      events.push((event as CustomEvent<{ status: string }>).detail.status);
    });
    emitEngineConnection({ status: "ready" }, { force: true });
    events.length = 0;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, pid: 9 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await classifyNetworkFailure("Failed to fetch", { fetchImpl });
    expect(events).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("allows one recovery read per cycle and matches workspace query paths", () => {
    resetRecoveryRead("/api/v1/books/fixture");
    expect(beginRecoveryRead("/api/v1/books/fixture")).toBe(true);
    expect(beginRecoveryRead("/api/v1/books/fixture")).toBe(true);
    endRecoveryRead("/api/v1/books/fixture");
    expect(beginRecoveryRead("/api/v1/books/fixture")).toBe(false);
    resetRecoveryRead("/api/v1/books/fixture");
    expect(beginRecoveryRead("/api/v1/books/fixture")).toBe(true);
    expect(connectionReadyShouldRefetch("ready", "ready")).toBe(false);
    expect(connectionReadyShouldRefetch("unreachable", "ready")).toBe(true);
    expect(invalidatePathMatches("/api/v1/authoring/workspace?bookId=fixture", ["/api/v1/authoring/workspace"])).toBe(true);
  });

  it("merges overlapping GET work onto one in-flight promise", async () => {
    let runs = 0;
    const pending = mergeInflightGet("same", async () => {
      runs += 1;
      return "ok";
    });
    const second = mergeInflightGet("same", async () => {
      runs += 1;
      return "other";
    });
    expect(await pending).toBe("ok");
    expect(await second).toBe("ok");
    expect(runs).toBe(1);
  });
});
