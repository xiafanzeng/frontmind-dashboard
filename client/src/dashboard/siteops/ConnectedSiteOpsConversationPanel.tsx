import type { SiteOpsObservationV1 } from "@shared/siteops-contract";
import { SITEOPS_CUSTOMER_DISPLAY_NAME } from "@shared/siteops-branding";
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import SiteOpsConversationPanel from "./SiteOpsConversationPanel";

const POLLING_STATES = new Set<SiteOpsObservationV1["interactionState"]>([
  "collecting_brief",
  "visual_searching",
  "building",
]);

const PENDING_DEPLOYMENT_STATES = new Set([
  "reserved",
  "deploying",
  "verifying",
]);

const PENDING_SOCIAL_PACKAGE_STATES = new Set([
  "queued",
  "building",
  "qa_running",
]);

const PENDING_REBUILD_REQUEST_STATES = new Set([
  "submitted",
  "scheduled",
  "in_progress",
]);

const REBUILD_REQUEST_TRANSITIONS: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  submitted: new Set([
    "needs_information",
    "scheduled",
    "in_progress",
    "completed",
    "rejected",
    "cancelled",
  ]),
  needs_information: new Set([
    "submitted",
    "scheduled",
    "in_progress",
    "completed",
    "rejected",
    "cancelled",
  ]),
  scheduled: new Set(["in_progress", "completed", "rejected", "cancelled"]),
  in_progress: new Set(["completed", "rejected", "cancelled"]),
  completed: new Set(),
  rejected: new Set(),
  cancelled: new Set(),
};

const SITEOPS_PROGRESSIVE_POLL_INTERVALS = [
  { untilMs: 60_000, intervalMs: 5_000 },
  { untilMs: 5 * 60_000, intervalMs: 10_000 },
  { untilMs: 30 * 60_000, intervalMs: 20_000 },
  { untilMs: Number.POSITIVE_INFINITY, intervalMs: 30_000 },
] as const;

function hasTrustedFallbackReconciliation(
  observation: SiteOpsObservationV1 | null,
) {
  return Boolean(
    observation?.builds?.some(
      (build) =>
        build.buildDelivery?.renderMode === "trusted_fallback" &&
        build.recoverable === true,
    ),
  );
}

export function siteOpsPollIntervalMs(
  observation: SiteOpsObservationV1 | null,
  activeForMs: number,
) {
  if (!shouldPollSiteOpsObservation(observation)) return false as const;
  if (hasTrustedFallbackReconciliation(observation)) return 60_000;
  return SITEOPS_PROGRESSIVE_POLL_INTERVALS.find(
    ({ untilMs }) => activeForMs < untilMs,
  )!.intervalMs;
}

function observationProjectionTimestamp(observation: SiteOpsObservationV1) {
  return Math.max(
    Date.parse(observation.project.updatedAt) || 0,
    ...(observation.builds ?? []).map(
      (build) => Date.parse(build.updatedAt) || 0,
    ),
  );
}

const BUILD_PHASE_RANK: Record<string, number> = {
  source_repairing: 1,
  provider_sync_delayed: 2,
  source_validating: 3,
  compiling: 4,
  persisting_preview: 5,
};

function latestBuildProgressRank(observation: SiteOpsObservationV1) {
  const build = observation.builds?.[0];
  if (!build) return 0;
  if (build.buildDelivery?.renderMode === "trusted_fallback") return 7;
  if (build.buildDelivery) return 8;
  return BUILD_PHASE_RANK[build.buildPhase ?? ""] ?? 0;
}

const DEPLOYMENT_STATUS_RANK: Record<string, number> = {
  reserved: 1,
  deploying: 2,
  verifying: 3,
  active: 4,
  failed: 4,
  attention_required: 4,
  superseded: 4,
};

const SOCIAL_PACKAGE_STATUS_RANK: Record<string, number> = {
  queued: 1,
  building: 2,
  qa_running: 3,
  ready: 4,
  failed: 4,
  attention_required: 4,
  cancelled: 4,
};

