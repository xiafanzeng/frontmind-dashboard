import { describe, expect, it, vi } from "vitest";
import {
  KNOWLEDGE_BASE_FOUNDATION_COPY,
  knowledgeBaseNoticeRecoveryMode,
  knowledgeBaseNoticeRetryLabel,
  knowledgeBasePackageRebindResolved,
  recoverKnowledgeBaseNotice,
} from "./ChatArea";

describe("knowledge-base starter", () => {
  it("explains why the knowledge base must be built before the first task", () => {
    expect(KNOWLEDGE_BASE_FOUNDATION_COPY).toContain("AI 专用友好官网");
    expect(KNOWLEDGE_BASE_FOUNDATION_COPY).toContain("准确回答客户问题");
  });
});

describe("knowledge-base notice recovery", () => {
  const input = {
    conversationId: "knowledge-conversation",
    clientRequestId: "retry-request",
    expectedGeneration: 3,
    expectedRevision: 8,
    expectedLeafId: null,
  };

  it("reconciles PACKAGE_REBIND_REQUIRED against the same task without creating a turn", async () => {
    const observation = { interaction: { progress: null } } as any;
    const reconcile = vi.fn().mockResolvedValue(observation);
    const retry = vi.fn();

    await expect(
      recoverKnowledgeBaseNotice(
        {
          ...input,
          notice: { code: "PACKAGE_REBIND_REQUIRED" },
        },
        { reconcile, retry },
      ),
    ).resolves.toBe(observation);

    expect(reconcile).toHaveBeenCalledWith({
      conversationId: "knowledge-conversation",
    });
    expect(retry).not.toHaveBeenCalled();
    expect(
      knowledgeBaseNoticeRecoveryMode({ code: "PACKAGE_REBIND_REQUIRED" }),
    ).toBe("reconcile");
    expect(
      knowledgeBaseNoticeRetryLabel({ code: "PACKAGE_REBIND_REQUIRED" }),
    ).toBe("重新绑定成品");
    expect(
      knowledgeBasePackageRebindResolved({
        ...observation,
        notice: {
          code: "PACKAGE_REBIND_REQUIRED",
          key: "rebind",
          severity: "error",
          message: "仍在等待 ZIP",
          retryable: true,
          turnId: null,
          createdAt: 1,
        },
        package: null,
      }),
    ).toBe(false);
    expect(
      knowledgeBasePackageRebindResolved({
        ...observation,
        notice: null,
        package: { sha256: "a".repeat(64) },
        interaction: { interactionState: "ready_to_publish" },
      }),
    ).toBe(true);
  });

  it("keeps ordinary retryable protocol failures on the new-turn path", async () => {
    const observation = { interaction: { progress: null } } as any;
    const reconcile = vi.fn();
    const retry = vi.fn().mockResolvedValue(observation);

    await expect(
      recoverKnowledgeBaseNotice(
        {
          ...input,
          expectedLeafId: "1.4",
          notice: { code: "PROGRESS_PROTOCOL_INVALID" },
        },
        { reconcile, retry },
      ),
    ).resolves.toBe(observation);

    expect(reconcile).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({
      conversationId: "knowledge-conversation",
      clientRequestId: "retry-request",
      expectedGeneration: 3,
      expectedRevision: 8,
      expectedLeafId: "1.4",
    });
    expect(
      knowledgeBaseNoticeRetryLabel({ code: "PROGRESS_PROTOCOL_INVALID" }),
    ).toBe("重试本轮");
  });
});
