export const KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV =
  "FRONTMIND_KB_MANUS_V2_WRITER";
export const KNOWLEDGE_BASE_MANUS_V2_ACTIVE_MIGRATION_ENV =
  "FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION";

export type KnowledgeBaseProviderProtocol = "legacy_v1" | "manus_v2";

/**
 * Provider-writer rollout authority.
 *
 * Fail closed unless release operators explicitly enable the final writer.
 * This lets the additive schema/read deployment boot without creating a v2
 * task or migrating an active legacy build before the synthetic canary and
 * runtime evidence are complete. No other spelling, whitespace, or casing is
 * accepted, so a malformed rollout value cannot silently select a protocol.
 */
export function knowledgeBaseManusV2WriterEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return exactBooleanRolloutFlag(
    KNOWLEDGE_BASE_MANUS_V2_WRITER_ENV,
    environment,
  );
}

function exactBooleanRolloutFlag(
  name: string,
  environment: NodeJS.ProcessEnv,
): boolean {
  const configured = environment[name];
  if (configured === undefined) return false;
  if (configured === "true") return true;
  if (configured === "false") return false;
  throw new Error(`${name} must be exactly "true" or "false"`);
}

/**
 * Authority to cut over active legacy builds. This is deliberately separate
 * from the new-build writer so enabling a canary cannot migrate customer work.
 */
export function knowledgeBaseManusV2ActiveMigrationEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return exactBooleanRolloutFlag(
    KNOWLEDGE_BASE_MANUS_V2_ACTIVE_MIGRATION_ENV,
    environment,
  );
}

/** A first v2 task.create needs one explicit source of rollout authority. */
export function knowledgeBaseManusV2InitialCreateEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  // Evaluate both flags before combining them so a malformed disabled-path
  // value cannot be hidden by JavaScript short-circuiting.
  const newBuildWriter = knowledgeBaseManusV2WriterEnabled(environment);
  const activeMigration =
    knowledgeBaseManusV2ActiveMigrationEnabled(environment);
  return newBuildWriter || activeMigration;
}

export type KnowledgeBaseManusV2RecoveryAuthority =
  | "initial_create"
  | "forward_on_canonical"
  | "reconcile_only"
  | "deferred_disabled";

/**
 * Side-effect policy for ordinary recovery. Once an operation may have crossed
 * the provider boundary it remains readable/reconcilable with rollout flags
 * off, but an unattempted unbound operation cannot issue its first POST.
 */
export function knowledgeBaseManusV2RecoveryAuthority(input: {
  canonicalTaskId?: string | null;
  createAttemptState?: string | null;
  providerAttemptState?: string | null;
  environment?: NodeJS.ProcessEnv;
}): KnowledgeBaseManusV2RecoveryAuthority {
  const createAttemptState = input.createAttemptState || "not_sent";
  const providerAttemptState = input.providerAttemptState || "not_sent";
  const attempted =
    createAttemptState !== "not_sent" || providerAttemptState !== "not_sent";
  if (attempted) return "reconcile_only";
  if (String(input.canonicalTaskId || "").trim()) {
    return "forward_on_canonical";
  }
  return knowledgeBaseManusV2InitialCreateEnabled(input.environment)
    ? "initial_create"
    : "deferred_disabled";
}

/** Selects only newly inserted builds; persisted builds remain authoritative. */
export function knowledgeBaseNewBuildProviderProtocol(
  environment: NodeJS.ProcessEnv = process.env,
): KnowledgeBaseProviderProtocol {
  return knowledgeBaseManusV2WriterEnabled(environment)
    ? "manus_v2"
    : "legacy_v1";
}
