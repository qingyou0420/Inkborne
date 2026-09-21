import { describe, expect, it } from "vitest";
import { attachmentDisposition } from "./attachment-disposition.js";

describe("attachmentDisposition", () => {
  it("keeps Chinese filenames ASCII-safe and includes RFC 5987 filename*", () => {
    const value = attachmentDisposition("醉词.txt");

    expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
    expect(() => new Response("ok", { headers: { "Content-Disposition": value } })).not.toThrow();

    expect(value).toMatch(/^attachment; filename="[^"]+"; filename\*=UTF-8''/);
    expect(value).toContain("filename*=UTF-8''");
    expect(value).toContain(encodeURIComponent("醉词.txt"));
    expect(value).not.toMatch(/[\u0080-\uFFFF]/);
    expect(value).toBe(`attachment; filename="__.txt"; filename*=UTF-8''${encodeURIComponent("醉词.txt")}`);
  });

  it("documents that a raw CJK filename header throws ByteString in undici", () => {
    expect(() => new Headers({
      "Content-Disposition": 'attachment; filename="醉词.txt"',
    })).toThrow(/ByteString/);
  });

  it("falls back to download when the name has no ASCII residue", () => {
    const value = attachmentDisposition("醉词");
    expect(value.startsWith('attachment; filename="download"')).toBe(true);
    expect(value).toContain(`filename*=UTF-8''${encodeURIComponent("醉词")}`);
    expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
  });

  it("preserves a plain ASCII filename in both parameters", () => {
    expect(attachmentDisposition("harbor.txt")).toBe(
      `attachment; filename="harbor.txt"; filename*=UTF-8''${encodeURIComponent("harbor.txt")}`,
    );
  });
});
