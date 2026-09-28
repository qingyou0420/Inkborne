/** SPDX-License-Identifier: AGPL-3.0-only */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "BookDetail.tsx"), "utf8");

describe("BookDetail recovery", () => {
  it("does not replace a loaded write page with a full-page error", () => {
    expect(source).not.toMatch(/if \(error\) return <div className="text-destructive/);
    expect(source).toMatch(/if \(error && !data\)/);
    expect(source).toMatch(/data-testid="write-reconnect"/);
    expect(source).toMatch(/data-testid="write-refresh-error"/);
    expect(source).toMatch(/重新连接/);
    expect(source).toMatch(/downloadRequestDiagnostics/);
    expect(source).toMatch(/data-testid="export-request-diagnostics"/);
  });
});
