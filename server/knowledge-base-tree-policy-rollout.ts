import {
  KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP,
  KNOWLEDGE_BASE_TREE_POLICY_VERSION_LEGACY,
  type KnowledgeBaseTreePolicyVersion,
} from "./knowledge-base-progress";

export const KNOWLEDGE_BASE_TREE_POLICY_V2_WRITER_ENV =
  "FRONTMIND_KB_TREE_POLICY_V2_WRITER";

/** Immutable v4 archive that implements the historical 8–115 contract. */
export const KNOWLEDGE_BASE_TREE_POLICY_V1_SKILL_CONTENT_HASH =
  "a619a6eb2d21147ebccecbf023171834bab34d46e26d40ac44e8fc98785f8472";

/** Immutable v4 archive that implements the deep 30–115 contract. */
export const KNOWLEDGE_BASE_TREE_POLICY_V2_SKILL_CONTENT_HASH =
  "5e0487004c604c0b95feae0c19ee9544a7e82b10ca923ca6c779ed240f333f56";

export function knowledgeBaseSkillContentHashForTreePolicy(
  treePolicyVersion: KnowledgeBaseTreePolicyVersion,
) {
  if (treePolicyVersion === KNOWLEDGE_BASE_TREE_POLICY_VERSION_LEGACY) {
    return KNOWLEDGE_BASE_TREE_POLICY_V1_SKILL_CONTENT_HASH;
  }
  if (treePolicyVersion === KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP) {
    return KNOWLEDGE_BASE_TREE_POLICY_V2_SKILL_CONTENT_HASH;
  }
  throw new Error("Knowledge-base tree policy version is invalid");
}

/**
 * Select only the policy for a newly inserted build. Existing builds always
 * keep their durable treePolicyVersion, so disabling this writer is an
 * additive rollback and never needs a down migration or historical rewrite.
 *
 * The final product contract is enabled by default in both Dev and production;
 * release operators can explicitly set `false` while deploying the
 * compatibility reader/migration stage, then switch to `true` after health
 * evidence is complete.
 */
export function knowledgeBaseNewBuildTreePolicyVersion(
  environment: NodeJS.ProcessEnv = process.env,
): KnowledgeBaseTreePolicyVersion {
  const configured = String(
    environment[KNOWLEDGE_BASE_TREE_POLICY_V2_WRITER_ENV] || "true",
  )
    .trim()
    .toLowerCase();
  if (configured === "true") {
    return KNOWLEDGE_BASE_TREE_POLICY_VERSION_DEEP;
  }
  if (configured === "false") {
    return KNOWLEDGE_BASE_TREE_POLICY_VERSION_LEGACY;
  }
  throw new Error(
    `${KNOWLEDGE_BASE_TREE_POLICY_V2_WRITER_ENV} must be true or false`,
  );
}

/**
 * Select the new-build policy and its immutable Skill in one operation. The
 * caller must commit both values to the same build row; choosing `latest`
 * independently would make the migration-stage v1 rollback run the v2 Skill.
 */
export function knowledgeBaseNewBuildPolicyBinding(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const treePolicyVersion = knowledgeBaseNewBuildTreePolicyVersion(environment);
  return {
    treePolicyVersion,
    skillVersion: "4" as const,
    skillContentHash:
      knowledgeBaseSkillContentHashForTreePolicy(treePolicyVersion),
  };
}
