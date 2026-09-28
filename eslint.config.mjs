import tseslint from "typescript-eslint";

/**
 * Small bug-finding set. No stylistic or formatting rules, so a green lint
 * does not require a repo-wide reformat.
 */
const bugRules = {
  "no-debugger": "error",
  "no-dupe-keys": "error",
  "no-dupe-else-if": "error",
  "no-duplicate-case": "error",
  "no-constant-binary-expression": "error",
  "no-self-compare": "error",
  "no-self-assign": "error",
  "no-unsafe-finally": "error",
  "no-unsafe-negation": "error",
  "no-unreachable": "error",
  "no-loss-of-precision": "error",
  "no-import-assign": "error",
  "no-setter-return": "error",
  "no-cond-assign": ["error", "except-parens"],
  "no-fallthrough": "error",
  "no-ex-assign": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
};

// These rules are not turned on. They are registered only so existing
// eslint-disable comments keep parsing. ESLint 10 errors if a disable
// comment names a rule that is not defined.
const commentOnlyPlugins = {
  "@typescript-eslint": tseslint.plugin,
  "react-hooks": {
    rules: {
      "exhaustive-deps": {
        meta: { type: "problem", schema: [] },
        create() {
          return {};
        },
      },
    },
  },
};

const linterOptions = {
  // The tree still has eslint-disable comments for rules this config does not
  // load (formatting, react-hooks, no-explicit-any). Leave those comments
  // alone instead of failing the build on them.
  reportUnusedDisableDirectives: "off",
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-engine/**",
      "**/dist-installer/**",
      "**/test-project/**",
      "**/coverage/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: commentOnlyPlugins,
    rules: {
      ...bugRules,
      "@typescript-eslint/no-explicit-any": "off",
      "react-hooks/exhaustive-deps": "off",
    },
    linterOptions,
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: bugRules,
    linterOptions,
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
    },
    rules: bugRules,
    linterOptions,
  },
];
