import axios from "axios";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RESPONSE_LOGIC_CUSTOMER_ATTACHMENT_LIMIT,
  ResponseLogicTaskBindingError,
  RESPONSE_LOGIC_SKILL_ATTACHMENT_FILENAME,
  RESPONSE_LOGIC_UPSTREAM_ATTACHMENT_LIMIT,
  assertResponseLogicAttachmentCapacity,
  assertResponseLogicTaskBinding,
  buildResponseLogicPrompt,
  buildResponseLogicEvidenceArchive,
  buildResponseLogicSkillArchive,
  buildResponseLogicTurnInputArchive,
  buildVerifiedResponseLogicAttachments,
  createResponseLogicFileIdempotencyKey,
  createResponseLogicTask,
  createResponseLogicTaskIdempotencyKey,
  extractFinalResponseLogicAssistantReply,
  normalizeResponseLogicTaskStatus,
  parseCompletedResponseLogicTask,
  publicResponseLogicTask,
  responseLogicEvidenceAttachmentFilename,
  responseLogicRecordMatchesConfiguredQuestion,
  responseLogicTurnInputAttachmentFilename,
} from "./response-logic-api";
import { assertResponseLogicDraftPublishable } from "./response-logic-service";
import {
  FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
  upstreamPromptCharacterCount,
} from "./upstream-prompt-budget";

const validStructuredReply = `## 用户真实关心
采购方需要判断方案是否可信。

## 核心结论/执行口径
先给出结论，再按证据解释。

## 企业材料/官方依据
- 企业知识库 V3

## 待补充/待确认
- 客户案例公开授权

## 回答边界/禁止表达
- 不使用绝对化排名

## 引用与核验规则
- 企业事实确认表.pdf

## 本轮确认
请确认案例是否可公开。`;