function itemProgressComparison(
  current: ReadonlyArray<{ id: string; status: string }>,
  incoming: ReadonlyArray<{ id: string; status: string }>,
  rank: Record<string, number>,
) {
  const currentById = new Map(current.map((item) => [item.id, item.status]));
  let advanced = false;
  for (const item of incoming) {
    const currentStatus = currentById.get(item.id);
    if (!currentStatus) {
      advanced = true;
      continue;
    }
    const currentRank = rank[currentStatus] ?? 0;
    const incomingRank = rank[item.status] ?? 0;
    if (incomingRank < currentRank) return -1;
    if (incomingRank > currentRank) advanced = true;
  }
  return advanced ? 1 : 0;
}

export function siteOpsClientRequestId() {
  return crypto.randomUUID();
}

export function shouldPollSiteOpsObservation(
  observation: SiteOpsObservationV1 | null,
) {
  const fallbackReconciliationFinished = Boolean(
    observation?.builds?.some(
      (build) =>
        build.buildDelivery?.renderMode === "trusted_fallback" &&
        build.recoverable !== true,
    ),
  );
  return Boolean(
    observation &&
      ((POLLING_STATES.has(observation.interactionState) &&
        !(
          observation.interactionState === "building" &&
          fallbackReconciliationFinished
        )) ||
        observation.rebuildRequest.resetPending === true ||
        (observation.rebuildRequest.status !== null &&
          PENDING_REBUILD_REQUEST_STATES.has(
            observation.rebuildRequest.status,
          )) ||
        observation.visualGeneration.status === "generating" ||
        observation.deployments.some((item) =>
          PENDING_DEPLOYMENT_STATES.has(item.status),
        ) ||
        (observation.messages ?? []).some((item) => {
          const card = item.metadata?.siteOps;
          return Boolean(
            card?.kind === "domain_status" &&
              card.status === "active" &&
              card.revision === observation.project.revision &&
              card.payload?.action === "domain_sync",
          );
        }) ||
        (Boolean(observation.domainState?.domain) &&
          !["active", "attention_required"].includes(
            observation.domainState?.dnsStatus ?? "",
          )) ||
        observation.socialPackages.some((item) =>
          PENDING_SOCIAL_PACKAGE_STATES.has(item.status),
        )),
  );
}

export function newestSiteOpsObservation(
  current: SiteOpsObservationV1 | null,
  incoming: SiteOpsObservationV1,
) {
  if (!current) return incoming;
  if (incoming.project.revision > current.project.revision) return incoming;
  if (incoming.project.revision < current.project.revision) return current;
  if (incoming.latestSequence > current.latestSequence) return incoming;
  if (incoming.latestSequence < current.latestSequence) return current;

  // The visual provider commits the board, success message and project
  // revision before the worker owns the operation's terminal transition. A
  // poll may therefore observe the new board while the operation is still
  // running, followed by an idle/retryable projection with the exact same
  // project/message cursor. Accept that one-way terminal transition while
  // continuing to reject a late running response after terminal state won.
  const currentVisualGenerating =
    current.visualGeneration.status === "generating";
  const incomingVisualGenerating =
    incoming.visualGeneration.status === "generating";
  if (currentVisualGenerating && !incomingVisualGenerating) return incoming;
  // Rebuild-ticket processing is updated by the administrative worker and
  // does not need to append a customer message or bump the project revision.
  // At an equal cursor accept only forward ticket/reset transitions so a late
  // response cannot restore an earlier actionable state.
  const currentRebuild = current.rebuildRequest;
  const incomingRebuild = incoming.rebuildRequest;
  if (!currentRebuild.resetApplied && incomingRebuild.resetApplied) {
    return incoming;
  }
  if (currentRebuild.resetApplied && !incomingRebuild.resetApplied) {
    return current;
  }
  if (!currentRebuild.resetPending && incomingRebuild.resetPending) {
    return incoming;
  }
  if (
    currentRebuild.resetPending &&
    !incomingRebuild.resetPending &&
    !incomingRebuild.resetApplied
  ) {
    return current;
  }
  if (currentRebuild.status !== incomingRebuild.status) {
    if (currentRebuild.status === null && incomingRebuild.status !== null) {
      return incoming;
    }
    if (
      currentRebuild.status !== null &&
      incomingRebuild.status !== null &&
      REBUILD_REQUEST_TRANSITIONS[currentRebuild.status]?.has(
        incomingRebuild.status,
      )
    ) {
      return incoming;
    }
  }
  // Build, fallback, deployment and repair-ticket updates are intentionally
  // allowed to advance without appending another chat message or bumping the
  // project revision. Prefer their database update coordinate at an equal
  // project/message cursor, then use monotonic phase ranks for MySQL's
  // second-precision ties. This also prevents a late response from restoring
  // an older provider phase after the fallback or delivery is already visible.
  const currentProjectionTimestamp = observationProjectionTimestamp(current);
  const incomingProjectionTimestamp = observationProjectionTimestamp(incoming);
  if (incomingProjectionTimestamp > currentProjectionTimestamp) {
    return incoming;
  }
  if (incomingProjectionTimestamp < currentProjectionTimestamp) {
    return current;
  }
  const currentBuildRank = latestBuildProgressRank(current);
  const incomingBuildRank = latestBuildProgressRank(incoming);
  if (incomingBuildRank > currentBuildRank) return incoming;
  if (incomingBuildRank < currentBuildRank) return current;
  const deliveryProgress = itemProgressComparison(
    current.deployments ?? [],
    incoming.deployments ?? [],
    DEPLOYMENT_STATUS_RANK,
  );
  if (deliveryProgress > 0) return incoming;
  if (deliveryProgress < 0) return current;
  const socialProgress = itemProgressComparison(
    current.socialPackages ?? [],
    incoming.socialPackages ?? [],
    SOCIAL_PACKAGE_STATUS_RANK,
  );
  if (socialProgress > 0) return incoming;
  if (socialProgress < 0) return current;
  return current;
}

