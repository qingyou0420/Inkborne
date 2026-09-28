import { configDefaults, defineConfig } from "vitest/config";

/**
 * Default `vitest run` / root `pnpm test` includes every file under src/__tests__.
 * This list is an exception list, not a whitelist.
 *
 * Each file below fails on system Node because every case builds a SQLite FTS5
 * index (`no such module: fts5`). Electron's node:sqlite has FTS5; set
 * INKOS_TEST_INCLUDE_FTS=1 (`pnpm test:core:full`) to run them.
 *
 * Mixed files stay in the default set. Their FTS-only cases call
 * hasNodeSqliteFts5() and skip when the module is missing:
 * pipeline-runner.test.ts, memory-retrieval.test.ts, local-search.test.ts,
 * production-skill-bindings.test.ts, skill-agent-tool.test.ts.
 */
const fts5OnlyFiles = [
  // ChapterAnalyzerAgent.analyzeChapter always calls retrieveMemorySelection.
  "src/__tests__/chapter-analyzer.test.ts",
  // ComposerAgent.composeChapter always calls retrieveMemorySelection.
  "src/__tests__/composer.test.ts",
  // retrieveMaterials opens LocalSearchIndex.
  "src/__tests__/material-retrieval.test.ts",
  // PlannerAgent.planChapter always calls retrieveMemorySelection.
  "src/__tests__/planner.test.ts",
  // gatherPlanningMaterials always calls retrieveMemorySelection.
  "src/__tests__/planning-materials.test.ts",
  // The single case drives writeNextChapter into FTS-backed memory retrieval.
  "src/__tests__/pipeline-runner-memory-sync.test.ts",
];

const includeFts = process.env.INKOS_TEST_INCLUDE_FTS === "1";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    exclude: includeFts
      ? [...configDefaults.exclude]
      : [...configDefaults.exclude, ...fts5OnlyFiles],
    // Some pipeline-runner tests can approach Vitest's default 5s timeout
    // under full parallel runs; keep this high enough to avoid false kills.
    testTimeout: 30_000,
  },
});