describe("response logic execution contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns only a credential-free allowlisted task DTO", () => {
    const credential = "sentinel-response-logic-credential";
    const task = publicResponseLogicTask(
      {
        id: "task-response-1",
        status: "running",
        model: "upstream-model",
        API_KEY: credential,
        metadata: {
          task_url: "https://tasks.example/task-response-1",
          task_title: `Draft ${credential}`,
          Authorization: `Bearer ${credential}`,
          accessToken: "another-token",
          arbitrary: "must-not-pass",
        },
        output: [
          {
            type: "message",
            text: `safe ${credential}`,
            nested: { Cookie: credential },
          },
        ],
        rawUpstreamField: "must-not-pass",
      },
      "task-response-1",
      credential,
    );
    const serialized = JSON.stringify(task);

    expect(task).toEqual({
      id: "task-response-1",
      status: "running",
      model: "upstream-model",
      metadata: {
        task_url: "https://tasks.example/task-response-1",
        task_title: "Draft [REDACTED]",
      },
      output: [
        {
          type: "message",
          text: "safe [REDACTED]",
          nested: {},
        },
      ],
    });
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain("rawUpstreamField");
    expect(serialized).not.toContain("arbitrary");
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized.toLowerCase()).not.toContain("cookie");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("api_key");
  });

  it("moves the selected question, draft and evidence identity into a deterministic input archive", async () => {
    const input = {
      value: {
        conversationId: "conv-response-1",
        questionId: "scenario-source",
        groupId: "scenario",
        groupTitle: "产品场景",
        question: "企业官网怎样成为 AI 可引用的权威信源？",
        intent: "用户希望提升官网的机器可理解性。",
        summary: "用可验证的事实与证据解释完整路径。",
        userMessage: "请先给出第一版应答逻辑。",
        attachments: [{ file_id: "file-1", filename: "企业事实确认表.pdf" }],
        draft: {
          concern: "",
          conclusion: "",
          facts: "",
          pending: "",
          boundaries: "",
          references: "",
          images: [],
          attachments: [],
        },
      },
      knowledgeSnapshot: {
        version: 3,
        sourceFileName: "企业知识库_V3.zip",
        documents: [
          {
            path: "01_company/profile.md",
            title: "企业简介",
            content: "这里是已经确认的企业事实。",
          },
        ],
        assets: [
          { path: "images/company.webp", mimeType: "image/webp", size: 2048 },
        ],
      },
    };
    const evidenceArchive = await buildResponseLogicEvidenceArchive(
      input.knowledgeSnapshot,
    );
    const evidenceFilename = responseLogicEvidenceAttachmentFilename(
      evidenceArchive.contentHash,
    );
    const turnInputArchive = await buildResponseLogicTurnInputArchive({
      ...input,
      evidenceAttachmentFilename: evidenceFilename,
    });
    const turnInputFilename = responseLogicTurnInputAttachmentFilename(
      turnInputArchive.contentHash,
    );
    const prompt = await buildResponseLogicPrompt({
      ...input,
      delivery: {
        turnInputAttachmentFilename: turnInputFilename,
        evidenceAttachmentFilename: evidenceFilename,
      },
    });

    expect(prompt).toContain("response-logic-builder");
    expect(prompt).toContain(RESPONSE_LOGIC_SKILL_ATTACHMENT_FILENAME);
    expect(prompt).toContain(evidenceFilename);
    expect(prompt).toContain(turnInputFilename);
    expect(prompt).not.toContain("企业官网怎样成为 AI 可引用的权威信源");
    expect(prompt).not.toContain("知识库版本：V3");
    expect(prompt).not.toContain("这里是已经确认的企业事实");
    expect(prompt).not.toContain("企业事实确认表.pdf");
    expect(prompt).toContain("不得输出内部思考");
    expect(upstreamPromptCharacterCount(prompt)).toBeLessThanOrEqual(
      FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
    );

    const skillArchive = await buildResponseLogicSkillArchive();
    const skillZip = await JSZip.loadAsync(skillArchive.bytes);
    const evidenceZip = await JSZip.loadAsync(evidenceArchive.bytes);
    const turnInputZip = await JSZip.loadAsync(turnInputArchive.bytes);
    expect(Object.keys(skillZip.files).sort()).toEqual([
      "MANIFEST.json",
      "SKILL.md",
      "references/output-contract.md",
    ]);
    expect(await evidenceZip.file("knowledge.md")!.async("string")).toContain(
      "这里是已经确认的企业事实",
    );
    const authoritativeInput = JSON.parse(
      await turnInputZip.file("turn-input.json")!.async("string"),
    );
    expect(authoritativeInput).toMatchObject({
      schemaVersion: 1,
      kind: "frontmind.response-logic.turn-input",
      question: {
        id: "scenario-source",
        groupId: "scenario",
        groupTitle: "产品场景",
        text: "企业官网怎样成为 AI 可引用的权威信源？",
      },
      knowledgeSnapshot: {
        available: true,
        version: 3,
        sourceFileName: "企业知识库_V3.zip",
        evidenceAttachment: evidenceFilename,
      },
      customerAttachments: [
        {
          index: 1,
          fileId: "file-1",
          filename: "企业事实确认表.pdf",
        },
      ],
      customerMessage: "请先给出第一版应答逻辑。",
      outputContract: {
        exactOrderedLevelTwoHeadings: [
          "用户真实关心",
          "核心结论/执行口径",
          "企业材料/官方依据",
          "待补充/待确认",
          "回答边界/禁止表达",
          "引用与核验规则",
          "本轮确认",
        ],
      },
    });

    const replayArchive = await buildResponseLogicTurnInputArchive({
      ...input,
      evidenceAttachmentFilename: evidenceFilename,
    });
    const revisedArchive = await buildResponseLogicTurnInputArchive({
      ...input,
      evidenceAttachmentFilename: evidenceFilename,
      value: {
        ...input.value,
        userMessage: "请按新证据修订当前版本。",
      },
    });
    expect(replayArchive.bytes.equals(turnInputArchive.bytes)).toBe(true);
    expect(
      responseLogicTurnInputAttachmentFilename(replayArchive.contentHash),
    ).toBe(turnInputFilename);
    expect(
      responseLogicTurnInputAttachmentFilename(revisedArchive.contentHash),
    ).not.toBe(turnInputFilename);
  });

  it("keeps the outbound prompt below 3000 characters at the maximum dynamic text sizes", async () => {
    const huge = "界".repeat(200_000);
    const input = {
      value: {
        conversationId: "c".repeat(191),
        questionId: "q".repeat(191),
        groupId: "g".repeat(128),
        groupTitle: "类".repeat(255),
        question: "问".repeat(2_000),
        intent: "意".repeat(8_000),
        summary: "目".repeat(8_000),
        userMessage: huge,
        attachments: Array.from(
          { length: RESPONSE_LOGIC_CUSTOMER_ATTACHMENT_LIMIT },
          (_, index) => ({
            file_id: `file-${index}-${"i".repeat(200)}`,
            filename: `${"资".repeat(500)}-${index}.pdf`,
            mime_type: "application/pdf",
          }),
        ),
        draft: {
          concern: huge,
          conclusion: "结".repeat(500_000),
          facts: "事".repeat(500_000),
          pending: "待".repeat(300_000),
          boundaries: "边".repeat(300_000),
          references: "引".repeat(500_000),
          images: [],
          attachments: [],
        },
      },
      knowledgeSnapshot: {
        version: Number.MAX_SAFE_INTEGER,
        sourceFileName: `${"知识".repeat(100_000)}.zip`,
        documents: [],
        assets: [],
      },
    };

    const evidenceArchive = await buildResponseLogicEvidenceArchive(
      input.knowledgeSnapshot,
    );
    const evidenceFilename = responseLogicEvidenceAttachmentFilename(
      evidenceArchive.contentHash,
    );
    const turnInputArchive = await buildResponseLogicTurnInputArchive({
      ...input,
      evidenceAttachmentFilename: evidenceFilename,
    });
    const turnInputFilename = responseLogicTurnInputAttachmentFilename(
      turnInputArchive.contentHash,
    );
    const prompt = await buildResponseLogicPrompt({
      ...input,
      delivery: {
        turnInputAttachmentFilename: turnInputFilename,
        evidenceAttachmentFilename: evidenceFilename,
      },
    });
    expect(upstreamPromptCharacterCount(prompt)).toBeLessThanOrEqual(
      FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
    );
    expect(prompt).not.toContain(huge.slice(0, 10_000));
    expect(prompt).toContain(turnInputFilename);
    expect(prompt).toContain(evidenceFilename);

    const turnInputZip = await JSZip.loadAsync(turnInputArchive.bytes);
    const authoritativeInput = JSON.parse(
      await turnInputZip.file("turn-input.json")!.async("string"),
    );
    expect(authoritativeInput.customerMessage).toHaveLength(200_000);
    expect(authoritativeInput.currentDraft.references).toHaveLength(500_000);
    expect(authoritativeInput.customerAttachments).toHaveLength(
      RESPONSE_LOGIC_CUSTOMER_ATTACHMENT_LIMIT,
    );
    expect(authoritativeInput.knowledgeSnapshot.sourceFileName).toBe(
      input.knowledgeSnapshot.sourceFileName,
    );
  });

  it("uses stable opaque idempotency keys and reserves room for every generated attachment", async () => {
    const taskIdempotencyKey = createResponseLogicTaskIdempotencyKey({
      userId: 42,
      conversationId: "conversation-1",
      questionId: "question-1",
      turnInputContentHash: "a".repeat(64),
      prompt: "bounded prompt",
      initialSkillContentHash: "b".repeat(64),
    });
    const replayKey = createResponseLogicTaskIdempotencyKey({
      userId: 42,
      conversationId: "conversation-1",
      questionId: "question-1",
      turnInputContentHash: "a".repeat(64),
      prompt: "bounded prompt",
      initialSkillContentHash: "b".repeat(64),
    });
    const changedKey = createResponseLogicTaskIdempotencyKey({
      userId: 42,
      conversationId: "conversation-1",
      questionId: "question-1",
      turnInputContentHash: "c".repeat(64),
      prompt: "bounded prompt",
      initialSkillContentHash: "b".repeat(64),
    });
    const fileKey = createResponseLogicFileIdempotencyKey({
      taskIdempotencyKey,
      role: "turn_input",
      contentHash: "a".repeat(64),
    });
    expect(taskIdempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(replayKey).toBe(taskIdempotencyKey);
    expect(changedKey).not.toBe(taskIdempotencyKey);
    expect(fileKey).toMatch(/^[a-f0-9]{64}$/);
    expect(fileKey).not.toBe(taskIdempotencyKey);

    expect(RESPONSE_LOGIC_CUSTOMER_ATTACHMENT_LIMIT).toBe(99);
    expect(RESPONSE_LOGIC_UPSTREAM_ATTACHMENT_LIMIT).toBe(102);
    expect(() =>
      assertResponseLogicAttachmentCapacity({
        generatedAttachmentCount: 3,
        customerAttachmentCount: 99,
      }),
    ).not.toThrow();
    expect(() =>
      assertResponseLogicAttachmentCapacity({
        generatedAttachmentCount: 3,
        customerAttachmentCount: 100,
      }),
    ).toThrow("attachment limit exceeded");

    const post = vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: { id: "task-response-idempotent", status: "created" },
    });
    await createResponseLogicTask({
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
      prompt: "bounded prompt",
      attachments: [],
      idempotencyKey: taskIdempotencyKey,
    });
    expect(post).toHaveBeenCalledWith(
      "https://api.example.test/v1/tasks",
      expect.objectContaining({ prompt: "bounded prompt" }),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": taskIdempotencyKey,
        }),
      }),
    );

    post.mockClear();
    await expect(
      createResponseLogicTask({
        baseUrl: "https://api.example.test",
        apiKey: "secret-test-key",
        prompt: "界".repeat(3_001),
        attachments: [],
        idempotencyKey: taskIdempotencyKey,
      }),
    ).rejects.toThrow("UPSTREAM_PROMPT_EXCEEDS_3000_CHARACTERS");
    expect(post).not.toHaveBeenCalled();
  });

  it("accepts only a completed Pro assistant reply with all seven ordered sections", () => {
    const structured = parseCompletedResponseLogicTask({
      id: "task-1",
      status: "completed",
      output: [
        {
          type: "reasoning",
          text: "这段内部推理不能进入草稿。",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: validStructuredReply }],
        },
      ],
    });

    expect(structured).toEqual({
      concern: "采购方需要判断方案是否可信。",
      conclusion: "先给出结论，再按证据解释。",
      facts: "- 企业知识库 V3",
      pending: "- 客户案例公开授权",
      boundaries: "- 不使用绝对化排名",
      references: "- 企业事实确认表.pdf",
      roundConfirmation: "请确认案例是否可公开。",
    });
    expect(
      extractFinalResponseLogicAssistantReply({
        output: [
          { type: "reasoning", text: "不能使用" },
          {
            type: "message",
            role: "assistant",
            content: validStructuredReply,
          },
        ],
      }),
    ).toBe(validStructuredReply);
  });

  it("observes fenced recovery without changing behavior until explicitly active", () => {
    const task = {
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: `\`\`\`markdown\n${validStructuredReply}\n\`\`\``,
        },
      ],
    };
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubEnv("FRONTMIND_RESPONSE_LOGIC_OUTPUT_REPAIR", "shadow");
    expect(() => parseCompletedResponseLogicTask(task)).toThrow();
    expect(log).toHaveBeenCalledWith(
      "[Model Output Repair]",
      expect.stringContaining("known_fence_removed"),
    );

    vi.stubEnv("FRONTMIND_RESPONSE_LOGIC_OUTPUT_REPAIR", "active");
    expect(parseCompletedResponseLogicTask(task)).toMatchObject({
      concern: "采购方需要判断方案是否可信。",
      roundConfirmation: "请确认案例是否可公开。",
    });
  });

  it("rejects missing, reordered, duplicate, extra and empty model sections", () => {
    const invalidOutputs = [
      validStructuredReply.replace(/## 本轮确认[\s\S]*$/, ""),
      validStructuredReply.replace(
        "## 核心结论/执行口径",
        "## 企业材料/官方依据",
      ),
      `${validStructuredReply}\n\n## 额外说明\n不允许`,
      validStructuredReply.replace(
        "## 待补充/待确认\n- 客户案例公开授权",
        "## 待补充/待确认\n",
      ),
      `模型前言\n${validStructuredReply}`,
    ];

    for (const output of invalidOutputs) {
      expect(() =>
        parseCompletedResponseLogicTask({
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: output,
            },
          ],
        }),
      ).toThrow();
    }
  });

  it("normalizes only known upstream task states", () => {
    expect(normalizeResponseLogicTaskStatus("in-progress")).toBe("running");
    expect(normalizeResponseLogicTaskStatus("succeeded")).toBe("completed");
    expect(normalizeResponseLogicTaskStatus("cancelled")).toBe("failed");
    expect(normalizeResponseLogicTaskStatus("mystery")).toBe("unknown");
  });

  it("binds status reads to the authenticated workspace, question, conversation and latest task", () => {
    const record = {
      id: "record-1",
      questionId: "question-1",
      groupId: "group-1",
      groupTitle: "产品场景",
      question: "如何回答？",
      intent: "核验",
      summary: "形成口径",
      conversationId: "conversation-1",
      lastTaskId: "task-1",
      draft: {
        concern: "",
        conclusion: "",
        facts: "",
        pending: "",
        boundaries: "",
        references: "",
        images: [],
        attachments: [],
      },
      version: 0,
      createdAt: 1,
      updatedAt: 2,
    };
    const configuredQuestion = {
      questionId: record.questionId,
      groupId: record.groupId,
      groupTitle: record.groupTitle,
      question: record.question,
      intent: record.intent,
      summary: record.summary,
    };
    expect(
      responseLogicRecordMatchesConfiguredQuestion({
        record,
        configuredQuestion,
      }),
    ).toBe(true);
    expect(
      responseLogicRecordMatchesConfiguredQuestion({
        record,
        configuredQuestion: {
          ...configuredQuestion,
          question: "管理员更新后的问题",
        },
      }),
    ).toBe(false);
    expect(() =>
      assertResponseLogicTaskBinding({
        authenticatedUserId: 7,
        workspaceUserId: 7,
        questionId: "question-1",
        conversationId: "conversation-1",
        taskId: "task-1",
        record,
        configuredQuestion,
      }),
    ).not.toThrow();

    for (const invalid of [
      { workspaceUserId: 8 },
      { questionId: "question-2" },
      { conversationId: "conversation-2" },
      { taskId: "task-2" },
      {
        configuredQuestion: {
          ...configuredQuestion,
          question: "管理员更新后的问题",
        },
      },
    ]) {
      expect(() =>
        assertResponseLogicTaskBinding({
          authenticatedUserId: 7,
          workspaceUserId: 7,
          questionId: "question-1",
          conversationId: "conversation-1",
          taskId: "task-1",
          record,
          configuredQuestion,
          ...invalid,
        }),
      ).toThrow(ResponseLogicTaskBindingError);
    }
  });

  it("normalizes verified upload metadata without persisting browser URLs", () => {
    const attachments = buildVerifiedResponseLogicAttachments(
      [
        {
          file_id: "file-image",
          filename: "evidence.PNG",
          mime_type: "application/octet-stream",
        },
        {
          file_id: "file-sheet",
          filename: "facts.xlsx",
          mime_type:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ],
      new Date("2026-07-23T10:00:00.000Z"),
    );

    expect(attachments).toEqual([
      {
        fileId: "file-image",
        filename: "evidence.PNG",
        mimeType: "image/png",
        kind: "image",
        uploadedAt: "2026-07-23T10:00:00.000Z",
      },
      {
        fileId: "file-sheet",
        filename: "facts.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        kind: "file",
        uploadedAt: "2026-07-23T10:00:00.000Z",
      },
    ]);
  });

  it("projects the immutable server file deadline into response-logic attachments", () => {
    const uploadedAt = new Date("2026-07-01T00:00:00.000Z");
    const contentExpiresAt = new Date("2026-07-31T00:00:00.000Z");
    const attachments = buildVerifiedResponseLogicAttachments(
      [
        {
          file_id: " file/opaque?# ",
          filename: "证据.pdf",
          mime_type: "application/pdf",
        },
      ],
      new Map([
        [
          " file/opaque?# ",
          {
            uploadedAt,
            contentExpiresAt,
            contentDeletedAt: new Date("2026-07-31T01:00:00.000Z"),
          },
        ],
      ]),
    );

    expect(attachments).toEqual([
      expect.objectContaining({
        fileId: " file/opaque?# ",
        uploadedAt: uploadedAt.toISOString(),
        expiresAt: contentExpiresAt.getTime(),
        expired: true,
      }),
    ]);
  });

  it("does not publish an incomplete response logic draft", () => {
    expect(() =>
      assertResponseLogicDraftPublishable({
        concern: "用户需要判断服务是否适配",
        conclusion: "",
        facts: "",
        pending: "",
        boundaries: "",
        references: "",
        images: [],
        attachments: [],
      }),
    ).toThrow("请先补齐以下应答逻辑内容");
  });
});
