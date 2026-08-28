import { createHash } from "node:crypto";

export const GENERAL_CHAT_INCIDENT_REPAIR_ID =
  "frontmind.general-chat.sync-loss.2026-08-28";
export const GENERAL_CHAT_INCIDENT_REPAIR_LOCK =
  "frontmind:general-chat-sync-loss:20260828";

export const GENERAL_CHAT_INCIDENT_WINDOWS = {
  text1020: {
    start: new Date("2026-08-28T02:20:10.000Z"),
    end: new Date("2026-08-28T02:20:25.000Z"),
    providerUserMessages: 2,
    providerAssistantMessages: 2,
  },
  image1022: {
    start: new Date("2026-08-28T02:22:20.000Z"),
    end: new Date("2026-08-28T02:22:45.000Z"),
    providerUserMessages: 1,
    providerAssistantMessages: 2,
  },
  text1027: {
    start: new Date("2026-08-28T02:27:15.000Z"),
    end: new Date("2026-08-28T02:27:35.000Z"),
    providerUserMessages: 1,
    providerAssistantMessages: 1,
  },
} as const;

export type GeneralChatIncidentSlot =
  keyof typeof GENERAL_CHAT_INCIDENT_WINDOWS;

export type GeneralChatIncidentRepairCommand =
  | { mode: "preview" }
  | { mode: "apply"; expectedStateHash: string };

const SHA256 = /^[a-f0-9]{64}$/u;

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
}

export function generalChatIncidentStateHash(value: unknown) {
  return sha256(JSON.stringify(canonicalJsonValue(value)));
}

export type GeneralChatIncidentSequenceCandidate = {
  id: string;
  currentSequence: number;
  effectiveTimeMs: number;
  wireRank: number | null;
};

export function planGeneralChatIncidentMessageSequence(
  candidates: readonly GeneralChatIncidentSequenceCandidate[],
) {
  if (
    new Set(candidates.map((candidate) => candidate.id)).size !==
      candidates.length ||
    candidates.some(
      (candidate) =>
        !candidate.id ||
        !Number.isSafeInteger(candidate.currentSequence) ||
        !Number.isFinite(candidate.effectiveTimeMs) ||
        (candidate.wireRank !== null &&
          !Number.isSafeInteger(candidate.wireRank)),
    )
  ) {
    throw new Error("GENERAL_CHAT_INCIDENT_SEQUENCE_INPUT_INVALID");
  }
  return [...candidates]
    .sort((left, right) => {
      const byTime = left.effectiveTimeMs - right.effectiveTimeMs;
      if (byTime !== 0) return byTime;
      if (
        left.wireRank !== null &&
        right.wireRank !== null &&
        left.wireRank !== right.wireRank
      ) {
        return left.wireRank - right.wireRank;
      }
      return (
        left.currentSequence - right.currentSequence ||
        left.id.localeCompare(right.id)
      );
    })
    .map((candidate) => candidate.id);
}

export function automaticGeneralChatIncidentRepairEnabled(input: {
  nodeEnv: string | undefined;
  compiledReleaseChannel: string | undefined;
  publicUrl: string | undefined;
}) {
  return (
    input.nodeEnv === "production" &&
    input.compiledReleaseChannel?.trim().toLowerCase() === "production" &&
    input.publicUrl === "https://dashboard.frontmind.net"
  );
}

export async function readGeneralChatIncidentProviderMessages<T>(
  client: {
    listAllMessages(input: {
      taskId: string;
      order: "asc" | "desc";
    }): Promise<T>;
  },
  input: { taskId: string; order: "asc" | "desc" },
) {
  return client.listAllMessages(input);
}

export async function runStateBoundGeneralChatIncidentRepair<
  T extends { stateHash: string; complete: boolean },
>(
  command: GeneralChatIncidentRepairCommand,
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
    throw new Error("GENERAL_CHAT_INCIDENT_STATE_CHANGED");
  }
  if (before.complete) {
    return { before, applied: false, after: before };
  }
  await operations.apply(before);
  const after = await operations.inspect();
  if (!after.complete) {
    throw new Error("GENERAL_CHAT_INCIDENT_POSTFLIGHT_INCOMPLETE");
  }
  return { before, applied: true, after };
}

