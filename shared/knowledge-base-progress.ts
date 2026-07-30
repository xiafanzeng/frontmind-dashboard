export const knowledgeBaseLeafStatuses = [
  "pending",
  "current",
  "confirmed",
  "direct_prefilled",
  "needs_verification",
] as const;

export type KnowledgeBaseLeafStatus =
  (typeof knowledgeBaseLeafStatuses)[number];

export const knowledgeBaseBuildStatuses = [
  "researching",
  "confirming",
  "ready_to_publish",
  "published",
  "protocol_error",
  "failed",
] as const;

export type KnowledgeBaseBuildStatus =
  (typeof knowledgeBaseBuildStatuses)[number];

export const knowledgeBaseInteractionStates = [
  "queued",
  "executing",
  "awaiting_input",
  "ready_to_publish",
  "published",
  "failed",
] as const;

export type KnowledgeBaseInteractionState =
  (typeof knowledgeBaseInteractionStates)[number];

export interface KnowledgeBaseProgressLeafDto {
  id: string;
  title: string;
  branchId: string;
  branchTitle: string;
  ordinal: number;
  status: KnowledgeBaseLeafStatus;
}

export interface KnowledgeBaseProgressBranchDto {
  id: string;
  title: string;
  total: number;
  handled: number;
  confirmed: number;
  directPrefilled: number;
  pending: number;
  current: number;
  needsVerification: number;
  leaves: KnowledgeBaseProgressLeafDto[];
}

export interface KnowledgeBaseProgressSummaryDto {
  total: number;
  handled: number;
  confirmed: number;
  directPrefilled: number;
  pending: number;
  current: number;
  needsVerification: number;
  overallPercent: number;
}

export interface KnowledgeBaseProgressDto {
  build: {
    id: string;
    conversationId: string;
    companyName: string;
    status: KnowledgeBaseBuildStatus;
    revision: number;
    currentLeafId: string | null;
    protocolError: string | null;
    awaitingResponseSince?: number | null;
    updatedAt: number;
  };
  summary: KnowledgeBaseProgressSummaryDto;
  branches: KnowledgeBaseProgressBranchDto[];
  packageAllowed: boolean;
}

/**
 * Customer interaction state is intentionally separate from the upstream task
 * execution status. A long-running task can already be waiting for the next
 * customer confirmation while the provider still reports pending/running.
 */
export interface KnowledgeBaseInteractionDto {
  progress: KnowledgeBaseProgressDto | null;
  interactionState: KnowledgeBaseInteractionState;
  canReply: boolean;
  canPublish: boolean;
  lockReason: string | null;
}
