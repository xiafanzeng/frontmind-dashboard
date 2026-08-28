import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  currentGeneralChatTurnProviderEvidence,
  generalChatProviderEventEvidence,
  settleGeneralChatTurn,
} from "./general-chat-terminal-arbitration";
import type { ManusV2MessageEvent } from "./manus-v2-client";

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function event(
  id: string,
  type: string,
  providerOriginalRank: number,
  payload: Record<string, unknown>,
): ManusV2MessageEvent {
  return {
    id,
    type,
    timestamp: 1_000,
    providerOriginalRank,
    ...payload,
  };
}

function userEvent(
  id: string,
  providerOriginalRank: number,
  prompt: string,
  fileIds: string[] = [],
) {
  return event(id, "user_message", providerOriginalRank, {
    user_message: {
      content: prompt,
      attachments: fileIds.map((file_id) => ({ file_id })),
    },
  });
}

function statusEvent(
  id: string,
  providerOriginalRank: number,
  agentStatus: string,
) {
  return event(id, "status_update", providerOriginalRank, {
    status_update: { agent_status: agentStatus },
  });
}

const baseSettlement = {
  previousStatus: "running" as const,
  currentTurnAlreadyCompleted: false,
  binding: "bound" as const,
  detailStatus: null,
  eventStatus: null,
  hasUserStop: false,
  hasCurrentOutput: false,
  resultDeadlineAtMs: null,
  nowMs: 10_000,
  graceMs: 1_000,
};

describe("ordinary-chat current-turn Provider evidence", () => {
  it("excludes an old-turn error by watermark and respects Provider rank when timestamps collide", () => {
    const prompt = "相同的多轮问题";
    const events = [
      userEvent("old-user", 0, prompt, ["file-old"]),
      statusEvent("old-error", 1, "error"),
      userEvent("current-user", 2, prompt, ["file-new"]),
      statusEvent("current-running", 3, "running"),
      statusEvent("current-stopped", 4, "stopped"),
    ];

    const evidence = currentGeneralChatTurnProviderEvidence({
      events: [...events].reverse(),
      promptSha256: sha256(prompt),
      providerAttachmentFileIds: ["file-new"],
      providerEventWatermark: ["old-user", "old-error"],
    });

    expect(evidence.binding).toBe("bound");
    expect(evidence.events.map((item) => item.id)).toEqual([
      "current-user",
      "current-running",
      "current-stopped",
    ]);
    expect(evidence.eventStatus).toBe("stopped");
  });

  it("does not consume events after the next Provider user-message boundary", () => {
    const prompt = "current";
    const evidence = currentGeneralChatTurnProviderEvidence({
      events: [
        userEvent("current-user", 0, prompt),
        statusEvent("current-running", 1, "running"),
        userEvent("next-user", 2, "next"),
        statusEvent("next-error", 3, "error"),
      ],
      promptSha256: sha256(prompt),
      providerAttachmentFileIds: [],
      providerEventWatermark: [],
    });

    expect(evidence.events.map((item) => item.id)).toEqual([
      "current-user",
      "current-running",
    ]);
    expect(evidence.eventStatus).toBe("running");
  });

  it("requires a unique prompt-and-attachment match", () => {
    const prompt = "duplicate";
    const evidence = currentGeneralChatTurnProviderEvidence({
      events: [
        userEvent("one", 0, prompt, ["file-1"]),
        userEvent("two", 1, prompt, ["file-1"]),
      ],
      promptSha256: sha256(prompt),
      providerAttachmentFileIds: ["file-1"],
      providerEventWatermark: [],
    });
    expect(evidence.binding).toBe("ambiguous");
    expect(evidence.events).toEqual([]);
  });

  it("extracts status, error and user-stop evidence without inventing fields", () => {
    expect(
      generalChatProviderEventEvidence(statusEvent("status", 0, "waiting")),
    ).toMatchObject({ agentStatus: "waiting" });
    expect(
      generalChatProviderEventEvidence(
        event("error", "error_message", 1, {
          error_message: {
            error_type: "provider_timeout",
            content: [{ text: "request timed out" }],
          },
        }),
      ),
    ).toMatchObject({
      errorType: "provider_timeout",
      errorContent: "request timed out",
    });
    expect(
      generalChatProviderEventEvidence(event("stop", "user_stop", 2, {})),
    ).toMatchObject({ userStop: true });
  });
});

