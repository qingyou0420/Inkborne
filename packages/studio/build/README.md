# Production build and type checks

The Studio retains all existing Markdown, syntax highlighting, Mermaid diagram,
and Lucide icon features. Two build-only plugins keep the module graph small:

- `local-mermaid.mjs` copies the installed Mermaid package's complete prebuilt
  browser ESM distribution and license into `dist/assets/vendor/mermaid-<version>`.
  Mermaid's own relative lazy imports stay intact; no CDN is used. The engine's
  static handler serves `.mjs` with the JavaScript MIME type.
- `lucide-direct.mjs` reads the installed Lucide export table and rewrites actual
  named runtime imports to their matching files after TS/JSX compilation. Legacy
  aliases remain equivalent. Namespace or unsupported import forms are preserved.

`pnpm test:build` checks the full Mermaid import graph, the Lucide alias mapping
and rendered icon props, and production static asset responses. Run it after
dependency updates. No generated vendor files are committed; `pnpm build`
recreates them from the lockfile-controlled installation.

`pnpm build` compiles the production core, browser application, and API server.
Core tests are excluded from emitted production files. `pnpm typecheck` rebuilds
the core declarations and then strictly checks both the browser and server;
the browser uses the core's generated public declarations rather than pulling
the entire server implementation into a second compiler program.

`pnpm typecheck:tests` separately checks **all** core and Studio test files with
their original strict project options and transitive source imports. Studio
tests consume the same generated core public declarations as production; the
core source is checked by the core production and test compiler programs. It runs
sequential compiler batches in fresh processes to bound peak memory. It neither
transpiles without checks nor suppresses diagnostics. `pnpm test` also invokes
`pnpm test:authoring-ui`, which retains the four-stage UI state regression cases.

During the 2026-09-15 investigation, the unoptimized compiler/bundler processes
sometimes exited with Windows status `4294967295` without diagnostics near
900 MB RSS. Smaller V8 heaps exposed OOM. The precise external process limit was
not established. After dependency graph separation the ordinary build succeeds
without heap overrides; the test compiler batches use a bounded 768 MB old heap.
