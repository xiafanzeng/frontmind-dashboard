import {
  manusV2EventMatchesGeneralChatRequest,
  orderManusV2EventsByProviderRank,
  type ManusV2MessageEvent,
} from "./manus-v2-client";
import {
  GENERAL_CHAT_PARTIAL_RESULT_MESSAGE,
  GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE,
  generalChatTerminalMessagePublicId,
} from "../shared/frontmind-general-chat-terminal";
import {
  generalChatIncidentStateHash,
  sha256,
} from "./general-chat-incident-repair-20260828-core";

export const GENERAL_CHAT_TERMINAL_1547_REPAIR_ID =
  "frontmind.general-chat.terminal-1547.2026-08-28";
export const GENERAL_CHAT_TERMINAL_1547_INCIDENT = "terminal-1547";
export const GENERAL_CHAT_TERMINAL_1547_ERROR_CODE =
  GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE;
export const GENERAL_CHAT_TERMINAL_1547_PARTIAL_MESSAGE =
  GENERAL_CHAT_PARTIAL_RESULT_MESSAGE;
export const GENERAL_CHAT_TERMINAL_1547_LEGACY_ERRORS = [
  "❌ 错误: 任务未能完成\n\n请求未完成，请稍后手动重试。",
  "❌ 错误: 任务未能完成",
] as const;

/** 15:47 in the incident screenshot is Asia/Shanghai (UTC+08:00). */
export const GENERAL_CHAT_TERMINAL_1547_WINDOW = {
  start: new Date("2026-08-28T07:47:00.000Z"),
  end: new Date("2026-08-28T07:48:00.000Z"),
} as const;

export type GeneralChatTerminal1547RepairCommand =
  | { incident: typeof GENERAL_CHAT_TERMINAL_1547_INCIDENT; mode: "preview" }
  | {
      incident: typeof GENERAL_CHAT_TERMINAL_1547_INCIDENT;
      mode: "apply";
      expectedStateHash: string;
    };

const SHA256 = /^[a-f0-9]{64}$/u;

export function isGeneralChatTerminal1547Command(args: readonly string[]) {
  return args.some(
    (argument) =>
      argument === `--incident=${GENERAL_CHAT_TERMINAL_1547_INCIDENT}`,
  );
}

export function parseGeneralChatTerminal1547RepairCommand(
  args: readonly string[],
): GeneralChatTerminal1547RepairCommand {
  const values = new Map<string, string>();
  for (const argument of args) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || values.has(match[1]!)) {
      throw new Error("GENERAL_CHAT_TERMINAL_1547_ARGUMENT_INVALID");
    }
    values.set(match[1]!, match[2]!);
  }
  if (
    [...values.keys()].some(
      (key) => !["incident", "mode", "expected-state-hash"].includes(key),
    ) ||
    values.get("incident") !== GENERAL_CHAT_TERMINAL_1547_INCIDENT
  ) {
    throw new Error("GENERAL_CHAT_TERMINAL_1547_ARGUMENT_INVALID");
  }
  const mode = values.get("mode");
  if (mode === "preview" && values.size === 2) {
    return { incident: GENERAL_CHAT_TERMINAL_1547_INCIDENT, mode };
  }
  const expectedStateHash = values.get("expected-state-hash");
  if (
    mode === "apply" &&
    values.size === 3 &&
    expectedStateHash &&
    SHA256.test(expectedStateHash)
  ) {
    return {
      incident: GENERAL_CHAT_TERMINAL_1547_INCIDENT,
      mode,
      expectedStateHash,
    };
  }
  throw new Error("GENERAL_CHAT_TERMINAL_1547_ARGUMENT_INVALID");
}

export function generalChatTerminalMessagePersistedId(input: {
  userId: number;
  projectAssignmentId: string | null;
  persistedConversationId: string;
  localTaskId: string;
  errorCode: string;
}) {
  const scoped = generalChatTerminalScopedPublicId(input);
  return `${scoped.prefix}${generalChatTerminalMessagePublicId({
    conversationId: scoped.publicId,
    taskId: input.localTaskId,
    errorCode: input.errorCode,
  })}`;
}

