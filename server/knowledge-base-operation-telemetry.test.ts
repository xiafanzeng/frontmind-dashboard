import { describe, expect, it, vi } from "vitest";

import {
  KNOWLEDGE_BASE_PROMPT_CONTRACT_VERSION,
  knowledgeBaseOperationTelemetryRecord,
  logKnowledgeBaseOperationTelemetry,
} from "./knowledge-base-operation-telemetry";

describe("knowledge-base operation telemetry", () => {
  it("keeps only bounded identifiers and the prompt contract version", () => {
    expect(
      knowledgeBaseOperationTelemetryRecord({
        event: "turn_replay_hit",
        buildId: "build-1",
        turnId: "turn-1",
        reasonCode: "exact_request",
        adoptedWinner: true,
      }),
    ).toEqual({
      event: "turn_replay_hit",
      promptVersion: KNOWLEDGE_BASE_PROMPT_CONTRACT_VERSION,
      buildId: "build-1",
      turnId: "turn-1",
      reasonCode: "exact_request",
      adoptedWinner: true,
    });
  });

  it("drops customer text, URLs and unsafe provider-controlled values", () => {
    const record = knowledgeBaseOperationTelemetryRecord({
      event: "logo_upload_candidate_rejected",
      buildId: "https://customer.example/private path",
      turnId: "turn\nsecret",
      reasonCode: "raw refusal: 客户正文",
    });
    expect(record).toEqual({
      event: "logo_upload_candidate_rejected",
      promptVersion: KNOWLEDGE_BASE_PROMPT_CONTRACT_VERSION,
    });
    expect(JSON.stringify(record)).not.toContain("customer.example");
    expect(JSON.stringify(record)).not.toContain("客户正文");
  });

  it("logs only the sanitized record", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logKnowledgeBaseOperationTelemetry({
      event: "initial_logo_degraded_to_upload",
      buildId: "build-2",
      reasonCode: "LOGO_UPLOAD_INVALID",
    });
    expect(info).toHaveBeenCalledWith(
      "[KnowledgeBaseOperation] initial_logo_degraded_to_upload",
      JSON.stringify({
        event: "initial_logo_degraded_to_upload",
        promptVersion: KNOWLEDGE_BASE_PROMPT_CONTRACT_VERSION,
        buildId: "build-2",
        reasonCode: "LOGO_UPLOAD_INVALID",
      }),
    );
    info.mockRestore();
  });
});
