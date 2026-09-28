import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { rotateLogIfNeeded } = require("../lib/log-rotate.cjs") as {
  rotateLogIfNeeded: (filePath: string, maxBytes: number, keep?: number) => boolean;
};
const { writingStatusBusy, writingStatusMessage } = require("../lib/quit-writing.cjs") as {
  writingStatusBusy: (status: unknown) => boolean;
  writingStatusMessage: (status: { locks?: Array<{ stage?: string; heldMs?: number }>; atomicWrites?: number }) => string;
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("rotateLogIfNeeded", () => {
  it("rolls a full log and keeps three copies", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-log-"));
    temps.push(dir);
    const file = join(dir, "server.log");
    writeFileSync(file, "a".repeat(20));
    expect(rotateLogIfNeeded(file, 20, 2)).toBe(true);
    expect(readFileSync(`${file}.1`, "utf8")).toBe("a".repeat(20));
    expect(() => statSync(file)).toThrow();

    writeFileSync(file, "b".repeat(20));
    expect(rotateLogIfNeeded(file, 20, 2)).toBe(true);
    expect(readFileSync(`${file}.1`, "utf8")).toBe("b".repeat(20));
    expect(readFileSync(`${file}.2`, "utf8")).toBe("a".repeat(20));

    writeFileSync(file, "c".repeat(20));
    expect(rotateLogIfNeeded(file, 20, 2)).toBe(true);
    expect(readFileSync(`${file}.1`, "utf8")).toBe("c".repeat(20));
    expect(readFileSync(`${file}.2`, "utf8")).toBe("b".repeat(20));
    expect(() => statSync(`${file}.3`)).toThrow();
    expect(rotateLogIfNeeded(file, 20, 2)).toBe(false);
  });

  it("copies and truncates when rename fails, and warns once if that also fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "fw-log-busy-"));
    temps.push(dir);
    const file = join(dir, "server.log");
    const fs = require("node:fs") as typeof import("node:fs");
    const rename = fs.renameSync;
    const copy = fs.copyFileSync;
    writeFileSync(file, "z".repeat(30));
    fs.renameSync = (() => {
      throw new Error("EBUSY");
    }) as typeof fs.renameSync;
    try {
      expect(rotateLogIfNeeded(file, 20, 2)).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("");
      expect(readFileSync(`${file}.1`, "utf8")).toBe("z".repeat(30));
    } finally {
      fs.renameSync = rename;
    }

    const stuck = join(dir, "stuck.log");
    writeFileSync(stuck, "keep");
    fs.renameSync = (() => {
      throw new Error("EBUSY");
    }) as typeof fs.renameSync;
    fs.copyFileSync = (() => {
      throw new Error("EBUSY");
    }) as typeof fs.copyFileSync;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(rotateLogIfNeeded(stuck, 2, 2)).toBe(false);
      expect(rotateLogIfNeeded(stuck, 2, 2)).toBe(false);
      expect(readFileSync(stuck, "utf8")).toBe("keep");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      fs.renameSync = rename;
      fs.copyFileSync = copy;
      warn.mockRestore();
    }
  });
});

describe("writingStatusMessage", () => {
  it("asks to wait or abort without showing a pid", () => {
    const status = { locks: [{ bookId: "demo", stage: "落笔", heldMs: 120_000 }], atomicWrites: 1 };
    expect(writingStatusBusy(status)).toBe(true);
    const text = writingStatusMessage(status);
    expect(text).toContain("落笔");
    expect(text).toContain("2 分钟");
    expect(text).not.toMatch(/pid/i);
    expect(writingStatusBusy(null)).toBe(false);
    expect(writingStatusMessage({ atomicWrites: 1 })).toContain("落盘");
  });
});
