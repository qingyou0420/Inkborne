import { describe, it, expect } from "vitest";
import { parseHash, routeToHash } from "../hooks/use-hash-route";

describe("film-author route", () => {
  it("parses #/film-author/:id", () => {
    expect(parseHash("#/film-author/p1")).toEqual({ page: "maintenance" });
  });
  it("round-trips", () => {
    expect(routeToHash({ page: "film-author", projectId: "p1" })).toBe("#/maintenance");
  });
});
