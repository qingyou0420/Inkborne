export type AuthoringRoleId =
  | "ask.main"
  | "ask.review"
  | "ground.main"
  | "ground.review"
  | "weave.main"
  | "weave.review"
  | "write.main"
  | "write.review";

export const AUTHORING_ROLE_ORDER: readonly AuthoringRoleId[] = [
  "ask.main",
  "ask.review",
  "ground.main",
  "ground.review",
  "weave.main",
  "weave.review",
  "write.main",
  "write.review",
];
