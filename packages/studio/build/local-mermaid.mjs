// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Reuse Mermaid's complete browser distribution instead of rebundling its graph. */
export function mermaidDistribution() {
  const streamdownRequire = createRequire(import.meta.resolve("@streamdown/mermaid"));
  const dist = dirname(streamdownRequire.resolve("mermaid"));
  const pkg = JSON.parse(readFileSync(join(dist, "../package.json"), "utf8"));
  const directory = `assets/vendor/mermaid-${pkg.version}`;
  const files = ["mermaid.esm.min.mjs", ...readdirSync(join(dist, "chunks/mermaid.esm.min"))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => `chunks/mermaid.esm.min/${name}`)];
  return {
    directory,
    files: files.map((name) => ({ name, source: readFileSync(join(dist, name)) })),
    license: readFileSync(join(dist, "../LICENSE")),
  };
}

export function localMermaid() {
  const distribution = mermaidDistribution();
  let base = "/";
  return {
    name: "inkborne-local-mermaid",
    apply: "build",
    enforce: "pre",
    configResolved(config) {
      base = config.base;
      if (!base.startsWith("/")) {
        throw new Error("The Studio engine requires an absolute local Vite base path.");
      }
    },
    resolveId(id) {
      if (id !== "mermaid") return null;
      return { id: `${base}${distribution.directory}/mermaid.esm.min.mjs`, external: true };
    },
    generateBundle() {
      for (const { name, source } of distribution.files) {
        this.emitFile({ type: "asset", fileName: `${distribution.directory}/${name}`, source });
      }
      this.emitFile({ type: "asset", fileName: `${distribution.directory}/LICENSE`, source: distribution.license });
    },
  };
}
