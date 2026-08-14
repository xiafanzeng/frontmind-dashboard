export const KNOWLEDGE_BASE_PROMPT_CONTRACT_VERSION =
  "kb-v4-authorized-workflow-2026-08-09";

export type KnowledgeBaseOperationTelemetryEvent =
  | "turn_replay_hit"
  | "turn_replay_mismatch"
  | "stale_presentation_submission"
  | "logo_upload_candidate_staged"
  | "logo_upload_candidate_promoted"
  | "logo_upload_candidate_recovered"
  | "logo_upload_candidate_rejected"
  | "initial_logo_accepted"
  | "initial_logo_degraded_to_upload";

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,255}$/u;

function safeIdentifier(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return SAFE_IDENTIFIER.test(normalized) ? normalized : undefined;
}

/**
 * Emit only bounded application state. Customer text, filenames, URLs and
 * provider output are deliberately absent from this API.
 */
export function knowledgeBaseOperationTelemetryRecord(input: {
  event: KnowledgeBaseOperationTelemetryEvent;
  buildId?: string | null;
  turnId?: string | null;
  reasonCode?: string | null;
  adoptedWinner?: boolean;
}) {
  const buildId = safeIdentifier(input.buildId);
  const turnId = safeIdentifier(input.turnId);
  const reasonCode = safeIdentifier(input.reasonCode);
  return {
    event: input.event,
    promptVersion: KNOWLEDGE_BASE_PROMPT_CONTRACT_VERSION,
    ...(buildId ? { buildId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    ...(input.adoptedWinner === true ? { adoptedWinner: true } : {}),
  };
}

export function logKnowledgeBaseOperationTelemetry(
  input: Parameters<typeof knowledgeBaseOperationTelemetryRecord>[0],
) {
  const record = knowledgeBaseOperationTelemetryRecord(input);
  console.info(
    `[KnowledgeBaseOperation] ${record.event}`,
    JSON.stringify(record),
  );
}
