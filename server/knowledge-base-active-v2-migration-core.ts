import { classifyManusV2StructuredResultEnvelope } from "./manus-v2-structured-result";

export type KnowledgeBaseAnchorCreateAttempt =
  | "not_sent"
  | "sending"
  | "outcome_unknown"
  | "output_pending";

export type KnowledgeBaseAnchorTaskMatch = {
  id: string;
  taskUrl: string | null;
  requestId?: string | null;
};

export type KnowledgeBaseAnchorAcknowledgement = {
  eventId: string;
  schemaVersion: 1;
  operationToken: string;
  turnId: string;
  generation: number;
  baseRevision: number;
  handoffAccepted: true;
};

export type KnowledgeBaseAnchorAcknowledgementExpectation = Omit<
  KnowledgeBaseAnchorAcknowledgement,
  "eventId" | "schemaVersion" | "handoffAccepted"
>;

export type KnowledgeBaseAnchorAcknowledgementInspection =
  | { kind: "accepted"; acknowledgement: KnowledgeBaseAnchorAcknowledgement }
  | { kind: "missing" }
  | { kind: "malformed"; code: string };

export type KnowledgeBaseAnchorAcknowledgementSettlement =
  | { state: "completed" }
  | { state: "output_pending" }
  | { state: "attention_required"; code: string };

export type KnowledgeBaseAnchorSettlementState =
  | "completed"
  | "output_pending"
  | "attention_required";

export type KnowledgeBaseAnchorCreateFailure =
  | "outcome_unknown"
  | "retryable_rejection"
  | "terminal_rejection"
  | "other";

export type KnowledgeBaseAnchorCredentialMode =
  | "legacy_task_owner"
  | "current_unbound"
  | "current_rebind";

export type KnowledgeBaseCanonicalCredentialRebindDisposition =
  | "rebind_anchor"
  | "active_operation"
  | "credential_still_available"
  | "excluded";

/**
 * A v2 anchor may move to a new generation only when local rows prove that
 * the exact credential which owns the current canonical task was permanently
 * deleted. Merely rotating that credential to `retired`, losing a poll, or
 * observing an active turn is never authority to abandon the old anchor.
 */
export function classifyKnowledgeBaseCanonicalCredentialRebind(input: {
  providerProtocol: string | null;
  status: string | null;
  activeTurnId: string | null;
  canonicalTaskId: string | null;
  canonicalTaskGeneration: number | null;
  canonicalCredentialId: string | null;
  canonicalTaskState: string | null;
  protocolErrorCode?: string | null;
  generation: number;
  credentialStatus: string | null;
  resourceTaskId: string | null;
  resourceCredentialId: string | null;
  resourceUserId: number | null;
  userId: number;
  resourceProjectAssignmentId: string | null;
  conversationProjectAssignmentId: string | null;
}): KnowledgeBaseCanonicalCredentialRebindDisposition {
  if (
    input.providerProtocol !== "manus_v2" ||
    input.status !== "confirming" ||
    !input.canonicalTaskId ||
    !input.canonicalCredentialId ||
    input.canonicalTaskGeneration !== input.generation ||
    !(
      input.canonicalTaskState === "active" ||
      (input.canonicalTaskState === "attention_required" &&
        input.protocolErrorCode === "MANUS_V2_CANONICAL_CREDENTIAL_UNAVAILABLE")
    ) ||
    input.resourceTaskId !== input.canonicalTaskId ||
    input.resourceCredentialId !== input.canonicalCredentialId ||
    input.resourceUserId !== input.userId ||
    input.resourceProjectAssignmentId !== input.conversationProjectAssignmentId
  ) {
    return "excluded";
  }
  if (input.activeTurnId) return "active_operation";
  if (input.credentialStatus !== "deleted") {
    return input.credentialStatus === "active" ||
      input.credentialStatus === "retired"
      ? "credential_still_available"
      : "excluded";
  }
  return "rebind_anchor";
}

/**
 * Losing permanent access to an old task is the only anchor-only migration
 * case that changes generation. The old accepted generation remains the
 * explicit receipt source; ordinary key rotation keeps the same generation.
 */
export function planKnowledgeBaseAnchorGeneration(input: {
  sourceGeneration: number;
  credentialMode: KnowledgeBaseAnchorCredentialMode;
}) {
  const targetGeneration =
    input.credentialMode === "current_rebind"
      ? input.sourceGeneration + 1
      : input.sourceGeneration;
  return {
    sourceGeneration: input.sourceGeneration,
    targetGeneration,
    receiptSourceGeneration:
      targetGeneration > input.sourceGeneration
        ? input.sourceGeneration
        : (null as number | null),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decodedRecord(value: unknown) {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return null;
    }
  }
  return record(decoded);
}

/**
 * Selects only the acknowledgement for this exact hidden migration operation.
 * Historical structured results are ignored. Once the current token is found,
 * stale coordinates are an attributed malformed result, never a success.
 */
