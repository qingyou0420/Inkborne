import { describe, expect, it } from "vitest";
import { AuthoringStreamError, readAuthoringSse } from "./authoring-stream";
import { estimateRunsCost, estimateTokenCost, formatPassUsage, formatTokenCount, priceForServiceRef, sumTokenUsage, usageTotal } from "./token-usage";

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
    expect(estimateTokenCost(12500, 2)).toBe("约 0.03 元");
    expect(estimateTokenCost(12500, undefined)).toBe("");
    expect(usageTotal({ promptTokens: 4, completionTokens: 6, totalTokens: 0 })).toBe(10);
    expect(formatPassUsage({ promptTokens: 4, completionTokens: 6 }, true)).toBe("这次用了 10 token");
    const services = [
      { service: "deepseek", pricePerMillion: 1 },
      { service: "custom", name: "内网", pricePerMillion: 9 },
    ];
    expect(priceForServiceRef("custom:内网", services)).toBe(9);
    expect(priceForServiceRef("missing", services)).toBeUndefined();
    expect(estimateRunsCost([
      { usage: { totalTokens: 1_000_000 }, modelSnapshot: { serviceRef: "custom:内网" } },
      { usage: { promptTokens: 100, completionTokens: 0 }, modelSnapshot: { serviceRef: "missing" } },
    ], services)).toBe("约 9.00 元（没标价的连接没算进去）");
  });

  it("keeps a saved draft id on failure and says when nothing was saved", async () => {
    await expect(readAuthoringSse(sseResponse([
      'event: delta\ndata: {"delta":"雨"}\n\n',
      'event: error\ndata: {"message":"上游断了","saved":true,"artifactId":"draft-9"}\n\n',
    ]), {})).rejects.toMatchObject({ name: "AuthoringStreamError", draftSaved: true, artifactId: "draft-9" });
    await expect(readAuthoringSse(sseResponse([
      'event: error\ndata: {"message":"还没写出字","saved":false}\n\n',
    ]), {})).rejects.toMatchObject({ draftSaved: false });
    await expect(readAuthoringSse(sseResponse([
      'event: error\ndata: {"message":"还没写出字","saved":false}\n\n',
    ]), {})).rejects.toBeInstanceOf(AuthoringStreamError);
  });
});