/** SPDX-License-Identifier: AGPL-3.0-only */
import { expect, it, vi } from "vitest";
const post = vi.hoisted(() => vi.fn());
vi.mock("../hooks/use-api", () => ({ postApi: post }));
import { ensureAskDraft } from "./ensure-ask-draft";

it("keeps imported sources and the canon panel on the same draft during concurrent initialization", async () => {
  let finish!: (value: { draftId: string }) => void;
  post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const canon = ensureAskDraft("same-session");
  const imports = ensureAskDraft("same-session");
  expect(post).toHaveBeenCalledTimes(1);
  expect(canon).toBe(imports);
  finish({ draftId: "same-draft" });
  await expect(imports).resolves.toEqual({ draftId: "same-draft" });
});