describe("ordinary-chat current-turn terminal arbitration", () => {
  it("keeps running and waiting non-terminal", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "running",
        eventStatus: "running",
      }).status,
    ).toBe("running");
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "waiting",
        eventStatus: "waiting",
      }).status,
    ).toBe("running");
  });

  it("settles natural stopped with authoritative current-turn output", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "stopped",
        eventStatus: "stopped",
        hasCurrentOutput: true,
      }),
    ).toMatchObject({
      status: "succeeded",
      errorCode: null,
      partialResult: false,
    });
  });

  it("allows an earlier error observation to recover to stopped", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        previousStatus: "failed",
        detailStatus: "stopped",
        eventStatus: "stopped",
        hasCurrentOutput: true,
      }).status,
    ).toBe("succeeded");
  });

  it("preserves partial output on a real error", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "error",
        eventStatus: "error",
        hasCurrentOutput: true,
      }),
    ).toMatchObject({
      status: "failed",
      errorCode: "PARTIAL_RESULT_PRESERVED",
      partialResult: true,
    });
  });

  it("fails a real error without output", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "error",
        eventStatus: "error",
      }),
    ).toMatchObject({
      status: "failed",
      errorCode: "PROVIDER_TASK_FAILED",
      partialResult: false,
    });
  });

  it("treats user_stop as cancellation rather than natural stopped", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "stopped",
        eventStatus: "stopped",
        hasUserStop: true,
        hasCurrentOutput: true,
      }),
    ).toMatchObject({ status: "cancelled", errorCode: "USER_STOPPED" });
  });

  it("uses a bounded result_pending window for detail/event conflict and then settles by detail", () => {
    const first = settleGeneralChatTurn({
      ...baseSettlement,
      detailStatus: "stopped",
      eventStatus: "error",
      hasCurrentOutput: true,
    });
    expect(first).toMatchObject({
      status: "result_pending",
      conflict: true,
      resultDeadlineAtMs: 11_000,
    });
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "stopped",
        eventStatus: "error",
        hasCurrentOutput: true,
        resultDeadlineAtMs: first.resultDeadlineAtMs,
        nowMs: 11_000,
      }),
    ).toMatchObject({ status: "succeeded", conflict: true });
  });

  it("keeps a completed current turn monotonic under a later out-of-order error", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        previousStatus: "succeeded",
        currentTurnAlreadyCompleted: true,
        detailStatus: "error",
        eventStatus: "error",
        hasCurrentOutput: true,
      }),
    ).toMatchObject({ status: "succeeded", errorCode: null });
  });

  it("allows a newly reserved current turn to reopen a previously successful task", () => {
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        previousStatus: "succeeded",
        currentTurnAlreadyCompleted: false,
        detailStatus: "running",
        eventStatus: "running",
      }),
    ).toMatchObject({ status: "running", errorCode: null });
  });

  it("keeps stopped without output in the existing result grace", () => {
    const first = settleGeneralChatTurn({
      ...baseSettlement,
      detailStatus: "stopped",
      eventStatus: "stopped",
    });
    expect(first.status).toBe("result_pending");
    expect(
      settleGeneralChatTurn({
        ...baseSettlement,
        detailStatus: "stopped",
        eventStatus: "stopped",
        resultDeadlineAtMs: first.resultDeadlineAtMs,
        nowMs: 11_000,
      }),
    ).toMatchObject({ status: "failed", errorCode: "RESULT_MISSING" });
  });
});
