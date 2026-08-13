import { createHash } from "node:crypto";

import {
  latestManusV2TaskState,
  latestManusV2WaitingDetail,
  manusV2EventUserText,
  manusV2EventsContainOperationToken,
  type ManusV2KnowledgeBaseOperationContract,
  type ManusV2MessageEvent,
} from "./manus-v2-client";

export type KnowledgeBaseManusV2LifecycleState =
  | { kind: "poll"; taskStatus: "running" }
  | { kind: "stopped"; taskStatus: "stopped" }
  | {
      kind: "recover_error";
      taskStatus: "error";
      recoveryToken: string;
      prompt: string;
      requestHash: string;
    }
  | {
      kind: "ask_user_continue";
      taskStatus: "waiting";
      eventId: string;
      eventType: "messageAskUser";
      statusEventId: string;
      continuationToken: string;
      prompt: string;
      requestHash: string;
    }
  | {
      kind: "confirm_safe";
      taskStatus: "waiting";
      eventId: string;
      eventType: string;
      statusEventId: string;
      confirmationInput: Record<string, unknown>;
      requestHash: string;
    }
  | {
      kind: "attention_required";
      taskStatus: "waiting" | "error" | "unknown";
      code: string;
      eventId?: string;
      eventType?: string;
    };

const NEVER_AUTO_CONFIRM =
  /(?:browser|gmail|outlook|mail|deploy|terminal|calendar|marketing|secret|oauth|connector|credit|payment|purchase|publish|send|delete|update|create|video|webdev)/iu;
const SAFE_INTERNAL_EVENT_TYPES = new Set(["mapreduceAction"]);

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * We auto-confirm only a narrow allow-list of internal, reversible knowledge
 * processing actions. Even allow-listed events must expose exactly an
 * `accept: boolean` schema; unknown/new provider fields fail closed locally.
 */
export function safeKnowledgeBaseConfirmationInput(input: {
  eventType: string;
  confirmInputSchema: Record<string, unknown> | null;
}) {
  if (
    NEVER_AUTO_CONFIRM.test(input.eventType) ||
    !SAFE_INTERNAL_EVENT_TYPES.has(input.eventType)
  ) {
    return null;
  }
  const schema = input.confirmInputSchema;
  const properties = record(schema?.properties);
  const accept = record(properties?.accept);
  const required = Array.isArray(schema?.required) ? schema.required : [];
  if (
    schema?.type !== "object" ||
    !properties ||
    Object.keys(properties).some((key) => key !== "accept") ||
    accept?.type !== "boolean" ||
    required.some((key) => key !== "accept")
  ) {
    return null;
  }
  return { accept: true };
}

function continuationPrompt(
  contract: ManusV2KnowledgeBaseOperationContract,
  waiting: { eventId: string; eventType: string },
) {
  const continuationToken = sha256({
    purpose: "waiting_continuation",
    operationToken: contract.operationToken,
    turnId: contract.turnId,
    generation: contract.generation,
    baseRevision: contract.baseRevision,
    fromLeafId: contract.fromLeafId,
    eventId: waiting.eventId,
    eventType: waiting.eventType,
  });
  return [
    "Continue the already-frozen FrontMind knowledge-base operation.",
    "Do not start a new business action and do not change its coordinates.",
    "Use the structured output schema already requested for this operation.",
    `FRONTMIND_MANUS_V2_WAIT_CONTINUE=${JSON.stringify({
      continuationToken,
      operationToken: contract.operationToken,
      turnId: contract.turnId,
      generation: contract.generation,
      baseRevision: contract.baseRevision,
      fromLeafId: contract.fromLeafId,
      eventId: waiting.eventId,
      eventType: waiting.eventType,
    })}`,
  ].join("\n");
}

const MANUS_V2_WAIT_CONTINUE_LINE =
  /^FRONTMIND_MANUS_V2_WAIT_CONTINUE=(\{[^\r\n]+\})\s*$/mu;
const MANUS_V2_FORMAT_REPAIR_LINE =
  /^FRONTMIND_MANUS_V2_FORMAT_REPAIR=(\{[^\r\n]+\})\s*$/mu;

