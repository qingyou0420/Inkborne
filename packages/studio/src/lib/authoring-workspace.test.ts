import { describe, expect, it } from "vitest";
import {
  currentWriteArtifact,
  resolveAdoptArtifactId,
  type AuthoringWorkspace,
} from "./authoring-workspace";

describe("authoring workspace helpers", () => {
  it("adopts the persisted id instead of the stale candidate (R3-01)", () => {
    expect(resolveAdoptArtifactId("write-v2", "write-v1")).toBe("write-v2");
    expect(resolveAdoptArtifactId(undefined, "write-v1")).toBe("write-v1");
    expect(() => resolveAdoptArtifactId(undefined, undefined)).toThrow(/没有可采用的稿件/);
  });

  it("uses the selected candidate rather than the newest artifact (R3-05)", () => {
    const workspace: AuthoringWorkspace = {
      artifacts: [
        { artifactId: "v1", stage: "write", scope: "chapter:3", version: 1, status: "candidate" },
        { artifactId: "v2", stage: "write", scope: "chapter:3", version: 2, status: "candidate" },
      ],
      manifest: {
        candidates: { write: { "3": "v1" } },
      },
    };
    expect(currentWriteArtifact(workspace, 3)?.artifactId).toBe("v1");
  });
});
