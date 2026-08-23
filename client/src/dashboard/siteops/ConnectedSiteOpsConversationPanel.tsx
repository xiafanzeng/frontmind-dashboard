import type { SiteOpsObservationV1 } from "@shared/siteops-contract";
import { SITEOPS_CUSTOMER_DISPLAY_NAME } from "@shared/siteops-branding";
import { useEffect, useRef, useState } from "react";
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
  const openMutation = trpc.workspace.siteOps.open.useMutation({
    onSuccess: setObservation,
  });
  const conversationId =
    observation?.project.conversationId ?? "siteops:pending";
  const shouldPoll = Boolean(
    observation &&
      (POLLING_STATES.has(observation.interactionState) ||
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
  const sendMessageMutation = trpc.workspace.siteOps.sendMessage.useMutation({
    onSuccess: setObservation,
  });
  const actMutation = trpc.workspace.siteOps.act.useMutation({
    onSuccess: setObservation,
  });
  const aliyunBeginMutation =
    trpc.workspace.siteOps.aliyunConnection.beginOAuth.useMutation();
  const aliyunAuthorizationGuideQuery =
    trpc.workspace.siteOps.aliyunConnection.authorizationGuide.useQuery(
      { conversationId },
      { enabled: false, retry: false },
    );
  const aliyunVerifyMutation =
    trpc.workspace.siteOps.aliyunConnection.verifyRole.useMutation();
  const aliyunDisconnectMutation =
    trpc.workspace.siteOps.aliyunConnection.disconnect.useMutation();

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    openMutation.mutate(undefined);
  }, [openMutation]);

  useEffect(() => {
    if (observeQuery.data) setObservation(observeQuery.data);
  }, [observeQuery.data]);

  const requestError =
    openMutation.error?.message ||
    observeQuery.error?.message ||
    sendMessageMutation.error?.message ||
    actMutation.error?.message ||
    aliyunBeginMutation.error?.message ||
    aliyunAuthorizationGuideQuery.error?.message ||
    aliyunVerifyMutation.error?.message ||
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
          if (refreshed.data) setObservation(refreshed.data);
          return;
        }
        setObservation(await openMutation.mutateAsync(undefined));
      }}
      onSendMessage={async (text) => {
        if (!observation) return;
        setObservation(
          await sendMessageMutation.mutateAsync({
            conversationId: observation.project.conversationId,
            clientRequestId: siteOpsClientRequestId(),
            text,
            localAssetIds: [],
            expectedProjectRevision: observation.project.revision,
          }),
        );
      }}
      onAction={async (input) => {
        if (!observation) return;
        setObservation(
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
      onVerifyAliyun={async () => {
        if (!observation) return;
        await aliyunVerifyMutation.mutateAsync({
          conversationId: observation.project.conversationId,
        });
        const refreshed = await observeQuery.refetch();
        if (refreshed.data) setObservation(refreshed.data);
      }}
      onDisconnectAliyun={async () => {
        if (!observation) return;
        await aliyunDisconnectMutation.mutateAsync({
          conversationId: observation.project.conversationId,
        });
        const refreshed = await observeQuery.refetch();
        if (refreshed.data) setObservation(refreshed.data);
      }}
      onSubmitIcpFiling={
        onSubmitIcpFiling
          ? async (input) => {
              await onSubmitIcpFiling(input);
              const refreshed = await observeQuery.refetch();
              if (refreshed.data) setObservation(refreshed.data);
            }
          : undefined
      }
    />
  );
}
