import { describe, expect, it } from "vitest";
import { parseHash, routeToHash } from "./use-hash-route";

describe("hash route", () => {
  it("keeps the new-book introduction distinct from the actual Ask session", () => {
    expect(parseHash(routeToHash({ page: "book-intro" }))).toEqual({ page: "book-intro" });
    expect(routeToHash({ page: "book-intro" })).not.toBe(routeToHash({ page: "book-create" }));
  });
  it("preserves tools and individual chapters through navigation and refresh", () => {
    const routes = [
      { page: "analytics" as const, bookId: "潮声未寄" },
      { page: "truth" as const, bookId: "潮声未寄" },
      { page: "chapter" as const, bookId: "潮声未寄", chapterNumber: 3 },
      { page: "genres" as const }, { page: "style" as const }, { page: "radar" as const }, { page: "doctor" as const },
    ];
    for (const route of routes) expect(parseHash(routeToHash(route))).toEqual(route);
    expect(() => parseHash("#/book/%bad/ask")).not.toThrow();
  });
  it("restores a specific ask session after a refresh without losing its book scope", () => {
    const bookRoute = { page: "book-ask" as const, bookId: "一本书", sessionId: "draft/a?b=1" };
    expect(parseHash(routeToHash(bookRoute))).toEqual(bookRoute);
    const draftRoute = { page: "book-create" as const, sessionId: "draft/a?b=1" };
    expect(parseHash(routeToHash(draftRoute))).toEqual(draftRoute);
    expect(parseHash("#/book/new?session=")).toEqual({ page: "book-create" });
  });
  it("gives advanced settings a distinct reloadable location", () => {
    expect(parseHash(routeToHash({ page: "project-settings", section: "advanced" })))
      .toEqual({ page: "project-settings", section: "advanced" });
  });
  describe("parseHash", () => {
    it("parses empty hash as dashboard", () => {
      expect(parseHash("")).toEqual({ page: "dashboard" });
    });

    it("parses #/ as dashboard", () => {
      expect(parseHash("#/")).toEqual({ page: "dashboard" });
    });

    it("parses chat route", () => {
      expect(parseHash("#/chat")).toEqual({ page: "chat" });
    });

    it("parses book route", () => {
      expect(parseHash("#/book/my-novel")).toEqual({ page: "book", bookId: "my-novel" });
    });

    it("parses author route", () => {
      expect(parseHash("#/author")).toEqual({ page: "author" });
    });

    it("parses four-step aliases and redirects old hashes", () => {
      expect(parseHash("#/book/my-novel/ask")).toEqual({ page: "book-ask", bookId: "my-novel" });
      expect(parseHash("#/book/my-novel/ground")).toEqual({ page: "book-ground", bookId: "my-novel" });
      expect(parseHash("#/book/my-novel/weave")).toEqual({ page: "book-weave", bookId: "my-novel" });
      expect(parseHash("#/book/my-novel/write")).toEqual({ page: "book-write", bookId: "my-novel" });
      expect(parseHash("#/book/my-novel/outline")).toEqual({ page: "book-weave", bookId: "my-novel" });
      expect(parseHash("#/book/my-novel/settings")).toEqual({ page: "book-write", bookId: "my-novel" });
      expect(parseHash("#/book/my-novel/chat")).toEqual({ page: "book-ask", bookId: "my-novel" });
      expect(routeToHash(parseHash("#/book/my-novel/chat"))).toBe("#/book/my-novel/ask");
    });

    it("decodes encoded bookId", () => {
      expect(parseHash("#/book/%E4%B9%9D%E9%BE%99")).toEqual({ page: "book", bookId: "九龙" });
    });

    it("parses book/new as book-create", () => {
      expect(parseHash("#/book/new")).toEqual({ page: "book-create" });
    });

    it("parses config as services (redirect)", () => {
      expect(parseHash("#/config")).toEqual({ page: "services" });
    });

    it("parses services", () => {
      expect(parseHash("#/services")).toEqual({ page: "services" });
    });

    it("parses project settings", () => {
      expect(parseHash("#/settings")).toEqual({ page: "project-settings" });
    });

    it("parses service-detail", () => {
      expect(parseHash("#/services/openai")).toEqual({ page: "service-detail", serviceId: "openai" });
    });

    it("parses import tab routes", () => {
      expect(parseHash("#/import/fanfic")).toEqual({ page: "import", tab: "fanfic" });
    });

    it("parses #/translation", () => {
      expect(parseHash("#/translation")).toEqual({ page: "translation" });
    });

    it("parses #/update as the in-app update page", () => {
      expect(parseHash("#/update")).toEqual({ page: "update" });
    });

    it("decodes encoded serviceId", () => {
      expect(parseHash("#/services/%E8%87%AA%E5%AE%9A%E4%B9%89")).toEqual({ page: "service-detail", serviceId: "自定义" });
    });

    it("parses short manuscript route", () => {
      expect(parseHash("#/short/明日来信")).toEqual({ page: "short", storyId: "明日来信" });
    });

    it("parses short settings and analytics routes", () => {
      expect(parseHash("#/short/明日来信/settings")).toEqual({ page: "short-settings", storyId: "明日来信" });
      expect(parseHash("#/short/明日来信/analytics")).toEqual({ page: "short-analytics", storyId: "明日来信" });
    });

    it("parses #/logs as the AI activity page", () => {
      expect(parseHash("#/logs")).toEqual({ page: "logs" });
    });

    it("falls back to dashboard for unknown hash", () => {
      expect(parseHash("#/unknown/route")).toEqual({ page: "dashboard" });
    });
  });

  describe("routeToHash", () => {
    it("dashboard -> #/", () => {
      expect(routeToHash({ page: "dashboard" })).toBe("#/");
    });

    it("author -> #/author", () => {
      expect(routeToHash({ page: "author" })).toBe("#/author");
    });

    it("chat -> #/chat", () => {
      expect(routeToHash({ page: "chat" })).toBe("#/chat");
    });

    it("book -> #/book/{id}", () => {
      expect(routeToHash({ page: "book", bookId: "novel-1" })).toBe("#/book/novel-1");
    });

    it("book study hash does not write /chat", () => {
      expect(routeToHash({ page: "book", bookId: "novel-1" })).not.toContain("/chat");
    });

    it("writes four-step hashes and aliases old page types", () => {
      expect(routeToHash({ page: "book-ask", bookId: "novel-1" })).toBe("#/book/novel-1/ask");
      expect(routeToHash({ page: "book-ground", bookId: "novel-1" })).toBe("#/book/novel-1/ground");
      expect(routeToHash({ page: "book-weave", bookId: "novel-1" })).toBe("#/book/novel-1/weave");
      expect(routeToHash({ page: "book-write", bookId: "novel-1" })).toBe("#/book/novel-1/write");
      expect(routeToHash({ page: "book-outline", bookId: "novel-1" })).toBe("#/book/novel-1/weave");
      expect(routeToHash({ page: "book-settings", bookId: "novel-1" })).toBe("#/book/novel-1/write");
    });

    it("encodes Chinese bookId", () => {
      const hash = routeToHash({ page: "book", bookId: "九龙城夜行" });
      expect(hash).toContain("#/book/");
      expect(decodeURIComponent(hash)).toContain("九龙城夜行");
    });

    it("book-create -> #/book/new", () => {
      expect(routeToHash({ page: "book-create" })).toBe("#/book/new");
    });

    it("services -> #/services", () => {
      expect(routeToHash({ page: "services" })).toBe("#/services");
    });

    it("project-settings -> #/settings", () => {
      expect(routeToHash({ page: "project-settings" })).toBe("#/settings");
    });

    it("service-detail -> #/services/{id}", () => {
      expect(routeToHash({ page: "service-detail", serviceId: "openai" })).toBe("#/services/openai");
    });

    it("import tab -> #/import/{tab}", () => {
      expect(routeToHash({ page: "import", tab: "chapters" })).toBe("#/import/chapters");
    });

    it("translation -> #/translation", () => {
      expect(routeToHash({ page: "translation" })).toBe("#/translation");
    });

    it("update -> #/update", () => {
      expect(routeToHash({ page: "update" })).toBe("#/update");
    });

    it("short -> #/short/{id}", () => {
      expect(routeToHash({ page: "short", storyId: "明日来信" })).toBe(`#/short/${encodeURIComponent("明日来信")}`);
    });

    it("short settings and analytics have stable hashes", () => {
      expect(routeToHash({ page: "short-settings", storyId: "明日来信" })).toBe(`#/short/${encodeURIComponent("明日来信")}/settings`);
      expect(routeToHash({ page: "short-analytics", storyId: "明日来信" })).toBe(`#/short/${encodeURIComponent("明日来信")}/analytics`);
    });

    it("encodes Chinese serviceId", () => {
      const hash = routeToHash({ page: "service-detail", serviceId: "自定义" });
      expect(hash).toContain("#/services/");
      expect(decodeURIComponent(hash)).toContain("自定义");
    });

    it("logs and daemon have stable hashes", () => {
      expect(routeToHash({ page: "logs" })).toBe("#/logs");
      expect(routeToHash({ page: "daemon" })).toBe("#/daemon");
    });
  });
});

describe("play route", () => {
  it("parses #/play/:id", () => {
    expect(parseHash("#/play/my-id")).toEqual({ page: "play", projectId: "my-id" });
  });
  it("round-trips to hash", () => {
    expect(routeToHash({ page: "play", projectId: "my-id" })).toBe("#/play/my-id");
  });
  it("decodes url-encoded ids", () => {
    expect(parseHash("#/play/a%20b")).toEqual({ page: "play", projectId: "a b" });
  });
});
