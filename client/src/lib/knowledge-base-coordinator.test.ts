import { describe, expect, it, vi } from "vitest";
import type { KnowledgeBaseObservationDto } from "@/lib/knowledge-progress";
import { KnowledgeBasePollingCoordinator } from "./knowledge-base-coordinator";
import { observationNeedsPolling } from "./knowledge-base-coordinator";

function executingObservation(): KnowledgeBaseObservationDto {
  return {
    stateEpoch: 1,
    generation: 1,
    authoritativeTaskId: "task-1",
    activeTurn: null,
    interaction: {
      progress: null,
      interactionState: "executing",
      canReply: false,
      canPublish: false,
      lockReason: null,
    },
    approvedPresentation: null,
    package: null,
    notice: null,
    conversationVersion: 1,
  };
}

describe("KnowledgeBasePollingCoordinator", () => {
  it("stops polling once a released turn has a server-approved current presentation", () => {
    const currentProgress = {
      build: {
        id: "build-1",
        conversationId: "conversation",
        companyName: "FrontMind",
        status: "confirming" as const,
        revision: 1,
        currentLeafId: "1.2",
        protocolError: null,
        updatedAt: 1,
      },
      summary: {
        total: 3,
        handled: 1,
        confirmed: 1,
        directPrefilled: 0,
        pending: 1,
        current: 1,
        needsVerification: 0,
        overallPercent: 33,
      },
      branches: [],
      packageAllowed: false,
    };
    expect(
      observationNeedsPolling({
        ...executingObservation(),
        stateEpoch: 2,
        activeTurn: null,
        interaction: {
          progress: currentProgress,
          interactionState: "awaiting_input",
          canReply: true,
          canPublish: false,
          lockReason: null,
        },
        approvedPresentation: {
          turnId: "completed-turn-1",
          clientRequestId: "request-completed-turn-1",
          presentationKey: "presentation-1",
          revision: 1,
          leafId: "1.2",
          visibleMarkdown: "## 1.2\n正文",
          contentSha256: "a".repeat(64),
          imageState: "no_eligible_asset",
          resources: [],
        },
      }),
    ).toBe(false);
  });

  it("coalesces duplicate focus/wake events and never overlaps requests", async () => {
    let release!: (value: KnowledgeBaseObservationDto) => void;
    let concurrent = 0;
    let maxConcurrent = 0;
    const observe = vi.fn(
      () =>
        new Promise<KnowledgeBaseObservationDto>((resolve) => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          release = (value) => {
            concurrent -= 1;
            resolve(value);
          };
        }),
    );
    const apply = vi.fn();
    const coordinator = new KnowledgeBasePollingCoordinator({ observe, apply });

    coordinator.register("conversation");
    coordinator.wake("conversation");
    coordinator.wake("conversation");
    coordinator.wakeAll();
    expect(observe).toHaveBeenCalledTimes(1);

    release({
      ...executingObservation(),
      interaction: {
        ...executingObservation().interaction,
        interactionState: "failed",
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    // All duplicate triggers collapse into at most one follow-up request.
    expect(observe).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1);
    coordinator.dispose();
  });

  it("drops a result after the provider unregisters/aborts its generation", async () => {
    let release!: (value: KnowledgeBaseObservationDto) => void;
    const apply = vi.fn();
    const coordinator = new KnowledgeBasePollingCoordinator({
      observe: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      apply,
    });
    coordinator.wake("conversation");
    coordinator.unregister("conversation");
    release(executingObservation());
    await Promise.resolve();

    expect(apply).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  it("does not retry a stable client error forever", async () => {
    const permanent = Object.assign(new Error("forbidden"), { status: 403 });
    const observe = vi.fn().mockRejectedValue(permanent);
    const onTransientError = vi.fn();
    const onPermanentError = vi.fn();
    const setTimer = vi.fn();
    const coordinator = new KnowledgeBasePollingCoordinator({
      observe,
      apply: vi.fn(),
      onTransientError,
      onPermanentError,
      setTimer: setTimer as unknown as typeof setTimeout,
    });

    coordinator.wake("conversation");
    await Promise.resolve();
    await Promise.resolve();

    expect(observe).toHaveBeenCalledTimes(1);
    expect(onPermanentError).toHaveBeenCalledWith("conversation", permanent);
    expect(onTransientError).not.toHaveBeenCalled();
    expect(setTimer).not.toHaveBeenCalled();
    coordinator.dispose();
  });
});