export default function ConnectedSiteOpsConversationPanel({
  onSubmitIcpFiling,
}: {
  onSubmitIcpFiling?: (input: {
    domain: string;
    icpNumber: string;
  }) => Promise<void> | void;
}) {
  const opened = useRef(false);
  const pendingActionAck = useRef<{
    clientRequestId: string;
    projectRevision: number;
    latestSequence: number;
  } | null>(null);
  const observeRequestGeneration = useRef(0);
  const acceptedObserveGeneration = useRef(0);
  const pollEpoch = useRef({ coordinate: "idle", startedAt: Date.now() });
  const [observation, setObservation] = useState<SiteOpsObservationV1 | null>(
    null,
  );
  const [submissionNotice, setSubmissionNotice] = useState<string | null>(null);
  const [pageActive, setPageActive] = useState(() =>
    Boolean(
      (typeof document === "undefined" || !document.hidden) &&
        (typeof navigator === "undefined" || navigator.onLine),
    ),
  );
  const acceptObservation = useCallback((incoming: SiteOpsObservationV1) => {
    setObservation((current) => newestSiteOpsObservation(current, incoming));
    const pending = pendingActionAck.current;
    if (
      pending &&
      (incoming.project.revision > pending.projectRevision ||
        (incoming.project.revision === pending.projectRevision &&
          incoming.latestSequence >= pending.latestSequence))
    ) {
      pendingActionAck.current = null;
      setSubmissionNotice(null);
    }
  }, []);
  const openMutation = trpc.workspace.siteOps.open.useMutation({
    onSuccess: acceptObservation,
  });
  const conversationId =
    observation?.project.conversationId ?? "siteops:pending";
  const pollCoordinate = observation
    ? [
        observation.project.revision,
        observation.latestSequence,
        observation.interactionState,
        observation.builds[0]?.updatedAt ?? "no-build",
        observation.rebuildRequest.status ?? "no-rebuild",
      ].join(":")
    : "idle";
  if (pollEpoch.current.coordinate !== pollCoordinate) {
    pollEpoch.current = { coordinate: pollCoordinate, startedAt: Date.now() };
  }
  const pollInterval = siteOpsPollIntervalMs(
    observation,
    Date.now() - pollEpoch.current.startedAt,
  );
  const observeQuery = trpc.workspace.siteOps.observe.useQuery(
    { conversationId },
    {
      enabled: Boolean(observation) && pageActive,
      retry: false,
      refetchOnMount: false,
      refetchOnWindowFocus: true,
      refetchInterval: pageActive ? pollInterval : false,
      refetchIntervalInBackground: false,
    },
  );
  const actMutation = trpc.workspace.siteOps.actFast.useMutation();
  const aliyunBeginMutation =
    trpc.workspace.siteOps.aliyunConnection.beginOAuth.useMutation();
  const aliyunDomainsQuery =
    trpc.workspace.siteOps.aliyunConnection.listDomains.useQuery(
      { conversationId },
      {
        enabled: observation?.aliyunConnection.status === "active",
        retry: false,
        refetchOnWindowFocus: true,
      },
    );
  const aliyunDisconnectMutation =
    trpc.workspace.siteOps.aliyunConnection.disconnect.useMutation();

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    openMutation.mutate(undefined);
  }, [openMutation]);

  useEffect(() => {
    const updatePageActivity = () => {
      setPageActive(!document.hidden && navigator.onLine);
    };
    document.addEventListener("visibilitychange", updatePageActivity);
    window.addEventListener("online", updatePageActivity);
    window.addEventListener("offline", updatePageActivity);
    return () => {
      document.removeEventListener("visibilitychange", updatePageActivity);
      window.removeEventListener("online", updatePageActivity);
      window.removeEventListener("offline", updatePageActivity);
    };
  }, []);

  useEffect(() => {
    if (!observeQuery.data) return;
    const generation = ++observeRequestGeneration.current;
    if (generation < acceptedObserveGeneration.current) return;
    acceptedObserveGeneration.current = generation;
    acceptObservation(observeQuery.data);
  }, [acceptObservation, observeQuery.data]);

  const requestError =
    openMutation.error?.message ||
    observeQuery.error?.message ||
    actMutation.error?.message ||
    aliyunBeginMutation.error?.message ||
    aliyunDisconnectMutation.error?.message ||
    null;

  return (
    <SiteOpsConversationPanel
      observation={observation}
      loading={openMutation.isPending}
      refreshing={observeQuery.isFetching}
      error={requestError}
      notice={submissionNotice}
      interactionPending={Boolean(pendingActionAck.current)}
      onRefresh={async () => {
        if (observation) {
          const refreshed = await observeQuery.refetch();
          if (refreshed.data) acceptObservation(refreshed.data);
          return;
        }
        acceptObservation(await openMutation.mutateAsync(undefined));
      }}
      onAction={async (input) => {
        if (!observation) return;
        const clientRequestId = siteOpsClientRequestId();
        const ack = await actMutation.mutateAsync({
          conversationId: observation.project.conversationId,
          clientRequestId,
          expectedRevision: observation.project.revision,
          action: input.action,
          input: input.input,
          ...(input.messageId ? { messageId: input.messageId } : {}),
          ...(input.cardKind ? { cardKind: input.cardKind } : {}),
        });
        pendingActionAck.current = {
          clientRequestId: ack.clientRequestId,
          projectRevision: ack.projectRevision,
          latestSequence: ack.latestSequence,
        };
        setSubmissionNotice("已提交，后台处理中。页面会自动更新，无需刷新。");
        const generation = ++observeRequestGeneration.current;
        void observeQuery.refetch({ cancelRefetch: true }).then((refreshed) => {
          if (
            !refreshed.data ||
            generation < acceptedObserveGeneration.current
          ) {
            return;
          }
          acceptedObserveGeneration.current = generation;
          acceptObservation(refreshed.data);
        });
      }}
      onBeginAliyun={async () => {
        if (!observation) {
          throw new Error(`${SITEOPS_CUSTOMER_DISPLAY_NAME}尚未就绪。`);
        }
        return await aliyunBeginMutation.mutateAsync({
          conversationId: observation.project.conversationId,
        });
      }}
      aliyunDomains={aliyunDomainsQuery.data?.domains ?? []}
      aliyunDomainsLoading={aliyunDomainsQuery.isLoading}
      aliyunDomainsError={aliyunDomainsQuery.error?.message ?? null}
      onRefreshAliyunDomains={async () => {
        await aliyunDomainsQuery.refetch();
      }}
      onDisconnectAliyun={async () => {
        if (!observation) return;
        await aliyunDisconnectMutation.mutateAsync({
          conversationId: observation.project.conversationId,
        });
        const refreshed = await observeQuery.refetch();
        if (refreshed.data) acceptObservation(refreshed.data);
      }}
      onSubmitIcpFiling={
        onSubmitIcpFiling
          ? async (input) => {
              await onSubmitIcpFiling(input);
              const refreshed = await observeQuery.refetch();
              if (refreshed.data) acceptObservation(refreshed.data);
            }
          : undefined
      }
    />
  );
}
