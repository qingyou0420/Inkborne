// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Read the installed export table, including renamed/backwards-compatible icons. */
export function lucideExports() {
  const root = dirname(fileURLToPath(import.meta.resolve("lucide-react/package.json")));
  const entry = resolve(root, "dist/esm/lucide-react.js");
  const table = new Map();
  for (const match of readFileSync(entry, "utf8").matchAll(/export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const specifier of match[1].split(",")) {
      const item = /^\s*default\s+as\s+(\w+)\s*$/.exec(specifier);
      if (item) table.set(item[1], resolve(dirname(entry), match[2]).replaceAll("\\", "/"));
    }
  }
  if (!table.size) throw new Error("The installed Lucide export table could not be read.");
  return table;
}

export function directLucide() {
  const table = lucideExports();
  return {
    name: "inkborne-direct-lucide",
    // Run after TS/JSX transforms so only real runtime imports are rewritten.
    enforce: "post",
    apply: "build",
    transform(code) {
      if (!code.includes("lucide-react")) return null;
      const edits = [];
      for (const node of this.parse(code).body) {
        if (node.type !== "ImportDeclaration" || node.source.value !== "lucide-react") continue;
        if (!node.specifiers.length || node.specifiers.some((item) => item.type !== "ImportSpecifier" || !table.has(item.imported.name))) continue;
        edits.push({ start: node.start, end: node.end, text: node.specifiers.map((item) =>
          `import ${item.local.name} from ${JSON.stringify(table.get(item.imported.name))};`).join("\n") });
      }
      if (!edits.length) return null;
      for (const edit of edits.reverse()) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
      return { code, map: null };
    },
  };
}
