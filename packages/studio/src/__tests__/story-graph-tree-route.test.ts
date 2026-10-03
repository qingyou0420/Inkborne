import { describe, it, expect } from "vitest";
import { parseHash, routeToHash } from "../hooks/use-hash-route";

describe("film tree route", () => {
  it("parses #/film/:id", () => {
    expect(parseHash("#/film/p1")).toEqual({ page: "maintenance" });
  });
  it("round-trips", () => {
    expect(routeToHash({ page: "film", projectId: "p1" })).toBe("#/maintenance");
  });
});
