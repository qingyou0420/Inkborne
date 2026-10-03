import type { AgentSessionConfig } from "@actalk/inkos-core";

/** Product scope only. Core retains historical formats and CLI capabilities. */
const RETIRED_INTENTS = new Set([
  "fanfic_init", "continuation_import", "spinoff_create", "style_imitation",
  "script_create", "storyboard_create", "interactive_film_create", "translation_create",
  "draft_structure", "connect_choice", "remove_node",
]);

const RETIRED_SESSION_KINDS = new Set([
  "script", "storyboard", "interactive-film", "interactive-film-authoring",
]);

export const STUDIO_FEATURE_RETIRED_MESSAGE = "此功能已从轻光之集移除。已有作品文件会保留；资料请在问心导入，正文请在落笔中继续。";

export function isRetiredStudioIntent(intent: unknown): boolean {
  return typeof intent === "string" && RETIRED_INTENTS.has(intent);
}

export function isRetiredStudioSessionKind(kind: unknown): boolean {
  return typeof kind === "string" && RETIRED_SESSION_KINDS.has(kind);
}

/** Mutating old entry points return 410; history, export and cancellation stay usable. */
export function isRetiredStudioWriteRoute(method: string, pathname: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const path = pathname.replace(/\/+$/, "");
  return /^\/api\/v1\/(?:fanfic|spinoff|imitation)\/init$/.test(path)
    || /^\/api\/v1\/books\/[^/]+\/fanfic\/refresh$/.test(path)
    || /^\/api\/v1\/radar\/scan$/.test(path)
    || /^\/api\/v1\/daemon\/start$/.test(path)
    || /^\/api\/v1\/translations\/(?:upload|create|[^/]+\/run)$/.test(path)
    || /^\/api\/v1\/projects\/[^/]+\/(?:story-graph\/delta|nodes\/[^/]+\/image)$/.test(path)
    || /^\/api\/v1\/project\/(?:detection|notify|model-overrides)$/.test(path)
    || /^\/api\/v1\/prompt-packs(?:\/.*)?$/.test(path)
    || /^\/api\/v1\/books\/[^/]+\/(?:detect(?:\/[^/]+)?|detect-all)$/.test(path)
    || /^\/api\/v1\/books\/[^/]+\/(?:import\/(?:chapters|canon|canon-file)|style\/import)$/.test(path)
    || /^\/api\/v1\/(?:import\/canon\/upload|style\/analyze)$/.test(path);
}

const RETIRED_TOOLS = new Set([
  "fanfic_create", "continuation_import", "spinoff_create", "imitation_create", "import_chapters",
  "script_create", "storyboard_create", "interactive_film_create", "translation_create",
  "draft_structure", "connect_choice", "remove_node",
]);

const STUDIO_PROPOSAL_ACTIONS = ["create_book", "short_run", "generate_cover", "play_start"];
const STUDIO_SUB_AGENTS = ["auditor", "reviser", "exporter"];
const STUDIO_REVISION_MODES = ["spot-fix", "polish", "rewrite", "rework"];

type Tool = Parameters<NonNullable<AgentSessionConfig["transformTools"]>>[0][number];

function restrictValues(tool: Tool, field: string, values: readonly string[]): Tool {
  const original = tool.parameters.properties[field];
  const choices = original.anyOf as Array<{ const?: string }> | undefined;
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties,
        [field]: choices
          ? { ...original, anyOf: choices.filter((choice) => values.includes(choice.const ?? "")) }
          : original,
      },
    },
    async execute(...args) {
      const value = args[1]?.[field];
      if (value !== undefined && !values.includes(value)) {
        throw new Error(STUDIO_FEATURE_RETIRED_MESSAGE);
      }
      return tool.execute(...args);
    },
  };
}

/** Apply before exposing tools, and validate execution even if a model repeats an old call. */
export const applyStudioFeaturePolicy: NonNullable<AgentSessionConfig["transformTools"]> = (tools) => (
  tools.filter((tool) => !RETIRED_TOOLS.has(tool.name)).map((tool) => {
    if (tool.name === "propose_action") {
      const restricted = restrictValues(tool, "action", STUDIO_PROPOSAL_ACTIONS);
      const allowedFields = new Set(["action", "instruction", "title", "summary", "createBook", "shortRun", "generateCover", "playStart"]);
      return {
        ...restricted,
        parameters: {
          ...restricted.parameters,
          properties: Object.fromEntries(Object.entries(restricted.parameters.properties).filter(([field]) => allowedFields.has(field))),
        },
      };
    }
    if (tool.name === "sub_agent") {
      return restrictValues(restrictValues(tool, "agent", STUDIO_SUB_AGENTS), "mode", STUDIO_REVISION_MODES);
    }
    return tool;
  })
);

export const STUDIO_FEATURE_POLICY_PROMPT = [
  "Lightbound product scope: long fiction uses 问心 → 研墨 → 织卷 → 落笔. Short fiction and covers remain available.",
  "Do not propose or run retired fanfiction, continuation import, spinoff, imitation, scripts, storyboards, interactive films, translation, AI detection, market radar, or automatic multi-chapter writing.",
  "Source files for long fiction go through 问心. Direct the author to 落笔 for new chapters. The available tool schema is authoritative over legacy feature descriptions above.",
].join("\n");