function eventsContainExactPromptToken(
  events: ReadonlyArray<ManusV2MessageEvent>,
  pattern: RegExp,
  field: string,
  token: string,
) {
  return events.some((event) => {
    const text = manusV2EventUserText(event);
    const candidate = text ? pattern.exec(text)?.[1] : undefined;
    if (!candidate) return false;
    try {
      return record(JSON.parse(candidate))?.[field] === token;
    } catch {
      return false;
    }
  });
}

export function manusV2EventsContainWaitingContinuationToken(
  events: ReadonlyArray<ManusV2MessageEvent>,
  continuationToken: string,
) {
  return eventsContainExactPromptToken(
    events,
    MANUS_V2_WAIT_CONTINUE_LINE,
    "continuationToken",
    continuationToken,
  );
}

export function manusV2EventsContainFormatRepairToken(
  events: ReadonlyArray<ManusV2MessageEvent>,
  repairToken: string,
) {
  return eventsContainExactPromptToken(
    events,
    MANUS_V2_FORMAT_REPAIR_LINE,
    "repairToken",
    repairToken,
  );
}

function compareEvents(left: ManusV2MessageEvent, right: ManusV2MessageEvent) {
  return left.timestamp - right.timestamp || left.id.localeCompare(right.id);
}

/** A confirmAction is settled only by a provider status after its wait. */
export function manusV2WaitingEventHasSuccessorEvidence(input: {
  events: ReadonlyArray<ManusV2MessageEvent>;
  eventId: string;
  statusEventId?: string;
}) {
  const ordered = [...input.events].sort(compareEvents);
  const waitingStatus = ordered.find((event) => {
    if (input.statusEventId && event.id === input.statusEventId) return true;
    if (event.type !== "status_update") return false;
    const update = record(event.status_update);
    const detail = record(update?.status_detail);
    return (
      update?.agent_status === "waiting" &&
      detail?.waiting_for_event_id === input.eventId
    );
  });
  if (!waitingStatus) return false;
  return ordered.some((event) => {
    if (compareEvents(event, waitingStatus) <= 0 || event.type !== "status_update") {
      return false;
    }
    const update = record(event.status_update);
    if (!update || typeof update.agent_status !== "string") return false;
    if (update.agent_status !== "waiting") return true;
    return (
      record(update.status_detail)?.waiting_for_event_id !== input.eventId
    );
  });
}

export function manusV2WaitingEventIsStrictSuccessor(input: {
  events: ReadonlyArray<ManusV2MessageEvent>;
  previousEventId: string;
  previousStatusEventId?: string;
  nextEventId: string;
  nextStatusEventId: string;
}) {
  if (input.previousEventId === input.nextEventId) return false;
  const ordered = [...input.events].sort(compareEvents);
  const previous = ordered.find((event) => {
    if (input.previousStatusEventId && event.id === input.previousStatusEventId) {
      return true;
    }
    if (event.type !== "status_update") return false;
    const update = record(event.status_update);
    return (
      update?.agent_status === "waiting" &&
      record(update.status_detail)?.waiting_for_event_id ===
        input.previousEventId
    );
  });
  const next = ordered.find((event) => {
    if (
      event.id !== input.nextStatusEventId ||
      event.type !== "status_update"
    ) {
      return false;
    }
    const update = record(event.status_update);
    return (
      update?.agent_status === "waiting" &&
      record(update.status_detail)?.waiting_for_event_id === input.nextEventId
    );
  });
  return Boolean(previous && next && compareEvents(next, previous) > 0);
}

export function classifyKnowledgeBaseManusV2WaitingAttempt(input: {
  attemptState?: "sending" | "acknowledged" | "outcome_unknown";
  action: "ask_user_continue" | "confirm_safe";
  eventId: string;
  statusEventId?: string;
  continuationToken?: string;
  events: ReadonlyArray<ManusV2MessageEvent>;
}) {
  if (!input.attemptState) return "send" as const;
  if (input.attemptState === "acknowledged") return "settled" as const;
  if (input.action === "ask_user_continue") {
    return input.continuationToken &&
      manusV2EventsContainWaitingContinuationToken(
        input.events,
        input.continuationToken,
      )
      ? ("adopt" as const)
      : ("wait" as const);
  }
  return manusV2WaitingEventHasSuccessorEvidence(input)
    ? ("adopt" as const)
    : ("attention_required" as const);
}

