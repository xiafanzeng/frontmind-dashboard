import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_BASE_TREE_POLICY_V1_SKILL_CONTENT_HASH,
  KNOWLEDGE_BASE_TREE_POLICY_V2_SKILL_CONTENT_HASH,
  KNOWLEDGE_BASE_TREE_POLICY_V2_WRITER_ENV,
  knowledgeBaseNewBuildPolicyBinding,
  knowledgeBaseNewBuildTreePolicyVersion,
} from "./knowledge-base-tree-policy-rollout";

describe("knowledge-base tree-policy v2 writer rollout", () => {
  it.each(["development", "production"])(
    "defaults the final %s product contract to v2",
    (nodeEnv) => {
      expect(
        knowledgeBaseNewBuildTreePolicyVersion({ NODE_ENV: nodeEnv }),
      ).toBe(2);
    },
  );

  it("supports an additive writer rollback without changing existing rows", () => {
    expect(
      knowledgeBaseNewBuildTreePolicyVersion({
        [KNOWLEDGE_BASE_TREE_POLICY_V2_WRITER_ENV]: "false",
      }),
    ).toBe(1);
    expect(
      knowledgeBaseNewBuildTreePolicyVersion({
        [KNOWLEDGE_BASE_TREE_POLICY_V2_WRITER_ENV]: "true",
      }),
    ).toBe(2);
  });

  it("binds each writer policy to its immutable v4 Skill archive", () => {
    expect(
      knowledgeBaseNewBuildPolicyBinding({
        [KNOWLEDGE_BASE_TREE_POLICY_V2_WRITER_ENV]: "false",
      }),
    ).toEqual({
      treePolicyVersion: 1,
      skillVersion: "4",
      skillContentHash: KNOWLEDGE_BASE_TREE_POLICY_V1_SKILL_CONTENT_HASH,
    });
    expect(
      knowledgeBaseNewBuildPolicyBinding({
        [KNOWLEDGE_BASE_TREE_POLICY_V2_WRITER_ENV]: "true",
      }),
    ).toEqual({
      treePolicyVersion: 2,
      skillVersion: "4",
      skillContentHash: KNOWLEDGE_BASE_TREE_POLICY_V2_SKILL_CONTENT_HASH,
    });
  });

  it("fails closed on an ambiguous writer configuration", () => {
    expect(() =>
      knowledgeBaseNewBuildTreePolicyVersion({
        [KNOWLEDGE_BASE_TREE_POLICY_V2_WRITER_ENV]: "true",
      }),
    ).not.toThrow();
    expect(() =>
      knowledgeBaseNewBuildTreePolicyVersion({
        [KNOWLEDGE_BASE_TREE_POLICY_V2_WRITER_ENV]: "enabled",
      }),
    ).toThrow(KNOWLEDGE_BASE_TREE_POLICY_V2_WRITER_ENV);
  });
});
