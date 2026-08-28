import {
  manusV2EventMatchesGeneralChatRequest,
  orderManusV2EventsByProviderRank,
  type ManusV2MessageEvent,
} from "./manus-v2-client";
import { GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE } from "../shared/frontmind-general-chat-terminal";

export type GeneralChatTurnEventBinding = "bound" | "pending" | "ambiguous";

export type GeneralChatTurnProviderEvidence = {
  binding: GeneralChatTurnEventBinding;
  events: ManusV2MessageEvent[];
  eventStatus: string | null;
  hasUserStop: boolean;
  errorType: string | null;
  errorContent: string | null;
};

export type GeneralChatSettlementStatus =
  | "running"
  | "result_pending"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "attention_required";

export type GeneralChatSettlement = {
  status: GeneralChatSettlementStatus;
  providerState: string;
  errorCode: string | null;
  partialResult: boolean;
  resultDeadlineAtMs: number | null;
  conflict: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

function contentText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const text = value
    .flatMap((part) => {
      const item = record(part);
      return typeof item?.text === "string" ? [item.text] : [];
    })
    .filter(Boolean)
    .join("\n");
  return text || null;
}

export function generalChatProviderEventEvidence(event: ManusV2MessageEvent) {
  const statusUpdate =
    event.type === "status_update" ? record(event.status_update) : null;
  const errorMessage =
    event.type === "error_message" ? record(event.error_message) : null;
  return {
    agentStatus: boundedString(statusUpdate?.agent_status, 64),
    errorType: boundedString(errorMessage?.error_type, 128),
    errorContent: boundedString(contentText(errorMessage?.content), 4_096),
    userStop: event.type === "user_stop",
  };
}

/**
 * Bind exactly one Provider user event to one Dashboard conversation turn.
 * The watermark first removes every event known before the send. Prompt and
 * Provider attachment identities then establish the unique turn boundary;
 * no status, output, stop, or error beyond the next user event can leak in.
 */
export function currentGeneralChatTurnProviderEvidence(input: {
  events: readonly ManusV2MessageEvent[];
  promptSha256: string;
  providerAttachmentFileIds: readonly string[];
  providerEventWatermark: readonly string[];
}): GeneralChatTurnProviderEvidence {
  const watermark = new Set(input.providerEventWatermark);
  const ordered = orderManusV2EventsByProviderRank(
    input.events.filter((event) => !watermark.has(event.id)),
    "oldest_first",
  );
  const matchingUserIndexes = ordered.flatMap((event, index) =>
    manusV2EventMatchesGeneralChatRequest(event, {
      promptSha256: input.promptSha256,
      attachmentFileIds: input.providerAttachmentFileIds,
    })
      ? [index]
      : [],
  );
  if (matchingUserIndexes.length !== 1) {
    return {
      binding: matchingUserIndexes.length > 1 ? "ambiguous" : "pending",
      events: [],
      eventStatus: null,
      hasUserStop: false,
      errorType: null,
      errorContent: null,
    };
  }
  const start = matchingUserIndexes[0]!;
  const nextUserOffset = ordered
    .slice(start + 1)
    .findIndex((event) => event.type === "user_message");
  const end = nextUserOffset < 0 ? ordered.length : start + 1 + nextUserOffset;
  const scoped = ordered.slice(start, end);
  let eventStatus: string | null = null;
  let errorType: string | null = null;
  let errorContent: string | null = null;
  let hasUserStop = false;
  for (const event of scoped) {
    const evidence = generalChatProviderEventEvidence(event);
    if (evidence.agentStatus) eventStatus = evidence.agentStatus;
    if (evidence.errorType) errorType = evidence.errorType;
    if (evidence.errorContent) errorContent = evidence.errorContent;
    if (evidence.userStop) hasUserStop = true;
  }
  return {
    binding: "bound",
    events: scoped,
    eventStatus,
    hasUserStop,
    errorType,
    errorContent,
  };
}

const NATURAL_COMPLETION = new Set([
  "stopped",
  "completed",
  "succeeded",
  "success",
  "finished",
  "done",
]);
const PROVIDER_FAILURE = new Set(["error", "failed"]);
const PROVIDER_CANCEL = new Set(["cancelled", "canceled"]);

function normalizedStatus(value: string | null) {
  return value?.trim().toLowerCase() || null;
}

/**
 * Pure current-turn terminal arbitration. A succeeded, already-settled turn
 * is monotonic. A new turn is reopened before this function is called.
 */