export function generalChatTerminalScopedPublicId(input: {
  userId: number;
  projectAssignmentId: string | null;
  persistedConversationId: string;
}) {
  const prefix = input.projectAssignmentId
    ? `p${input.projectAssignmentId}:`
    : `u${input.userId}:`;
  if (!input.persistedConversationId.startsWith(prefix)) {
    throw new Error("GENERAL_CHAT_TERMINAL_1547_CONVERSATION_SCOPE_MISMATCH");
  }
  const publicId = input.persistedConversationId.slice(prefix.length);
  if (!publicId) {
    throw new Error("GENERAL_CHAT_TERMINAL_1547_CONVERSATION_SCOPE_MISMATCH");
  }
  return { prefix, publicId };
}

export function generalChatTerminalPublicIdFromPersisted(input: {
  userId: number;
  projectAssignmentId: string | null;
  persistedConversationId: string;
  persistedResourceId: string;
}) {
  const { prefix } = generalChatTerminalScopedPublicId(input);
  if (!input.persistedResourceId.startsWith(prefix)) {
    throw new Error("GENERAL_CHAT_TERMINAL_1547_RESOURCE_SCOPE_MISMATCH");
  }
  const publicId = input.persistedResourceId.slice(prefix.length);
  if (!publicId) {
    throw new Error("GENERAL_CHAT_TERMINAL_1547_RESOURCE_SCOPE_MISMATCH");
  }
  return publicId;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, max = 128) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : null;
}

export type GeneralChatTerminal1547TurnSelection = {
  userEventId: string;
  events: ManusV2MessageEvent[];
};

export type GeneralChatTerminal1547LegacyOutputBinding = {
  messageId: string;
  localEventId: string;
  providerEventId: string;
};

/**
 * Legacy browser snapshots predate `metadata.generalChat`. Their durable
 * `upstreamOutputId` still points at exactly one agent_events row, which is a
 * stronger identity than content or timestamp heuristics. Require a complete
 * bijection with the Provider events selected for the current turn.
 */
export function bindGeneralChatTerminal1547LegacyOutputs(input: {
  messages: readonly {
    id: string;
    metadata: Record<string, unknown> | null;
  }[];
  agentEvents: readonly {
    id: string;
    taskId: string;
    providerEventId: string;
    eventType: string;
    normalizedPayload: Record<string, unknown>;
  }[];
  localTaskId: string;
  currentTurnOutputEventIds: readonly string[];
}): GeneralChatTerminal1547LegacyOutputBinding[] {
  if (input.messages.length === 0) {
    throw new Error("GENERAL_CHAT_TERMINAL_1547_OUTPUT_MISSING");
  }
  const eventsByLocalId = new Map(
    input.agentEvents.map((event) => [event.id, event]),
  );
  if (eventsByLocalId.size !== input.agentEvents.length) {
    throw new Error("GENERAL_CHAT_TERMINAL_1547_OUTPUT_EVENT_NOT_UNIQUE");
  }
  const seenLocalEventIds = new Set<string>();
  const bindings = input.messages.map((message) => {
    const localEventId = message.metadata?.upstreamOutputId;
    if (
      typeof localEventId !== "string" ||
      !localEventId ||
      seenLocalEventIds.has(localEventId)
    ) {
      throw new Error("GENERAL_CHAT_TERMINAL_1547_OUTPUT_EVENT_NOT_UNIQUE");
    }
    seenLocalEventIds.add(localEventId);
    const event = eventsByLocalId.get(localEventId);
    if (
      !event ||
      event.taskId !== input.localTaskId ||
      event.eventType !== "assistant_message" ||
      event.normalizedPayload.kind !== "provider_event"
    ) {
      throw new Error("GENERAL_CHAT_TERMINAL_1547_OUTPUT_EVENT_MISMATCH");
    }
    return {
      messageId: message.id,
      localEventId,
      providerEventId: event.providerEventId,
    };
  });
  const expected = [...new Set(input.currentTurnOutputEventIds)].sort();
  const actual = [
    ...new Set(bindings.map((item) => item.providerEventId)),
  ].sort();
  if (
    expected.length !== input.currentTurnOutputEventIds.length ||
    actual.length !== bindings.length ||
    expected.length !== actual.length ||
    expected.some((eventId, index) => eventId !== actual[index])
  ) {
    throw new Error("GENERAL_CHAT_TERMINAL_1547_OUTPUT_EVENT_MISMATCH");
  }
  return bindings;
}

