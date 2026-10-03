import { describe, it, expect } from "vitest";
import { parseHash, routeToHash } from "../hooks/use-hash-route";
describe("retired film-studio route", () => {
  it("redirects historical links to maintenance", () => { expect(parseHash("#/studio/film/p1")).toEqual({ page: "maintenance" }); });
  it("normalizes in-memory navigation to maintenance", () => { expect(routeToHash({ page: "film-studio", projectId: "p1" })).toBe("#/maintenance"); });
});
