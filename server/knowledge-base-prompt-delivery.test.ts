import { describe, expect, it } from "vitest";

import { buildKnowledgeBaseInstructionDelivery } from "./knowledge-base-prompt-delivery";
import {
  assertUpstreamPromptBudget,
  FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
  UpstreamPromptBudgetError,
  upstreamPromptCharacterCount,
} from "./upstream-prompt-budget";

describe("upstream prompt delivery", () => {
  it("keeps the bootstrap under 3000 characters while preserving full instructions", () => {
    const instructions = "完整规则。".repeat(2_000);
    const delivery = buildKnowledgeBaseInstructionDelivery({
      instructions,
      skillVersion: "4",
      operationId: "operation-1",
      turnId: "turn-1",
    });
    expect(upstreamPromptCharacterCount(delivery.prompt)).toBeLessThanOrEqual(
      FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
    );
    expect(delivery.bytes.toString("utf8")).toBe(instructions);
    expect(delivery.prompt).toContain("不是客户补料");
    expect(delivery.prompt).toContain("不得因此改变服务端已给定的动作");
  });

  it("fails closed instead of allowing an oversized main prompt", () => {
    expect(() => assertUpstreamPromptBudget("字".repeat(3_001))).toThrow(
      UpstreamPromptBudgetError,
    );
  });
});