export function settleGeneralChatTurn(input: {
  previousStatus: GeneralChatSettlementStatus | "queued";
  currentTurnAlreadyCompleted: boolean;
  binding: GeneralChatTurnEventBinding;
  detailStatus: string | null;
  eventStatus: string | null;
  hasUserStop: boolean;
  hasCurrentOutput: boolean;
  resultDeadlineAtMs: number | null;
  nowMs: number;
  graceMs: number;
}): GeneralChatSettlement {
  if (
    input.previousStatus === "succeeded" &&
    input.currentTurnAlreadyCompleted
  ) {
    return {
      status: "succeeded",
      providerState: "stopped",
      errorCode: null,
      partialResult: false,
      resultDeadlineAtMs: null,
      conflict: false,
    };
  }

  const detailStatus = normalizedStatus(input.detailStatus);
  const eventStatus = normalizedStatus(input.eventStatus);
  if (input.hasUserStop) {
    return {
      status: "cancelled",
      providerState: "stopped",
      errorCode: "USER_STOPPED",
      partialResult: false,
      resultDeadlineAtMs: null,
      conflict: false,
    };
  }

  const detailEventConflict = Boolean(
    detailStatus && eventStatus && detailStatus !== eventStatus,
  );
  let resultDeadlineAtMs = input.resultDeadlineAtMs;
  if (detailEventConflict) {
    resultDeadlineAtMs ??= input.nowMs + input.graceMs;
    if (input.nowMs < resultDeadlineAtMs) {
      return {
        status: "result_pending",
        providerState: "result_pending",
        errorCode: null,
        partialResult: false,
        resultDeadlineAtMs,
        conflict: true,
      };
    }
  }

  // A terminal task.detail cannot settle a turn that has not been uniquely
  // bound to its Provider user event. Eventual list consistency gets the same
  // bounded grace; persistent ambiguity is surfaced for operator attention.
  const detailTerminal = Boolean(
    detailStatus &&
      (NATURAL_COMPLETION.has(detailStatus) ||
        PROVIDER_FAILURE.has(detailStatus) ||
        PROVIDER_CANCEL.has(detailStatus)),
  );
  if (input.binding !== "bound" && detailTerminal) {
    resultDeadlineAtMs ??= input.nowMs + input.graceMs;
    if (input.nowMs < resultDeadlineAtMs) {
      return {
        status: "result_pending",
        providerState: "result_pending",
        errorCode: null,
        partialResult: false,
        resultDeadlineAtMs,
        conflict: false,
      };
    }
    return {
      status: "attention_required",
      providerState: "attention_required",
      errorCode:
        input.binding === "ambiguous"
          ? "CURRENT_TURN_BINDING_AMBIGUOUS"
          : "CURRENT_TURN_BINDING_MISSING",
      partialResult: false,
      resultDeadlineAtMs,
      conflict: false,
    };
  }

  // After the bounded conflict window, task.detail is authoritative. With no
  // conflict, the current-turn event status is preferred and detail is the
  // read-model fallback when listMessages has not emitted a status yet.
  const selectedState =
    (detailEventConflict ? detailStatus : (eventStatus ?? detailStatus)) ??
    "running";
  if (selectedState === "running" || selectedState === "waiting") {
    return {
      status: "running",
      providerState: selectedState,
      errorCode: null,
      partialResult: false,
      resultDeadlineAtMs: null,
      conflict: detailEventConflict,
    };
  }
  if (PROVIDER_CANCEL.has(selectedState)) {
    return {
      status: "cancelled",
      providerState: selectedState,
      errorCode: "PROVIDER_TASK_CANCELLED",
      partialResult: false,
      resultDeadlineAtMs: null,
      conflict: detailEventConflict,
    };
  }
  if (PROVIDER_FAILURE.has(selectedState)) {
    return input.hasCurrentOutput
      ? {
          status: "failed",
          providerState: selectedState,
          errorCode: GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE,
          partialResult: true,
          resultDeadlineAtMs: null,
          conflict: detailEventConflict,
        }
      : {
          status: "failed",
          providerState: selectedState,
          errorCode: "PROVIDER_TASK_FAILED",
          partialResult: false,
          resultDeadlineAtMs: null,
          conflict: detailEventConflict,
        };
  }
  if (NATURAL_COMPLETION.has(selectedState)) {
    if (input.hasCurrentOutput) {
      return {
        status: "succeeded",
        providerState: selectedState,
        errorCode: null,
        partialResult: false,
        resultDeadlineAtMs: null,
        conflict: detailEventConflict,
      };
    }
    resultDeadlineAtMs ??= input.nowMs + input.graceMs;
    return input.nowMs >= resultDeadlineAtMs
      ? {
          status: "failed",
          providerState: selectedState,
          errorCode: "RESULT_MISSING",
          partialResult: false,
          resultDeadlineAtMs,
          conflict: detailEventConflict,
        }
      : {
          status: "result_pending",
          providerState: "result_pending",
          errorCode: null,
          partialResult: false,
          resultDeadlineAtMs,
          conflict: detailEventConflict,
        };
  }
  return {
    status: "running",
    providerState: selectedState,
    errorCode: null,
    partialResult: false,
    resultDeadlineAtMs: null,
    conflict: detailEventConflict,
  };
}