export function generalChatTerminal1547ProjectionMetadata(input: {
  metadata: Record<string, unknown> | null;
  turnId: string;
  localTaskId: string;
  localEventId: string;
  providerEventId: string;
}) {
  return {
    ...(input.metadata ?? {}),
    upstreamOutputId: input.localEventId,
    generalChat: {
      schemaVersion: 1,
      kind: "assistant_projection",
      turnId: input.turnId,
      agentTaskId: input.localTaskId,
      providerEventId: input.providerEventId,
      serverOwned: true,
    },
  } as const;
}

/**
 * The command-level expected hash closes preview-to-command drift. This
 * second fence closes command-inspect-to-transaction drift by comparing the
 * exact local rows again after they have been locked and before any write.
 */
export function assertGeneralChatTerminal1547MutationFence(
  expected: unknown,
  locked: unknown,
) {
  if (
    generalChatTerminal1547StateHash(expected) !==
    generalChatTerminal1547StateHash(locked)
  ) {
    throw new Error("GENERAL_CHAT_TERMINAL_1547_LOCAL_STATE_CHANGED");
  }
}

/**
 * Bind exactly one Provider user event to the persisted turn. Watermark ids
 * are the immutable pre-send boundary, while prompt/attachment hashes bind
 * the first event after that boundary without relying on opaque id prefixes.
 */
export function selectGeneralChatTerminal1547TurnEvents(input: {
  events: readonly ManusV2MessageEvent[];
  promptSha256: string;
  providerAttachmentFileIds: readonly string[];
  providerEventWatermark: readonly string[];
}): GeneralChatTerminal1547TurnSelection {
  const ordered = orderManusV2EventsByProviderRank(
    input.events,
    "oldest_first",
  );
  const indexById = new Map(ordered.map((event, index) => [event.id, index]));
  if (
    new Set(input.providerEventWatermark).size !==
      input.providerEventWatermark.length ||
    input.providerEventWatermark.some((id) => !indexById.has(id))
  ) {
    throw new Error("GENERAL_CHAT_TERMINAL_1547_WATERMARK_MISMATCH");
  }
  const boundary = input.providerEventWatermark.reduce(
    (latest, id) => Math.max(latest, indexById.get(id)!),
    -1,
  );
  const matches = ordered
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event, index }) =>
        index > boundary &&
        event.type === "user_message" &&
        manusV2EventMatchesGeneralChatRequest(event, {
          promptSha256: input.promptSha256,
          attachmentFileIds: input.providerAttachmentFileIds,
        }),
    );
  if (matches.length !== 1) {
    throw new Error("GENERAL_CHAT_TERMINAL_1547_USER_EVENT_NOT_UNIQUE");
  }
  const start = matches[0]!.index;
  let end = ordered.length;
  for (let index = start + 1; index < ordered.length; index += 1) {
    if (ordered[index]!.type === "user_message") {
      end = index;
      break;
    }
  }
  return {
    userEventId: matches[0]!.event.id,
    events: ordered.slice(start, end),
  };
}

export type GeneralChatTerminal1547Outcome = {
  kind:
    | "completed"
    | "partial"
    | "failed"
    | "cancelled"
    | "pending"
    | "attention_required";
  detailStatus: string | null;
  eventStatus: string | null;
  outputEventIds: string[];
  userStop: boolean;
  errorType: string | null;
};

export function classifyGeneralChatTerminal1547Outcome(input: {
  detailStatus: string | null;
  currentTurnEvents: readonly ManusV2MessageEvent[];
}): GeneralChatTerminal1547Outcome {
  const ordered = orderManusV2EventsByProviderRank(
    input.currentTurnEvents,
    "newest_first",
  );
  let eventStatus: string | null = null;
  let errorType: string | null = null;
  for (const event of ordered) {
    if (eventStatus === null && event.type === "status_update") {
      eventStatus = boundedString(record(event.status_update)?.agent_status);
    }
    if (errorType === null && event.type === "error_message") {
      const error = record(event.error_message);
      errorType = boundedString(
        error?.error_type ?? error?.type ?? error?.code,
      );
    }
  }
  const userStop = input.currentTurnEvents.some(
    (event) => event.type === "user_stop",
  );
  const outputEventIds = input.currentTurnEvents
    .filter((event) => event.type === "assistant_message")
    .map((event) => event.id);
  const detailStatus =
    boundedString(input.detailStatus, 64)?.toLowerCase() ?? null;
  let kind: GeneralChatTerminal1547Outcome["kind"];
  if (userStop) {
    kind = "cancelled";
  } else if (["running", "waiting"].includes(detailStatus ?? "")) {
    kind = "pending";
  } else if (detailStatus === "stopped") {
    kind = outputEventIds.length > 0 ? "completed" : "attention_required";
  } else if (detailStatus === "error") {
    kind = outputEventIds.length > 0 ? "partial" : "failed";
  } else {
    kind = "attention_required";
  }
  return {
    kind,
    detailStatus,
    eventStatus,
    outputEventIds,
    userStop,
    errorType,
  };
}