export function inspectKnowledgeBaseAnchorAcknowledgement(input: {
  events: ReadonlyArray<Record<string, unknown>>;
  expected: KnowledgeBaseAnchorAcknowledgementExpectation;
}): KnowledgeBaseAnchorAcknowledgementInspection {
  const candidates = [...input.events]
    .filter((event) => event.type === "structured_output_result")
    .sort((left, right) => {
      const leftTimestamp = Number(left.timestamp);
      const rightTimestamp = Number(right.timestamp);
      return (
        (Number.isFinite(rightTimestamp) ? rightTimestamp : 0) -
          (Number.isFinite(leftTimestamp) ? leftTimestamp : 0) ||
        String(right.id || "").localeCompare(String(left.id || ""))
      );
    });
  for (const event of candidates) {
    const result = classifyManusV2StructuredResultEnvelope(
      event.structured_output_result,
    );
    if (result.kind !== "accepted") continue;
    const value = decodedRecord(result.value);
    if (!value || value.operationToken !== input.expected.operationToken) {
      continue;
    }
    if (
      value.schemaVersion !== 1 ||
      value.turnId !== input.expected.turnId ||
      value.generation !== input.expected.generation ||
      value.baseRevision !== input.expected.baseRevision ||
      value.handoffAccepted !== true
    ) {
      return { kind: "malformed", code: "ANCHOR_ACK_COORDINATE_CONFLICT" };
    }
    const eventId = typeof event.id === "string" ? event.id.trim() : "";
    if (!eventId) {
      return { kind: "malformed", code: "ANCHOR_ACK_EVENT_ID_INVALID" };
    }
    return {
      kind: "accepted",
      acknowledgement: {
        eventId,
        schemaVersion: 1,
        operationToken: input.expected.operationToken,
        turnId: input.expected.turnId,
        generation: input.expected.generation,
        baseRevision: input.expected.baseRevision,
        handoffAccepted: true,
      },
    };
  }
  return { kind: "missing" };
}

/** Pure settlement policy shared by the migration dispatcher and its matrix. */
export function classifyKnowledgeBaseAnchorAcknowledgementSettlement(input: {
  inspection: KnowledgeBaseAnchorAcknowledgementInspection;
  taskStatus: string;
}): KnowledgeBaseAnchorAcknowledgementSettlement {
  if (input.inspection.kind === "accepted") return { state: "completed" };
  if (input.inspection.kind === "malformed") {
    return { state: "attention_required", code: input.inspection.code };
  }
  if (input.taskStatus === "running") return { state: "output_pending" };
  return {
    state: "attention_required",
    code:
      input.taskStatus === "error"
        ? "MANUS_V2_ANCHOR_TASK_ERROR"
        : input.taskStatus === "stopped"
          ? "MANUS_V2_ANCHOR_ACK_MISSING"
          : "MANUS_V2_ANCHOR_ACK_NOT_PROVABLE",
  };
}

/**
 * Provider-independent at-most-once kernel for an anchor-only handoff.
 * Every state after `not_sent` is read/reconcile-only; zero or multiple
 * matches are deliberately inert and can never authorize another create.
 */
export async function executeKnowledgeBaseAnchorHandoff(input: {
  attempt: KnowledgeBaseAnchorCreateAttempt;
  canonicalTask?: KnowledgeBaseAnchorTaskMatch | null;
  beginCreate: () => Promise<void>;
  createTask: () => Promise<KnowledgeBaseAnchorTaskMatch>;
  reconcileCreate: () => Promise<readonly KnowledgeBaseAnchorTaskMatch[]>;
  bindTask: (task: KnowledgeBaseAnchorTaskMatch) => Promise<void>;
  settleAcknowledgement: (
    task: KnowledgeBaseAnchorTaskMatch,
  ) => Promise<KnowledgeBaseAnchorSettlementState>;
  classifyCreateFailure: (error: unknown) => KnowledgeBaseAnchorCreateFailure;
  markOutcomeUnknown: () => Promise<void>;
  markRetryableRejection: (error: unknown) => Promise<void>;
  markTerminalRejection: () => Promise<void>;
}) {
  const settle = async (
    task: KnowledgeBaseAnchorTaskMatch,
    source: "canonical" | "created" | "adopted",
  ) => ({
    state: await input.settleAcknowledgement(task),
    source,
    task,
  });
  if (input.canonicalTask) {
    return settle(input.canonicalTask, "canonical");
  }

  if (input.attempt === "not_sent") {
    // `beginCreate` is the durable CAS writer fence and must commit before the
    // only provider POST. A racing worker that loses it never reaches create.
    await input.beginCreate();
    let created: KnowledgeBaseAnchorTaskMatch;
    try {
      created = await input.createTask();
    } catch (error) {
      switch (input.classifyCreateFailure(error)) {
        case "outcome_unknown":
          await input.markOutcomeUnknown();
          break;
        case "retryable_rejection":
          await input.markRetryableRejection(error);
          break;
        case "terminal_rejection":
          await input.markTerminalRejection();
          break;
        case "other":
          break;
      }
      throw error;
    }
    await input.bindTask(created);
    return settle(created, "created");
  }

  const matches = await input.reconcileCreate();
  if (matches.length !== 1) {
    return {
      state: "reconciling" as const,
      source: "provider_history" as const,
      matchCount: matches.length,
    };
  }
  const adopted = matches[0]!;
  await input.bindTask(adopted);
  return settle(adopted, "adopted");
}
