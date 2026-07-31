import {
  parseOutputMessages,
  sanitizeKnowledgeBaseOutputMessages,
  type LocalMessage,
} from "@/contexts/ConversationContext";
import type { OutputMessage } from "@/lib/frontmind-api";

function stableOutputIdentity(item: OutputMessage): string | undefined {
  if (typeof item.id === "string" && item.id.trim()) {
    return `id:${item.id}`;
  }
  if (typeof item.call_id === "string" && item.call_id.trim()) {
    return `call:${item.type || "output"}:${item.call_id}`;
  }
  return undefined;
}

function dedupeStableOutput(output: OutputMessage[]): OutputMessage[] {
  const latestIndexes = new Map<string, number>();
  output.forEach((item, index) => {
    const identity = stableOutputIdentity(item);
    if (identity) latestIndexes.set(identity, index);
  });
  return output.filter((item, index) => {
    const identity = stableOutputIdentity(item);
    return !identity || latestIndexes.get(identity) === index;
  });
}

export function collectAssistantOutputIds(
  messages:
    | Array<{ id?: string; upstreamOutputId?: string; role?: string }>
    | undefined,
): string[] {
  if (!messages) return [];
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? [
          typeof message.upstreamOutputId === "string" &&
          message.upstreamOutputId.trim()
            ? message.upstreamOutputId
            : typeof message.id === "string"
              ? message.id
              : "",
        ].filter(Boolean)
      : [],
  );
}

/**
 * Select the current turn's output from APIs that may return either the full
 * cumulative task history or only the current turn.
 */
export function sliceNewOutput(
  output: OutputMessage[],
  baseline: number,
  historicalOutputIds: readonly string[] = [],
): OutputMessage[] {
  if (baseline <= 0) {
    return dedupeStableOutput(output);
  }

  const historicalIds = new Set(historicalOutputIds);
  if (historicalIds.size > 0) {
    const historicalMatches = output
      .map((item, index) => ({ id: item.id, index }))
      .filter(
        (
          match,
        ): match is {
          id: string;
          index: number;
        } => typeof match.id === "string" && historicalIds.has(match.id),
      );

    if (historicalMatches.length === 0) {
      return dedupeStableOutput(output);
    }

    if (output.length < baseline) {
      return dedupeStableOutput(
        output.filter(
          (item) => typeof item.id !== "string" || !historicalIds.has(item.id),
        ),
      );
    }

    const lastHistoricalIndex = Math.max(
      ...historicalMatches.map((match) => match.index),
    );
    return dedupeStableOutput(
      output.slice(Math.max(baseline, lastHistoricalIndex + 1)),
    );
  }

  if (baseline >= output.length) {
    return dedupeStableOutput(output);
  }
  return dedupeStableOutput(output.slice(baseline));
}

/**
 * Knowledge-base tasks may return either a cumulative output array or only the
 * current turn. Reconciliation is idempotent on the server, so falling back to
 * the complete response is safer than silently missing a node transition.
 */
export function outputForKnowledgeProgress(
  output: OutputMessage[],
  slicedOutput: OutputMessage[],
): OutputMessage[] {
  return slicedOutput.length > 0 ? slicedOutput : output;
}

/**
 * A provider can reuse an output ID or replace a same-length cumulative array
 * while a response is still running. In that case the length cursor cannot
 * identify the update, so render the latest assistant item and any resources
 * attached immediately after it.
 */
export function outputForKnowledgePresentation(
  output: OutputMessage[],
  slicedOutput: OutputMessage[],
): OutputMessage[] {
  if (slicedOutput.length > 0) return slicedOutput;

  const messageIndexes = output.flatMap((item, index) =>
    item.role === "assistant" || item.type === "message" || !item.type
      ? [index]
      : [],
  );
  if (messageIndexes.length === 0) return [];

  const latestMessageIndex = messageIndexes[messageIndexes.length - 1]!;
  const resourceTypes = new Set([
    "output_image",
    "image",
    "output_file",
    "file",
  ]);

  return output
    .slice(latestMessageIndex)
    .filter(
      (item, offset) => offset === 0 || resourceTypes.has(item.type || ""),
    );
}

export function projectTaskOutputMessages({
  output,
  baselineOutputLength,
  historicalOutputIds,
  responseStartedAt,
  modelName,
  knowledgeBase,
}: {
  output: OutputMessage[] | undefined;
  baselineOutputLength: number;
  historicalOutputIds?: readonly string[];
  responseStartedAt?: number;
  modelName?: string;
  knowledgeBase: boolean;
}): LocalMessage[] {
  if (!output?.length) return [];

  const slicedOutput = sliceNewOutput(
    output,
    baselineOutputLength,
    historicalOutputIds,
  );
  const presentationOutput = knowledgeBase
    ? outputForKnowledgePresentation(output, slicedOutput)
    : slicedOutput;
  if (presentationOutput.length === 0) return [];

  const parsed = parseOutputMessages(
    presentationOutput,
    responseStartedAt,
    modelName,
  );
  return knowledgeBase
    ? sanitizeKnowledgeBaseOutputMessages(parsed)
    : parsed;
}