export async function readGeneralChatTerminal1547ProviderEvidence<
  TDetail,
  TEvents,
>(
  client: {
    taskDetail(taskId: string): Promise<TDetail>;
    listAllMessages(input: {
      taskId: string;
      order: "asc" | "desc";
    }): Promise<TEvents>;
  },
  taskId: string,
) {
  // Keep these two GET-only calls explicit so this incident command can never
  // acquire a create/send/stop/delete capability through its dependency type.
  const detail = await client.taskDetail(taskId);
  const events = await client.listAllMessages({ taskId, order: "asc" });
  return { detail, events };
}

export async function runStateBoundGeneralChatTerminal1547Repair<
  T extends { stateHash: string; complete: boolean },
>(
  command: GeneralChatTerminal1547RepairCommand,
  operations: {
    inspect(): Promise<T>;
    apply(before: T): Promise<void>;
  },
) {
  const before = await operations.inspect();
  if (command.mode === "preview") {
    return { before, applied: false, after: before };
  }
  if (command.expectedStateHash !== before.stateHash) {
    throw new Error("GENERAL_CHAT_TERMINAL_1547_STATE_CHANGED");
  }
  if (before.complete) {
    return { before, applied: false, after: before };
  }
  await operations.apply(before);
  const after = await operations.inspect();
  if (!after.complete) {
    throw new Error("GENERAL_CHAT_TERMINAL_1547_POSTFLIGHT_INCOMPLETE");
  }
  return { before, applied: true, after };
}

function generalChatIncidentStepFailureCode(error: unknown) {
  const raw = error instanceof Error ? error.message : "";
  return /^GENERAL_CHAT_(?:TERMINAL_1547|INCIDENT)_[A-Z0-9_]+$/u.test(raw)
    ? generalChatTerminal1547FailureCode(error)
    : "UNKNOWN";
}

export async function runOrderedGeneralChatIncidentRepairSteps(
  steps: readonly {
    incident: string;
    isLocallyComplete(): Promise<boolean>;
    preview(): Promise<{ complete: boolean; stateHash: string }>;
    apply(expectedStateHash: string): Promise<{ applied: boolean }>;
  }[],
) {
  const results: Array<{
    incident: string;
    applied: boolean;
    errorCode: string | null;
  }> = [];
  for (const step of steps) {
    let applied = false;
    try {
      if (!(await step.isLocallyComplete())) {
        const preview = await step.preview();
        if (!preview.complete) {
          applied = (await step.apply(preview.stateHash)).applied;
        }
      }
      results.push({ incident: step.incident, applied, errorCode: null });
    } catch (error) {
      results.push({
        incident: step.incident,
        applied: false,
        errorCode: generalChatIncidentStepFailureCode(error),
      });
    }
  }
  return results;
}

export function generalChatTerminal1547StateHash(value: unknown) {
  return generalChatIncidentStateHash(value);
}

export type GeneralChatTerminal1547RepairSummary = {
  schemaVersion: 1;
  incident: typeof GENERAL_CHAT_TERMINAL_1547_REPAIR_ID;
  mode: "preview" | "apply";
  success: boolean;
  applicable: boolean;
  applied: boolean;
  stateHash: string | null;
  finalStateHash: string | null;
  outcome: GeneralChatTerminal1547Outcome["kind"] | null;
  counts: {
    outputMessages: number;
    inputAttachments: number;
    outputArtifacts: number;
    legacyErrors: number;
    activeTerminalNotices: number;
  } | null;
  build: { sha: string | null; imageDigest: string | null };
  errorCode: string | null;
};

export function generalChatTerminal1547FailureCode(error: unknown) {
  const raw = error instanceof Error ? error.message : "UNKNOWN";
  const normalized = raw
    .replace(/^GENERAL_CHAT_(?:TERMINAL_1547|INCIDENT)_/u, "")
    .replace(/[^A-Z0-9_]/gu, "_")
    .slice(0, 128);
  return normalized || "UNKNOWN";
}
