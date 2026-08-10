import { KnowledgeBaseArtifactBindingError } from "./knowledge-base-artifact-binding-service";

export class KnowledgeBaseLocalPreparationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KnowledgeBaseLocalPreparationError";
  }
}

export function knowledgeBaseArtifactFailureNotice(error: unknown) {
  if (
    error instanceof KnowledgeBaseArtifactBindingError &&
    error.code === "PACKAGE_INVALID"
  ) {
    const reason = error.message
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .trim()
      .slice(0, 600);
    return {
      code: "FINAL_PACKAGE_INVALID",
      message: `最终知识库 ZIP 不符合 Dashboard v4 归档合同：${reason || "结构或素材不完整"}。本轮未推进；请重试本轮，系统会重新提供权威正文与全部素材，并要求生成端通过同一校验器后再交付。`,
    } as const;
  }
  return {
    code: "PROGRESS_PROTOCOL_INVALID",
    message: "知识库资源校验未通过，本轮内容尚未更新",
  } as const;
}

export function classifyKnowledgeBaseOpenRecoveryFailure(
  status:
    | "researching"
    | "confirming"
    | "ready_to_publish"
    | "published"
    | "protocol_error"
    | "failed",
  protocolErrorCode?: string | null,
) {
  return status === "ready_to_publish" ||
    (status === "protocol_error" &&
      protocolErrorCode === "PACKAGE_REBIND_REQUIRED")
    ? ("package_rebind_required" as const)
    : ("fatal" as const);
}

export class KnowledgeBaseOpenRecoveryLeaseError extends Error {
  readonly code = "KNOWLEDGE_BASE_OPEN_RECOVERY_LEASE_LOST";

  constructor(
    message = "Knowledge-base open recovery lease was lost",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KnowledgeBaseOpenRecoveryLeaseError";
  }
}

export const KNOWLEDGE_BASE_AGENT_PROFILE = "frontmind-pro" as const;
export const KNOWLEDGE_BASE_UPSTREAM_CREATE_TIMEOUT_MS = 120_000;

export type KnowledgeBaseUpstreamCreateFailureClass =
  | "deterministic"
  | "retriable"
  | "unknown";

/** Classify whether an upstream create was rejected or may have been accepted. */
export function classifyKnowledgeBaseUpstreamCreateFailure(input: {
  status?: unknown;
  code?: unknown;
  missingTaskId?: boolean;
  transportError?: boolean;
}): KnowledgeBaseUpstreamCreateFailureClass {
  // A successful HTTP response without a readable id may have created the
  // task while returning a partial body. Preserve the same idempotency key and
  // let recovery reconcile it; never invite a second logical turn.
  if (input.missingTaskId) return "unknown";
  if (input.transportError) return "unknown";
  const status = Number(input.status);
  if (!Number.isInteger(status) || status <= 0) return "unknown";
  const code = String(input.code || "")
    .trim()
    .toUpperCase();
  return code === "IDEMPOTENCY_PENDING" ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
    ? "retriable"
    : "deterministic";
}

export class KnowledgeBaseUpstreamCreateError extends Error {
  constructor(
    public readonly failureClass: KnowledgeBaseUpstreamCreateFailureClass,
    public readonly failureCode: string,
    public readonly status?: number,
  ) {
    super("Knowledge-base upstream task creation failed");
    this.name = "KnowledgeBaseUpstreamCreateError";
  }
}