export function classifyKnowledgeBaseManusV2FormatRepairAttempt(input: {
  attemptState?: "sending" | "acknowledged" | "outcome_unknown";
  repairToken: string;
  events: ReadonlyArray<ManusV2MessageEvent>;
}) {
  if (!input.attemptState) return "send" as const;
  if (input.attemptState === "acknowledged") return "exhausted" as const;
  return manusV2EventsContainFormatRepairToken(input.events, input.repairToken)
    ? ("adopt" as const)
    : ("attention_required" as const);
}

const MANUS_V2_ERROR_RECOVERY_LINE =
  /^FRONTMIND_MANUS_V2_ERROR_RECOVERY=(\{[^\r\n]+\})\s*$/mu;

function errorRecoveryToken(
  contract: ManusV2KnowledgeBaseOperationContract,
) {
  return sha256({
    purpose: "task_error_recovery",
    operationToken: contract.operationToken,
    turnId: contract.turnId,
    generation: contract.generation,
    baseRevision: contract.baseRevision,
    fromLeafId: contract.fromLeafId,
  });
}

function errorRecoveryPrompt(
  contract: ManusV2KnowledgeBaseOperationContract,
  recoveryToken: string,
) {
  return [
    "Recover the already-frozen FrontMind knowledge-base operation after the task error.",
    "Continue on this same task. Do not start a new business action, change coordinates, or repeat completed external work.",
    "Return the original operation's result under the supplied structured output schema and original operationToken.",
    `FRONTMIND_MANUS_V2_ERROR_RECOVERY=${JSON.stringify({
      recoveryToken,
      operationToken: contract.operationToken,
      turnId: contract.turnId,
      generation: contract.generation,
      baseRevision: contract.baseRevision,
      fromLeafId: contract.fromLeafId,
    })}`,
  ].join("\n");
}

export function buildKnowledgeBaseManusV2ErrorRecovery(
  contract: ManusV2KnowledgeBaseOperationContract,
) {
  const recoveryToken = errorRecoveryToken(contract);
  const prompt = errorRecoveryPrompt(contract, recoveryToken);
  return {
    recoveryToken,
    prompt,
    requestHash: sha256({
      taskAction: "task.sendMessage",
      taskIdPolicy: "same_canonical_task",
      prompt,
    }),
  };
}

export function buildKnowledgeBaseManusV2AnchorErrorRecovery(input: {
  operationToken: string;
  turnId: string;
  generation: number;
  baseRevision: number;
}) {
  const recoveryToken = sha256({
    purpose: "anchor_task_error_recovery",
    ...input,
  });
  const prompt = [
    "Recover the self-contained FrontMind canonical-task handoff on this same task.",
    "Re-read the frozen handoff snapshot already present in this task. Do not create another task, advance customer content, or perform external work.",
    "Return only the exact handoff acknowledgement under the supplied structured output schema and frozen coordinates.",
    `FRONTMIND_MANUS_V2_ERROR_RECOVERY=${JSON.stringify({
      recoveryToken,
      ...input,
      handoffAccepted: true,
    })}`,
  ].join("\n");
  return {
    recoveryToken,
    prompt,
    requestHash: sha256({
      taskAction: "task.sendMessage",
      taskIdPolicy: "same_canonical_task",
      purpose: "anchor_task_error_recovery",
      prompt,
    }),
  };
}

export function manusV2EventsContainErrorRecoveryToken(
  events: ReadonlyArray<ManusV2MessageEvent>,
  recoveryToken: string,
) {
  return events.some((event) => {
    const text = manusV2EventUserText(event);
    const candidate = text
      ? MANUS_V2_ERROR_RECOVERY_LINE.exec(text)?.[1]
      : undefined;
    if (!candidate) return false;
    try {
      const value = record(JSON.parse(candidate));
      return value?.recoveryToken === recoveryToken;
    } catch {
      return false;
    }
  });
}

export type KnowledgeBaseManusV2ErrorRecoveryAttemptState =
  | "sending"
  | "acknowledged"
  | "outcome_unknown"
  | "retry_wait"
  | "rejected";

const MAX_ERROR_RECOVERY_REJECTIONS = 3;

