import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestMaterial } from "../materials/ingest.js";

describe("material ingestion", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-material-ingest-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("archives a project text file as traceable markdown material", async () => {
    await writeFile(join(root, "brief.md"), "# Brief\n\n第一人称，县城冷库旧账。", "utf-8");

    const asset = await ingestMaterial(root, {
      sourceKind: "file",
      filePath: "brief.md",
      mimeType: "text/markdown",
      purpose: "worldbuilding",
    }, {
      now: () => new Date("2026-07-03T00:00:00.000Z"),
    });

    expect(asset.kind).toBe("text");
    expect(asset.markdownPath).toMatch(/^\.inkos\/materials\//);
    expect(asset.source).toBe("brief.md");
    expect(asset.excerpt).toContain("县城冷库旧账");
    const markdown = await readFile(join(root, asset.markdownPath), "utf-8");
    expect(markdown).toContain("## Metadata");
    expect(markdown).toContain("- purpose: worldbuilding");
    expect(markdown).toContain("第一人称，县城冷库旧账。");
    const manifest = JSON.parse(await readFile(join(root, asset.manifestPath), "utf-8")) as { markdownPath?: string };
    expect(manifest.markdownPath).toBe(asset.markdownPath);
  });

  it.each(["utf8-bom", "utf16-le", "utf16-be"] as const)("reads a %s source completely without changing the original file", async (encoding) => {
    const text = "# 旧作\r\n开篇：清岚来自北方。\r\n最终章：沈砚没有复活。";
    const le = Buffer.from(text, "utf16le");
    const bytes = encoding === "utf8-bom" ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])
      : encoding === "utf16-le" ? Buffer.concat([Buffer.from([0xff, 0xfe]), le])
        : Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(le).swap16()]);
    await writeFile(join(root, "old.md"), bytes);
    const material = await ingestMaterial(root, { sourceKind: "file", filePath: "old.md" });
    expect(material.charCount).toBe(text.replace(/\r\n/g, "\n").length);
    expect(await readFile(join(root, material.markdownPath), "utf-8")).toContain("最终章：沈砚没有复活。");
    expect(await readFile(join(root, "old.md"))).toEqual(bytes);
  });

  it.each([Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from([0xff, 0xfe, 0x00])])("rejects ambiguous or broken Unicode without replacement characters", async (bytes) => {
    await writeFile(join(root, "undecodable.txt"), bytes);
    await expect(ingestMaterial(root, { sourceKind: "file", filePath: "undecodable.txt" })).rejects.toThrow(/另存为 UTF-8.*未用乱码/);
    expect(await readFile(join(root, "undecodable.txt"))).toEqual(bytes);
  });

  it("extracts and archives HTML fetched from a URL", async () => {
    const fetchImpl = async () => new Response(
      "<html><head><title>旧账资料</title><style>x{}</style></head><body><h1>冷库流程</h1><script>bad()</script><p>入库单需要签字。</p></body></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );

    const asset = await ingestMaterial(root, {
      sourceKind: "url",
      url: "https://example.com/cold-storage",
      purpose: "research",
    }, {
      fetch: fetchImpl as typeof fetch,
      now: () => new Date("2026-07-03T00:00:00.000Z"),
    });

    expect(asset.kind).toBe("webpage");
    expect(asset.title).toBe("旧账资料");
    expect(asset.source).toBe("https://example.com/cold-storage");
    expect(asset.excerpt).toContain("入库单需要签字");
    expect(asset.excerpt).not.toContain("bad()");
  });
});
