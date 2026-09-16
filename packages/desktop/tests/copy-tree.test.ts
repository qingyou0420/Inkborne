import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { copyTree } = require("../../../scripts/lib/copy-tree.cjs") as {
  copyTree: (src: string, dest: string) => void;
};

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("copyTree dereference", () => {
  it("follows a directory symlink and copies file contents", () => {
    const root = mkdtempSync(join(tmpdir(), "fw-copy-"));
    temps.push(root);
    const store = join(root, "store", "pkg");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "index.js"), "export const n = 1\n");
    const src = join(root, "src");
    mkdirSync(join(src, "node_modules"), { recursive: true });
    symlinkSync(store, join(src, "node_modules", "pkg"), process.platform === "win32" ? "junction" : "dir");
    const dest = join(root, "dest");
    copyTree(src, dest);
    expect(readFileSync(join(dest, "node_modules", "pkg", "index.js"), "utf8")).toContain("export const n");
  });
});
