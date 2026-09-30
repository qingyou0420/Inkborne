import { describe, expect, it } from "vitest";
import { deriveFilePresentation, resolveSelectedFileData, SHIM_AUTHORITATIVE_PATH } from "./TruthFiles";

describe("deriveFilePresentation", () => {
  it("allows editing for non-legacy outline files", () => {
    const result = deriveFilePresentation("outline/story_frame.md", {
      content: "# frame",
      legacy: false,
    });
    expect(result.legacy).toBe(false);
    expect(result.canEdit).toBe(true);
    expect(result.authoritativePath).toBeNull();
  });

  it("allows editing when legacy flag is absent", () => {
    const result = deriveFilePresentation("outline/volume_map.md", {
      content: "map",
    });
    expect(result.canEdit).toBe(true);
    expect(result.legacy).toBe(false);
  });

  it("blocks editing and surfaces authoritative path when legacy: true", () => {
    const result = deriveFilePresentation("book_rules.md", {
      content: "# Legacy shim",
      legacy: true,
    });
    expect(result.legacy).toBe(true);
    expect(result.canEdit).toBe(false);
    expect(result.authoritativePath).toBe("outline/story_frame.md");
  });

  it("blocks editing for story_bible.md shim and links to story_frame.md", () => {
    const result = deriveFilePresentation("story_bible.md", {
      content: "# bible shim",
      legacy: true,
    });
    expect(result.legacy).toBe(true);
    expect(result.canEdit).toBe(false);
    expect(result.authoritativePath).toBe("outline/story_frame.md");
  });

  it("blocks editing when no file is selected", () => {
    const result = deriveFilePresentation(null, undefined);
    expect(result.canEdit).toBe(false);
  });

  it("blocks editing when file has no content (e.g. 404)", () => {
    const result = deriveFilePresentation("outline/story_frame.md", {
      content: null,
    });
    expect(result.canEdit).toBe(false);
  });

  it("blocks editing for runtime diagnostic files", () => {
    const result = deriveFilePresentation("runtime/chapter-0003.trace.json", {
      content: "{\"chapter\":3}",
      readonly: true,
      readonlyReason: "runtime-diagnostic",
    });
    expect(result.canEdit).toBe(false);
    expect(result.readonly).toBe(true);
    expect(result.readonlyReason).toBe("runtime-diagnostic");
  });

  it("blocks editing for protected read-only files", () => {
    const result = deriveFilePresentation("canon.md", {
      content: "# canon",
      readonly: true,
      readonlyReason: "protected",
    });
    expect(result.canEdit).toBe(false);
    expect(result.readonly).toBe(true);
    expect(result.readonlyReason).toBe("protected");
  });
});

describe("resolveSelectedFileData", () => {
  const brief = { file: "brief.md", content: "brief body" };
  const intent = { file: "author_intent.md", content: "intent body" };

  it("returns null when the loaded file is not the selection", () => {
    expect(resolveSelectedFileData("brief.md", intent)).toBeNull();
  });

  it("returns the payload when the loaded file matches the selection", () => {
    expect(resolveSelectedFileData("brief.md", brief)).toBe(brief);
  });

  it("returns null when nothing is selected", () => {
    expect(resolveSelectedFileData(null, brief)).toBeNull();
  });

  it("returns null when file data is missing", () => {
    expect(resolveSelectedFileData("brief.md", null)).toBeNull();
    expect(resolveSelectedFileData("brief.md", undefined)).toBeNull();
  });
});

describe("SHIM_AUTHORITATIVE_PATH", () => {
  it("maps every shim file to its outline replacement", () => {
    expect(SHIM_AUTHORITATIVE_PATH["story_bible.md"]).toBe("outline/story_frame.md");
    expect(SHIM_AUTHORITATIVE_PATH["book_rules.md"]).toBe("outline/story_frame.md");
  });
});
