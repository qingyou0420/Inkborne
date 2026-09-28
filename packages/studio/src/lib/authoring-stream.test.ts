import { describe, expect, it } from "vitest";
import { readAuthoringSse } from "./authoring-stream";
import { formatTokenCount, sumTokenUsage } from "./token-usage";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("authoring write stream", () => {
  it("appends deltas and finishes with the saved draft", async () => {
    const deltas: string[] = [];
    const result = await readAuthoringSse(sseResponse([
      'event: start\ndata: {"runId":"run-1"}\n\n',
      'event: delta\ndata: {"delta":"雨"}\n\n',
      'event: delta\ndata: {"delta":"还在下"}\n\n',
      'event: done\ndata: {"artifactId":"a1","runId":"run-1","body":"# 第1章 雨\\n\\n雨还在下","wordCount":4,"status":"completed"}\n\n',
    ]), {
      onDelta: (delta) => deltas.push(delta),
    });
    expect(deltas.join("")).toBe("雨还在下");
    expect(result.artifactId).toBe("a1");
    expect(result.body).toContain("雨还在下");
  });

  it("formats token totals in plain Chinese", () => {
    expect(formatTokenCount(860, true)).toBe("860 token");
    expect(formatTokenCount(12500, true)).toBe("1.3 万 token");
    expect(sumTokenUsage([{ usage: { totalTokens: 10 } }, { usage: { totalTokens: 5 } }, {}])).toBe(15);
  });
});