export function knowledgeBaseManusV2ErrorRecoveryRejection(input: {
  previousCount?: number;
  retryable: boolean;
  retryAfterMs?: number | null;
  recoveryToken: string;
}) {
  const attempt = Math.max(0, Math.trunc(input.previousCount ?? 0)) + 1;
  if (!input.retryable || attempt > MAX_ERROR_RECOVERY_REJECTIONS) {
    return { retry: false as const, attempt };
  }
  if (input.retryAfterMs !== undefined && input.retryAfterMs !== null) {
    return {
      retry: true as const,
      attempt,
      delayMs: Math.min(
        60 * 60 * 1_000,
        Math.max(0, Math.trunc(input.retryAfterMs)),
      ),
    };
  }
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
  const jitter =
    parseInt(sha256({ recoveryToken: input.recoveryToken, attempt }).slice(0, 2), 16) %
    21;
  return {
    retry: true as const,
    attempt,
    delayMs: base + Math.floor((base * jitter) / 100),
  };
}

/**
 * A journaled send is never replayed. A lost response can only be adopted
 * from the exact recovery token in provider history; absence is not proof
 * that the message was rejected.
 */
export function classifyKnowledgeBaseManusV2ErrorRecoveryAttempt(input: {
  attemptState?: KnowledgeBaseManusV2ErrorRecoveryAttemptState;
  recoveryToken: string;
  events: ReadonlyArray<ManusV2MessageEvent>;
  nextRetryAt?: string;
  now?: Date;
}) {
  if (!input.attemptState) return "send" as const;
  if (input.attemptState === "rejected") return "attention_required" as const;
  if (input.attemptState === "retry_wait") {
    const nextRetryAt = Date.parse(input.nextRetryAt || "");
    return Number.isFinite(nextRetryAt) &&
      nextRetryAt <= (input.now ?? new Date()).getTime()
      ? ("send" as const)
      : ("wait" as const);
  }
  const ordered = [...input.events].sort(
    (left, right) =>
      right.timestamp - left.timestamp || right.id.localeCompare(left.id),
  );
  const recoveryEvent = ordered.find((event) =>
    manusV2EventsContainErrorRecoveryToken([event], input.recoveryToken),
  );
  if (recoveryEvent) {
    const latestStatus = ordered.find((event) => event.type === "status_update");
    if (
      latestStatus &&
      (latestStatus.timestamp > recoveryEvent.timestamp ||
        (latestStatus.timestamp === recoveryEvent.timestamp &&
          latestStatus.id.localeCompare(recoveryEvent.id) > 0)) &&
      latestManusV2TaskState([latestStatus]) === "error"
    ) {
      return "attention_required" as const;
    }
    if (input.attemptState !== "acknowledged") return "adopt" as const;
  }
  return "wait" as const;
}

