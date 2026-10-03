import { describe, it, expect } from "vitest";
import { parseHash, routeToHash } from "../hooks/use-hash-route";

describe("flow route", () => {
  it("redirects a saved flow link", () => { expect(parseHash("#/flow/p1")).toEqual({ page: "maintenance" }); });
  it("redirects old in-memory routes", () => { expect(routeToHash({ page: "flow", projectId: "p1" })).toBe("#/maintenance"); });
});