export function deterministicIncidentUuid(label: string) {
  const hex = sha256(`${GENERAL_CHAT_INCIDENT_REPAIR_ID}\0${label}`)
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8).join(""),
    hex.slice(8, 12).join(""),
    hex.slice(12, 16).join(""),
    hex.slice(16, 20).join(""),
    hex.slice(20, 32).join(""),
  ].join("-");
}

export function recoveredImageConversationPublicId(localTaskId: string) {
  return `recovered-general-chat-${sha256(localTaskId).slice(0, 24)}`;
}

export function recoveredImageMessagePublicId(localTaskId: string) {
  return `msg-recovered-general-chat-${sha256(localTaskId).slice(0, 24)}`;
}

export function recoveredImageAttachmentPublicId(localTaskId: string) {
  return `att-recovered-general-chat-${sha256(localTaskId).slice(0, 24)}`;
}

export function generalChatTurnOperationKey(input: {
  userId: number;
  conversationPublicId: string;
  clientRequestId: string;
}) {
  return `chat-turn:${sha256(
    `${input.userId}\0${input.conversationPublicId}\0${input.clientRequestId}`,
  )}`;
}

export function publicIdFromPersistedId(input: {
  userId: number;
  persistedId: string;
}) {
  const prefix = `u${input.userId}:`;
  if (!input.persistedId.startsWith(prefix)) {
    throw new Error("GENERAL_CHAT_INCIDENT_PERSISTED_ID_SCOPE_MISMATCH");
  }
  return input.persistedId.slice(prefix.length);
}

export function persistedIdForManagedUser(input: {
  userId: number;
  publicId: string;
}) {
  return `u${input.userId}:${input.publicId}`;
}

export function parseGeneralChatIncidentRepairCommand(
  args: readonly string[],
): GeneralChatIncidentRepairCommand {
  const values = new Map<string, string>();
  for (const argument of args) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || values.has(match[1]!)) {
      throw new Error("GENERAL_CHAT_INCIDENT_REPAIR_ARGUMENT_INVALID");
    }
    values.set(match[1]!, match[2]!);
  }
  const allowed = new Set(["mode", "expected-state-hash"]);
  if ([...values.keys()].some((key) => !allowed.has(key))) {
    throw new Error("GENERAL_CHAT_INCIDENT_REPAIR_ARGUMENT_UNKNOWN");
  }
  const mode = values.get("mode");
  if (mode === "preview" && values.size === 1) return { mode };
  const expectedStateHash = values.get("expected-state-hash");
  if (
    mode === "apply" &&
    values.size === 2 &&
    expectedStateHash &&
    SHA256.test(expectedStateHash)
  ) {
    return { mode, expectedStateHash };
  }
  throw new Error("GENERAL_CHAT_INCIDENT_REPAIR_ARGUMENT_INVALID");
}

export type GeneralChatIncidentRepairSummary = {
  schemaVersion: 1;
  incident: typeof GENERAL_CHAT_INCIDENT_REPAIR_ID;
  mode: "preview" | "apply";
  success: boolean;
  applicable: boolean;
  applied: boolean;
  stateHash: string | null;
  finalStateHash: string | null;
  counts: {
    operations: number;
    tasks: number;
    conversations: number;
    turns: number;
    userMessages: number;
    assistantMessages: number;
    inputAttachments: number;
    outputArtifacts: number;
  } | null;
  build: { sha: string | null; imageDigest: string | null };
  errorCode: string | null;
};

export function generalChatIncidentFailureCode(error: unknown) {
  const raw = error instanceof Error ? error.message : "UNKNOWN";
  const normalized = raw
    .replace(/^GENERAL_CHAT_INCIDENT_/u, "")
    .replace(/[^A-Z0-9_]/gu, "_")
    .slice(0, 128);
  return normalized || "UNKNOWN";
}