export function classifyKnowledgeBaseManusV2Lifecycle(input: {
  events: ReadonlyArray<ManusV2MessageEvent>;
  contract: ManusV2KnowledgeBaseOperationContract;
}): KnowledgeBaseManusV2LifecycleState {
  const state = latestManusV2TaskState(input.events) || "running";
  if (state === "running") return { kind: "poll", taskStatus: "running" };
  if (state === "stopped") return { kind: "stopped", taskStatus: "stopped" };
  if (state === "error") {
    const ordered = [...input.events].sort(
      (left, right) =>
        right.timestamp - left.timestamp || right.id.localeCompare(left.id),
    );
    const statusEvent = ordered.find((event) => event.type === "status_update");
    const operationEvent = ordered.find(
      (event) =>
        event.type === "user_message" &&
        manusV2EventsContainOperationToken(
          [event],
          input.contract.operationToken,
        ),
    );
    if (
      !statusEvent ||
      !operationEvent ||
      statusEvent.timestamp < operationEvent.timestamp
    ) {
      return {
        kind: "attention_required",
        taskStatus: "error",
        code: "MANUS_V2_TASK_ERROR_NOT_ATTRIBUTED",
      };
    }
    const recovery = buildKnowledgeBaseManusV2ErrorRecovery(input.contract);
    return {
      kind: "recover_error",
      taskStatus: "error",
      ...recovery,
    };
  }
  if (state !== "waiting") {
    return {
      kind: "attention_required",
      taskStatus: "unknown",
      code: "MANUS_V2_UNKNOWN_TASK_STATE",
    };
  }
  const waiting = latestManusV2WaitingDetail(input.events);
  if (!waiting) {
    return {
      kind: "attention_required",
      taskStatus: "waiting",
      code: "MANUS_V2_WAITING_DETAIL_INVALID",
    };
  }
  const statusEvent = input.events.find(
    (event) => event.id === waiting.statusEventId,
  );
  const operationEvent = [...input.events]
    .filter(
      (event) =>
        event.type === "user_message" &&
        manusV2EventsContainOperationToken(
          [event],
          input.contract.operationToken,
        ),
    )
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp || right.id.localeCompare(left.id),
    )[0];
  if (
    !statusEvent ||
    !operationEvent ||
    statusEvent.timestamp < operationEvent.timestamp
  ) {
    return {
      kind: "attention_required",
      taskStatus: "waiting",
      code: "MANUS_V2_WAITING_NOT_ATTRIBUTED",
      eventId: waiting.eventId,
      eventType: waiting.eventType,
    };
  }
  if (waiting.eventType === "messageAskUser") {
    const prompt = continuationPrompt(input.contract, waiting);
    const continuationToken = sha256({
      purpose: "waiting_continuation",
      operationToken: input.contract.operationToken,
      turnId: input.contract.turnId,
      generation: input.contract.generation,
      baseRevision: input.contract.baseRevision,
      fromLeafId: input.contract.fromLeafId,
      eventId: waiting.eventId,
      eventType: waiting.eventType,
    });
    return {
      kind: "ask_user_continue",
      taskStatus: "waiting",
      eventId: waiting.eventId,
      eventType: "messageAskUser",
      statusEventId: waiting.statusEventId,
      continuationToken,
      prompt,
      requestHash: sha256({
        taskAction: "task.sendMessage",
        eventId: waiting.eventId,
        prompt,
      }),
    };
  }
  const confirmationInput = safeKnowledgeBaseConfirmationInput(waiting);
  if (!confirmationInput) {
    return {
      kind: "attention_required",
      taskStatus: "waiting",
      code: "MANUS_V2_EXTERNAL_CONFIRMATION_REQUIRED",
      eventId: waiting.eventId,
      eventType: waiting.eventType,
    };
  }
  return {
    kind: "confirm_safe",
    taskStatus: "waiting",
    eventId: waiting.eventId,
    eventType: waiting.eventType,
    statusEventId: waiting.statusEventId,
    confirmationInput,
    requestHash: sha256({
      taskAction: "task.confirmAction",
      eventId: waiting.eventId,
      eventType: waiting.eventType,
      confirmationInput,
    }),
  };
}

export function buildKnowledgeBaseManusV2FormatRepair(input: {
  contract: ManusV2KnowledgeBaseOperationContract;
  events: ReadonlyArray<ManusV2MessageEvent>;
}) {
  if (
    !manusV2EventsContainOperationToken(
      input.events,
      input.contract.operationToken,
    )
  ) {
    return null;
  }
  const repairToken = sha256({
    purpose: "format_repair",
    operationToken: input.contract.operationToken,
    turnId: input.contract.turnId,
  });
  const prompt = [
    "Repair only the structured output format for the already-completed operation.",
    "Do not redo research, advance a node, create files, or perform any external action.",
    "Return the same business result under the supplied structured output schema and frozen coordinates.",
    `FRONTMIND_MANUS_V2_FORMAT_REPAIR=${JSON.stringify({
      repairToken,
      operationToken: input.contract.operationToken,
      turnId: input.contract.turnId,
      generation: input.contract.generation,
      baseRevision: input.contract.baseRevision,
      fromLeafId: input.contract.fromLeafId,
    })}`,
  ].join("\n");
  return {
    repairToken,
    prompt,
    requestHash: sha256({ taskAction: "task.sendMessage", prompt }),
  };
}

/** Attribution/transition conflicts are never papered over as formatting. */
export function isRepairableKnowledgeBaseManusV2FormatCode(code: string) {
  return (
    code === "INVALID_CORE_SCHEMA" ||
    code === "UNSUPPORTED_CORE_SCHEMA" ||
    code === "EMPTY_CORE_CONTENT" ||
    code === "INVALID_MANIFEST_JSON" ||
    (code.startsWith("INVALID_") &&
      !["INVALID_PAGINATION", "INVALID_RESPONSE", "INVALID_ACTION"].includes(
        code,
      ))
  );
}
