// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { lucideExports, directLucide } from "./lucide-direct.mjs";
import { mermaidDistribution, localMermaid } from "./local-mermaid.mjs";

test("the full Mermaid browser distribution has only resolvable local module imports", () => {
  const distribution = mermaidDistribution();
  const files = new Set(distribution.files.map((file) => file.name));
  assert.ok(files.size > 50); assert.ok(distribution.license.length > 100);
  for (const file of distribution.files) {
    const ast = ts.createSourceFile(file.name, file.source.toString(), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    const check = (specifier) => {
      assert.ok(specifier.startsWith("."), `${file.name} contains nonlocal import: ${specifier}`);
      assert.ok(files.has(posix.normalize(posix.join(posix.dirname(file.name), specifier))), `${file.name} is missing ${specifier}`);
    };
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) check(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        assert.ok(ts.isStringLiteral(node.arguments[0]), "Mermaid dynamic imports must name a shipped module");
        check(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const plugin = localMermaid(); plugin.configResolved({ base: "/" });
  assert.equal(plugin.resolveId("mermaid").id, `/${distribution.directory}/mermaid.esm.min.mjs`);
  assert.equal(plugin.resolveId("unrelated"), null);
  const emitted = [];
  plugin.generateBundle.call({ emitFile: (file) => emitted.push(file) });
  assert.equal(emitted.length, distribution.files.length + 1);
  assert.ok(emitted.every((file) => file.fileName.startsWith("assets/vendor/")));
});

test("direct Lucide imports preserve legacy aliases and the original rendered icon data", async () => {
  const table = lucideExports();
  assert.ok(table.size > 1000);
  for (const target of table.values()) assert.ok(existsSync(target));
  const require = createRequire(import.meta.url);
  const icons = require("lucide-react");
  for (const name of ["Fingerprint", "FingerprintPattern", "CheckCircle2", "CircleCheck", "AlertCircle", "CircleAlert", "Loader2", "LoaderCircle", "Save", "BookOpen", "Moon", "Settings2"]) {
    const direct = (await import(pathToFileURL(table.get(name)).href)).default;
    assert.equal(direct.displayName, icons[name].displayName);
    assert.deepEqual(direct.render({ size: 19 }, null).props, icons[name].render({ size: 19 }, null).props);
  }
});

test("Lucide rewrite respects import aliases, ignores strings and preserves namespace imports", () => {
  const require = createRequire(import.meta.resolve("vite"));
  const { parseAst } = require("rollup/parseAst");
  const plugin = directLucide();
  const source = `import { Save as SaveIcon, Fingerprint } from "lucide-react";\nconst text = 'import { X } from "lucide-react";';`;
  const result = plugin.transform.call({ parse: parseAst }, source).code;
  assert.ok(result.includes("import SaveIcon from"));
  assert.ok(result.includes("fingerprint-pattern.js"));
  assert.ok(result.includes(`const text = 'import { X } from "lucide-react";';`));
  assert.equal(plugin.transform.call({ parse: parseAst }, 'import * as icons from "lucide-react";'), null);
});
