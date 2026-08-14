import { describe, expect, it } from "vitest";

import { toKnowledgeBasePublicPayload } from "./knowledge-base-public-projection";

describe("knowledge-base customer public projection", () => {
  it("removes raw protocol failures, provider urls and internal notice codes", () => {
    const payload = toKnowledgeBasePublicPayload({
      progress: {
        build: {
          status: "protocol_error",
          protocolError:
            "Manus 明确拒绝了当前请求；系统不会自动重发，请联系支持处理",
        },
      },
      observation: {
        canonicalTaskUrl: "https://open.manus.ai/task/private-task-id",
        interaction: {
          lockReason: "Manus 明确拒绝了当前请求",
        },
        notice: {
          key: "build:MANUS_V2_TASK_ERROR",
          code: "MANUS_V2_TASK_ERROR",
          message:
            "系统正在恢复当前操作。Manus 明确拒绝了当前请求。",
          severity: "warning",
          retryable: false,
          failureClass: "terminal_nonregenerable",
          recoveryAction: "contact_support",
          turnId: "provider-turn-id",
          createdAt: 1_753_200_000_000,
        },
      },
    });

    expect(payload.progress.build.protocolError).toBeNull();
    expect(payload.observation.canonicalTaskUrl).toBeNull();
    expect(payload.observation.interaction.lockReason).toBe(
      "FrontMind 明确拒绝了当前请求",
    );
    expect(payload.observation.notice).toMatchObject({
      code: "FRONTMIND_KB_STOPPED",
      message: "本轮已停止，不会自动重发。已完成内容不受影响。",
      turnId: null,
    });
    expect(payload.observation.notice.key).toMatch(/^frontmind-kb:[A-F0-9]{12}$/u);
    expect(JSON.stringify(payload)).not.toMatch(/manus/iu);
    expect(JSON.stringify(payload)).not.toContain("系统正在恢复当前操作");
  });

  it("maps actionable historical notices to a provider-neutral action", () => {
    const payload = toKnowledgeBasePublicPayload({
      notice: {
        key: "MANUS_V2_LOCAL_REHYDRATE_REJECTED",
        code: "MANUS_V2_LOCAL_REHYDRATE_REJECTED",
        message: "raw provider notice",
        recoveryAction: "create_new_canonical_from_snapshot",
        failureClass: "requires_user_fix",
        retryable: true,
        createdAt: 1,
      },
    });

    expect(payload.notice).toMatchObject({
      code: "FRONTMIND_KB_NEW_GENERATION_REQUIRED",
      message:
        "需要你确认后创建一个新的 FrontMind 任务继续。已完成内容不受影响。",
    });
    expect(JSON.stringify(payload)).not.toMatch(/manus/iu);
  });

  it("publishes only the opaque explicit token and provider-neutral action", () => {
    const payload = toKnowledgeBasePublicPayload({
      notice: {
        key: "private-source-turn",
        code: "MANUS_V2_CREATE_REJECTED",
        message: "raw provider notice",
        recoveryAction: "retry_request",
        recoveryToken: "a".repeat(64),
        sourceTurnId: "private-source-turn",
        credentialId: "private-credential",
        retryable: true,
        createdAt: 1,
      },
    });

    expect(payload.notice).toMatchObject({
      code: "FRONTMIND_KB_RETRY_AVAILABLE",
      recoveryAction: "retry_request",
      recoveryToken: "a".repeat(64),
      turnId: null,
    });
    expect(payload.notice).not.toHaveProperty("sourceTurnId");
    expect(payload.notice).not.toHaveProperty("credentialId");
  });

  it("maps internal upstream error codes to the public FrontMind code", () => {
    const payload = toKnowledgeBasePublicPayload({
      error: {
        code: "UPSTREAM_TASK_READ_FAILED",
        message: "读取知识库任务结果失败，正在自动重试",
      },
    });

    expect(payload.error.code).toBe("FRONTMIND_KB_RETRY_AVAILABLE");
    expect(JSON.stringify(payload)).not.toMatch(/upstream/iu);
  });
});
