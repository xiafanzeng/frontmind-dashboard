import type { KnowledgeBaseObservationDto } from "@/lib/knowledge-progress";

interface CoordinatorSlot {
  registered: boolean;
  running: boolean;
  rerunRequested: boolean;
  generation: number;
  controller: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  notFoundSince: number | null;
}

export interface KnowledgeBaseCoordinatorOptions {
  observe: (
    conversationId: string,
    signal: AbortSignal,
  ) => Promise<KnowledgeBaseObservationDto>;
  apply: (
    conversationId: string,
    observation: KnowledgeBaseObservationDto,
  ) => void;
  onTransientError?: (conversationId: string, error: unknown) => void;
  onPermanentError?: (conversationId: string, error: unknown) => void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  notFoundGraceMs?: number;
}

export function getKnowledgeBasePollDelay(elapsedMs: number) {
  if (elapsedMs < 5 * 60 * 1000) return 3_000;
  if (elapsedMs < 30 * 60 * 1000) return 10_000;
  return 30_000;
}

export function observationNeedsPolling(
  observation: KnowledgeBaseObservationDto,
): boolean {
  const state = observation.interaction?.interactionState;
  if (state === "queued" || state === "executing") return true;
  if (state !== "awaiting_input") return false;

  const presentation = observation.approvedPresentation;
  const progress = observation.progress ?? observation.interaction?.progress;
  const activeTurnId = observation.activeTurn?.id ?? null;
  return !(
    presentation &&
    presentation.visibleMarkdown.trim() &&
    presentation.turnId &&
    (!activeTurnId || presentation.turnId === activeTurnId) &&
    progress &&
    presentation.revision === progress.build.revision &&
    presentation.leafId === progress.build.currentLeafId
  );
}

/**
 * One instance is owned by one ConversationProvider. Repeated wake calls are
 * coalesced and never create overlapping reconcile requests for a conversation.
 */
export class KnowledgeBasePollingCoordinator {
  private readonly slots = new Map<string, CoordinatorSlot>();
  private disposed = false;

  constructor(private readonly options: KnowledgeBaseCoordinatorOptions) {}

  register(conversationId: string) {
    if (!conversationId || this.disposed) return;
    const existing = this.slots.get(conversationId);
    if (existing) {
      existing.registered = true;
      return;
    }
    this.slots.set(conversationId, {
      registered: true,
      running: false,
      rerunRequested: false,
      generation: 0,
      controller: null,
      timer: null,
      startedAt: (this.options.now ?? Date.now)(),
      notFoundSince: null,
    });
  }

  isRegistered(conversationId: string) {
    return this.slots.get(conversationId)?.registered === true;
  }

  wake(conversationId: string) {
    if (!conversationId || this.disposed) return;
    this.register(conversationId);
    const slot = this.slots.get(conversationId)!;
    if (slot.timer) {
      (this.options.clearTimer ?? clearTimeout)(slot.timer);
      slot.timer = null;
    }
    if (slot.running) {
      slot.rerunRequested = true;
      return;
    }
    void this.run(conversationId, slot);
  }

  wakeAll() {
    for (const [conversationId, slot] of this.slots) {
      if (slot.registered) this.wake(conversationId);
    }
  }

  unregister(conversationId: string) {
    const slot = this.slots.get(conversationId);
    if (!slot) return;
    slot.registered = false;
    slot.generation += 1;
    slot.controller?.abort();
    if (slot.timer) {
      (this.options.clearTimer ?? clearTimeout)(slot.timer);
    }
    this.slots.delete(conversationId);
  }

  reset() {
    for (const conversationId of [...this.slots.keys()]) {
      this.unregister(conversationId);
    }
  }

  dispose() {
    this.disposed = true;
    this.reset();
  }

  private schedule(conversationId: string, slot: CoordinatorSlot) {
    if (this.disposed || !slot.registered || slot.timer) return;
    const now = (this.options.now ?? Date.now)();
    slot.timer = (this.options.setTimer ?? setTimeout)(
      () => {
        slot.timer = null;
        this.wake(conversationId);
      },
      getKnowledgeBasePollDelay(now - slot.startedAt),
    );
  }

  private async run(conversationId: string, slot: CoordinatorSlot) {
    if (this.disposed || !slot.registered || slot.running) return;
    slot.running = true;
    slot.rerunRequested = false;
    const generation = slot.generation;
    const controller = new AbortController();
    slot.controller = controller;

    try {
      const observation = await this.options.observe(
        conversationId,
        controller.signal,
      );
      if (
        this.disposed ||
        !slot.registered ||
        slot.generation !== generation ||
        controller.signal.aborted
      ) {
        return;
      }
      slot.notFoundSince = null;
      this.options.apply(conversationId, observation);
      if (observationNeedsPolling(observation)) {
        this.schedule(conversationId, slot);
      }
    } catch (error) {
      if (!controller.signal.aborted && slot.generation === generation) {
        const status = Number((error as { status?: unknown })?.status || 0);
        const now = (this.options.now ?? Date.now)();
        if (status === 404 && slot.notFoundSince === null) {
          slot.notFoundSince = now;
        }
        const notFoundWithinGrace =
          status === 404 &&
          now - (slot.notFoundSince ?? now) <
            (this.options.notFoundGraceMs ?? 15_000);
        const retryable =
          !status ||
          status === 408 ||
          status === 429 ||
          status >= 500 ||
          notFoundWithinGrace;
        if (retryable) {
          this.options.onTransientError?.(conversationId, error);
          this.schedule(conversationId, slot);
        } else {
          this.unregister(conversationId);
          this.options.onPermanentError?.(conversationId, error);
        }
      }
    } finally {
      if (slot.controller === controller) slot.controller = null;
      slot.running = false;
      if (
        !this.disposed &&
        slot.registered &&
        slot.generation === generation &&
        slot.rerunRequested
      ) {
        slot.rerunRequested = false;
        if (slot.timer) {
          (this.options.clearTimer ?? clearTimeout)(slot.timer);
          slot.timer = null;
        }
        void this.run(conversationId, slot);
      }
    }
  }
}
