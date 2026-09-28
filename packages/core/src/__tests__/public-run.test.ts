import { describe, expect, it } from "vitest";
import { sanitizeAuthoringRun } from "../authoring/public-run.js";

describe("sanitizeAuthoringRun", () => {
  it("removes headers and key-like fields from the model snapshot", () => {
    const run = sanitizeAuthoringRun({
      runId: "run-1",
      stage: "write",
      operation: "generate",
      roleId: "write.main",
      status: "completed",
      modelSnapshot: {
        serviceRef: "custom:内网",
        modelId: "m",
        apiKey: "sk-secret",
        extra: {
          headers: { Authorization: "Bearer sk-secret" },
          temperature: 0.2,
          token: "abc",
        },
      },
      error: "failed sk-live_abcdefghijklmnopqrstuvwxyz",
      producedArtifactIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(run.modelSnapshot).toMatchObject({
      serviceRef: "custom:内网",
      modelId: "m",
      extra: { temperature: 0.2 },
    });
    expect(JSON.stringify(run.modelSnapshot)).not.toMatch(/apiKey|headers|Authorization|token|sk-/);
    expect(run.error).not.toContain("sk-live_abcdefghijklmnopqrstuvwxyz");
    expect(run.error).toContain("已隐藏");
  });
});
