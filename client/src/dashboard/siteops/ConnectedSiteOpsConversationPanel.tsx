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

const PENDING_DOMAIN_OPERATION_STATES = new Set([
  "reserved",
  "submitted",
  "reconciling",
  "outcome_unknown",
]);

const PENDING_SOCIAL_PACKAGE_STATES = new Set([
  "queued",
  "building",
  "qa_running",
]);

export function siteOpsClientRequestId() {
  return crypto.randomUUID();
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
  // Claiming the resumed build does not need another project revision or
  // customer message. At an equal cursor, accept only the one-way transition
  // from a clickable recovery to the active operation and reject a late poll
  // that would make the primary action clickable again.
  const currentRecoveryAvailable = current.buildRecovery?.allowed === true;
  const incomingRecoveryActive =
    incoming.buildRecovery?.reason === "active_operation";
  if (currentRecoveryAvailable && incomingRecoveryActive) return incoming;
  if (
    current.buildRecovery?.reason === "active_operation" &&
    incoming.buildRecovery?.allowed === true
  ) {
    return current;
  }
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
  const [observation, setObservation] = useState<SiteOpsObservationV1 | null>(
    null,
  );
  const acceptObservation = useCallback((incoming: SiteOpsObservationV1) => {
    setObservation((current) => newestSiteOpsObservation(current, incoming));
  }, []);
  const openMutation = trpc.workspace.siteOps.open.useMutation({
    onSuccess: acceptObservation,
  });
  const conversationId =
    observation?.project.conversationId ?? "siteops:pending";
  const shouldPoll = Boolean(
    observation &&
      (POLLING_STATES.has(observation.interactionState) ||
        observation.visualGeneration.status === "generating" ||
        observation.deployments.some((item) =>
          PENDING_DEPLOYMENT_STATES.has(item.status),
        ) ||
        observation.domainOperations.some((item) =>
          PENDING_DOMAIN_OPERATION_STATES.has(item.status),
        ) ||
        observation.socialPackages.some((item) =>
          PENDING_SOCIAL_PACKAGE_STATES.has(item.status),
        )),
  );
  const observeQuery = trpc.workspace.siteOps.observe.useQuery(
    { conversationId },
    {
      enabled: Boolean(observation),
      retry: false,
      refetchOnMount: false,
      refetchOnWindowFocus: true,
      refetchInterval: shouldPoll ? 3_000 : false,
    },
  );
  const actMutation = trpc.workspace.siteOps.act.useMutation({
    onSuccess: acceptObservation,
  });
  const aliyunBeginMutation =
    trpc.workspace.siteOps.aliyunConnection.beginOAuth.useMutation();
  const aliyunAuthorizationGuideQuery =
    trpc.workspace.siteOps.aliyunConnection.authorizationGuide.useQuery(
      { conversationId },
      { enabled: false, retry: false },
    );
  const aliyunStartRoleProvisioningMutation =
    trpc.workspace.siteOps.aliyunConnection.startRoleProvisioning.useMutation();
  const aliyunProbeRoleMutation =
    trpc.workspace.siteOps.aliyunConnection.probeRole.useMutation();
  const aliyunDisconnectMutation =
    trpc.workspace.siteOps.aliyunConnection.disconnect.useMutation();

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    openMutation.mutate(undefined);
  }, [openMutation]);

  useEffect(() => {
    if (observeQuery.data) acceptObservation(observeQuery.data);
  }, [acceptObservation, observeQuery.data]);

  const requestError =
    openMutation.error?.message ||
    observeQuery.error?.message ||
    actMutation.error?.message ||
    aliyunBeginMutation.error?.message ||
    aliyunAuthorizationGuideQuery.error?.message ||
    aliyunDisconnectMutation.error?.message ||
    null;

  return (
    <SiteOpsConversationPanel
      observation={observation}
      loading={openMutation.isPending}
      refreshing={observeQuery.isFetching}
      error={requestError}
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
        acceptObservation(
          await actMutation.mutateAsync({
            conversationId: observation.project.conversationId,
            clientRequestId: siteOpsClientRequestId(),
            expectedRevision: observation.project.revision,
            action: input.action,
            input: input.input,
            ...(input.messageId ? { messageId: input.messageId } : {}),
            ...(input.cardKind ? { cardKind: input.cardKind } : {}),
          }),
        );
      }}
      onBeginAliyun={async () => {
        if (!observation) {
          throw new Error(`${SITEOPS_CUSTOMER_DISPLAY_NAME}尚未就绪。`);
        }
        return await aliyunBeginMutation.mutateAsync({
          conversationId: observation.project.conversationId,
        });
      }}
      onLoadAliyunAuthorizationGuide={async () => {
        if (!observation) {
          throw new Error(`${SITEOPS_CUSTOMER_DISPLAY_NAME}尚未就绪。`);
        }
        const guide = await aliyunAuthorizationGuideQuery.refetch();
        if (!guide.data) {
          throw new Error("阿里云授权配置尚未就绪，请联系 FrontMind。");
        }
        return guide.data;
      }}
      onStartAliyunRoleProvisioning={async () => {
        if (!observation) {
          throw new Error(`${SITEOPS_CUSTOMER_DISPLAY_NAME}尚未就绪。`);
        }
        return await aliyunStartRoleProvisioningMutation.mutateAsync({
          conversationId: observation.project.conversationId,
        });
      }}
      onProbeAliyunRole={async () => {
        if (!observation) {
          throw new Error(`${SITEOPS_CUSTOMER_DISPLAY_NAME}尚未就绪。`);
        }
        return await aliyunProbeRoleMutation.mutateAsync({
          conversationId: observation.project.conversationId,
        });
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
