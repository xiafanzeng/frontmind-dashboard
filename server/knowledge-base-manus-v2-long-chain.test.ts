import { createHash } from "node:crypto";

import type { AxiosInstance } from "axios";
import { describe, expect, it, vi } from "vitest";

import {
  conversations,
  conversationTurns,
  knowledgeBaseBuilds,
  upstreamResources,
  type ConversationTurn,
  type KnowledgeBaseBuild,
  type KnowledgeBaseBuildNode,
} from "../drizzle/schema";
import {
  appendManusV2KnowledgeBaseOperationContract,
  buildManusV2KnowledgeBaseStructuredOutputSchema,
  ManusV2Client,
  manusV2KnowledgeBaseStructuredResultForOperation,
  normalizeManusV2Output,
  type ManusV2KnowledgeBaseOperationContract,
  type ManusV2KnowledgeBaseStructuredResult,
  type ManusV2MessageEvent,
} from "./manus-v2-client";
import {
  beginKnowledgeBaseManusV2Dispatch,
  bindKnowledgeBaseManusV2Submission,
  KnowledgeBaseTurnReservationError,
} from "./knowledge-base-turn-service";
import {
  buildDashboardOwnedKnowledgePackage,
  readDashboardOwnedKnowledgePackage,
} from "./knowledge-base-local-package";
import { knowledgeBaseMarkdownSha256 } from "./knowledge-base-package-validation";

const BUILD_ID = "123e4567-e89b-42d3-a456-426614174115";
const CANONICAL_TASK_ID = "canonical-task-115";
const MANUS_BASE_URL = "https://api.manus-v2.test";
const NODE_COUNT = 115;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function turnId(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function leafId(index: number) {
  return `leaf-${String(index).padStart(3, "0")}`;
}

function leaseOwnerHash(leaseToken: string) {
  return sha256(leaseToken);
}

type MutableBuild = Pick<
  KnowledgeBaseBuild,
  | "id"
  | "userId"
  | "companyName"
  | "providerProtocol"
  | "canonicalTaskId"
  | "canonicalTaskGeneration"
  | "canonicalCredentialId"
  | "canonicalTaskState"
  | "canonicalTaskUrl"
  | "canonicalTaskCreatedAt"
  | "upstreamTaskId"
  | "generation"
  | "stateEpoch"
  | "activeTurnId"
  | "revision"
  | "currentLeafId"
  | "status"
  | "contentCompletedAt"
  | "packageStatus"
  | "logoStorageKey"
>;

/**
 * A serialized transaction harness for the two production writer-fence
 * functions used below. Serializing transactions models MySQL's FOR UPDATE
 * behavior, so two devices racing the same operation cannot both acquire the
 * provider side effect.
 */
function createWriterFenceHarness(build: MutableBuild) {
  const state: {
    build: MutableBuild;
    turn: ConversationTurn | null;
    conversation: {
      id: string;
      userId: number;
      projectAssignmentId: string | null;
    };
    resources: Array<Record<string, unknown>>;
  } = {
    build,
    turn: null,
    conversation: {
      id: "u1:manus-v2-long-chain",
      userId: 1,
      projectAssignmentId: null,
    },
    resources: [],
  };
  let transactionTail: Promise<void> = Promise.resolve();

  function selectedRows(table: unknown) {
    if (table === knowledgeBaseBuilds) return [state.build];
    if (table === conversationTurns) return state.turn ? [state.turn] : [];
    if (table === conversations) return [state.conversation];
    if (table === upstreamResources) return state.resources;
    return [];
  }

  const executor = {
    transaction<T>(run: (tx: any) => Promise<T>): Promise<T> {
      const transaction = transactionTail.then(async () => {
        const snapshot = structuredClone(state);
        const tx = {
          select: () => ({
            from: (table: unknown) => ({
              where: () => {
                const rows = () => selectedRows(table);
                return {
                  limit: () => ({
                    for: async () => rows(),
                    then: (
                      resolve: (value: unknown) => unknown,
                      reject: (reason: unknown) => unknown,
                    ) => Promise.resolve(rows()).then(resolve, reject),
                  }),
                };
              },
            }),
          }),
          update: (table: unknown) => ({
            set: (values: Record<string, unknown>) => ({
              where: async () => {
                if (table === knowledgeBaseBuilds) {
                  Object.assign(state.build, values);
                } else if (table === conversationTurns && state.turn) {
                  Object.assign(state.turn, values);
                }
                return [{ affectedRows: 1 }];
              },
            }),
          }),
          insert: (table: unknown) => ({
            values: async (values: Record<string, unknown>) => {
              if (table === upstreamResources) {
                state.resources.push({ ...values });
              }
              return [{ affectedRows: 1 }];
            },
          }),
        };
        try {
          return await run(tx);
        } catch (error) {
          state.build = snapshot.build;
          state.turn = snapshot.turn;
          state.conversation = snapshot.conversation;
          state.resources = snapshot.resources;
          throw error;
        }
      });
      transactionTail = transaction.then(
        () => undefined,
        () => undefined,
      );
      return transaction;
    },
  };

  return {
    executor,
    state,
    installTurn(nextTurn: ConversationTurn) {
      state.turn = nextTurn;
      state.build.activeTurnId = nextTurn.id;
    },
  };
}

function operationTurn(input: {
  index: number;
  operationToken: string;
  operationType: string;
  expectedRevision: number;
  expectedLeafId: string | null;
  leaseToken: string;
}): ConversationTurn {
  const now = new Date("2026-08-12T00:00:00.000Z");
  return {
    id: turnId(input.index),
    conversationId: "u1:manus-v2-long-chain",
    userId: 1,
    apiCredentialId: "credential-1",
    clientRequestId: `long-chain-${input.index}`,
    buildId: BUILD_ID,
    buildGeneration: 1,
    operationKey: input.operationToken,
    operationType: input.operationType,
    expectedRevision: input.expectedRevision,
    expectedLeafId: input.expectedLeafId,
    requestHash: sha256(`request:${input.operationToken}`),
    upstreamIdempotencyKeyHash: sha256(`upstream:${input.operationToken}`),
    attachmentFileIds: [],
    metadata: {
      attachmentsFrozen: true,
      createAttemptState: "not_sent",
      providerProtocol: "manus_v2",
      providerAttemptState: "not_sent",
      operationToken: input.operationToken,
      leaseOwnerHash: leaseOwnerHash(input.leaseToken),
    },
    leaseExpiresAt: new Date("2026-08-12T00:10:00.000Z"),
    model: null,
    status: "queued",
    upstreamTaskId: null,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

type ProviderCall = {
  method: "task.create" | "task.sendMessage";
  body: Record<string, any>;
};

/**
 * In-memory Manus v2 provider. Message pages are deliberately small,
 * reverse-ordered, and overlap by one event. The production client must page,
 * sort and deduplicate them before accepting an operation result.
 */
function createFakeManusProvider() {
  const calls: ProviderCall[] = [];
  const events: ManusV2MessageEvent[] = [];
  const queuedResults = new Map<string, ManusV2KnowledgeBaseStructuredResult>();
  const pageRequests: Array<string | null> = [];
  let timestamp = 1;

  function operationTokenFromPrompt(prompt: string) {
    const line = prompt
      .split("\n")
      .find((value) =>
        value.startsWith("FRONTMIND_MANUS_V2_OPERATION_CONTRACT="),
      );
    if (!line) throw new Error("fake provider received no operation contract");
    return String(
      JSON.parse(line.slice(line.indexOf("=") + 1)).operationToken || "",
    );
  }

  const post = vi.fn(async (url: string, rawBody: unknown) => {
    const body = rawBody as Record<string, any>;
    const method = url.endsWith("/v2/task.create")
      ? "task.create"
      : url.endsWith("/v2/task.sendMessage")
        ? "task.sendMessage"
        : null;
    if (!method) throw new Error(`unexpected fake Manus POST: ${url}`);
    if (method === "task.sendMessage" && body.task_id !== CANONICAL_TASK_ID) {
      throw new Error("continuation escaped the canonical task");
    }
    if (!body.structured_output_schema) {
      throw new Error("structured_output_schema missing from Manus request");
    }
    const textPart = body.message?.content?.find(
      (part: Record<string, unknown>) => part.type === "text",
    );
    const prompt = String(textPart?.text || "");
    const operationToken = operationTokenFromPrompt(prompt);
    const result = queuedResults.get(operationToken);
    if (!result) throw new Error(`no fake result for ${operationToken}`);

    const schema = body.structured_output_schema as Record<string, any>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toMatchObject({
      operationToken: { enum: [result.operationToken] },
      turnId: { enum: [result.turnId] },
      generation: { enum: [result.generation] },
      baseRevision: { enum: [result.baseRevision] },
      action: { enum: [result.action] },
      fromLeafId: { enum: [result.fromLeafId] },
      contentCompleted: { enum: [result.contentCompleted] },
    });

    calls.push({ method, body });
    events.push({
      id: `event-${String(timestamp).padStart(4, "0")}`,
      type: "user_message",
      timestamp: timestamp++,
      user_message: { content: prompt },
    });
    events.push({
      id: `event-${String(timestamp).padStart(4, "0")}`,
      type: "structured_output_result",
      timestamp: timestamp++,
      structured_output_result: { success: true, value: result },
    });
    events.push({
      id: `event-${String(timestamp).padStart(4, "0")}`,
      type: "status_update",
      timestamp: timestamp++,
      status_update: { agent_status: "stopped" },
    });
    return {
      status: 200,
      data: {
        ok: true,
        request_id: `request-${operationToken}`,
        task_id: CANONICAL_TASK_ID,
        ...(method === "task.create"
          ? {
              task_title: "FrontMind KB long chain",
              task_url: `https://manus.im/app/${CANONICAL_TASK_ID}`,
            }
          : {}),
      },
    };
  });

  const get = vi.fn(async (url: string, config: Record<string, any>) => {
    if (!url.endsWith("/v2/task.listMessages")) {
      throw new Error(`unexpected fake Manus GET: ${url}`);
    }
    if (config.params?.task_id !== CANONICAL_TASK_ID) {
      throw new Error("message read escaped the canonical task");
    }
    const cursorValue = config.params?.cursor
      ? String(config.params.cursor)
      : null;
    pageRequests.push(cursorValue);
    const offset = cursorValue
      ? Number(cursorValue.slice("cursor-".length))
      : 0;
    const pageSize = 19;
    const uniquePage = events.slice(offset, offset + pageSize);
    const overlapping =
      offset > 0 ? [events[offset - 1]!, ...uniquePage] : uniquePage;
    const hasMore = offset + pageSize < events.length;
    return {
      status: 200,
      data: {
        ok: true,
        task_id: CANONICAL_TASK_ID,
        // Provider history is allowed to be unordered and to repeat ids.
        messages: [...overlapping].reverse(),
        has_more: hasMore,
        ...(hasMore ? { next_cursor: `cursor-${offset + pageSize}` } : {}),
      },
    };
  });

  return {
    api: { post, get } as unknown as AxiosInstance,
    calls,
    events,
    pageRequests,
    register(result: ManusV2KnowledgeBaseStructuredResult) {
      queuedResults.set(result.operationToken, result);
    },
  };
}

function nodeRows() {
  return Array.from({ length: NODE_COUNT }, (_, ordinal) => {
    const id = leafId(ordinal + 1);
    return {
      id: `node-${ordinal + 1}`,
      buildId: BUILD_ID,
      leafId: id,
      branchId: `branch-${Math.floor(ordinal / 10) + 1}`,
      branchTitle: `知识分支 ${Math.floor(ordinal / 10) + 1}`,
      title: `知识节点 ${ordinal + 1}`,
      ordinal,
      status: "pending",
      contentMarkdown: null,
      contentSha256: null,
      sourceUrls: [],
      imageUrls: [],
    } as unknown as KnowledgeBaseBuildNode;
  });
}

describe("Manus v2 115-node canonical long chain", () => {
  it("creates once, sends every continuation to one task, then packages accepted content locally", async () => {
    const build: MutableBuild = {
      id: BUILD_ID,
      userId: 1,
      companyName: "FrontMind 115 节点验收",
      providerProtocol: "manus_v2",
      canonicalTaskId: null,
      canonicalTaskGeneration: null,
      canonicalCredentialId: null,
      canonicalTaskState: "unbound",
      canonicalTaskUrl: null,
      canonicalTaskCreatedAt: null,
      upstreamTaskId: null,
      generation: 1,
      stateEpoch: 0,
      activeTurnId: null,
      revision: 0,
      currentLeafId: null,
      status: "researching",
      contentCompletedAt: null,
      packageStatus: "not_started",
      logoStorageKey: null,
    };
    const fence = createWriterFenceHarness(build);
    const provider = createFakeManusProvider();
    const client = new ManusV2Client({
      baseUrl: MANUS_BASE_URL,
      apiKey: "fake-manus-key",
      axiosInstance: provider.api,
    });
    const nodes = nodeRows();
    let operationIndex = 0;

    async function runOperation(input: {
      action: "start" | "confirm" | "revise";
      fromLeafId: string | null;
      nextLeafId: string | null;
      visibleMarkdown: string;
      contentCompleted: boolean;
      manifestJson?: string | null;
      attachments?: Array<{ file_id: string; filename: string }>;
      raceSameOperation?: boolean;
    }) {
      operationIndex += 1;
      const operationToken = `operation-${String(operationIndex).padStart(3, "0")}`;
      const operationTurnId = turnId(operationIndex);
      const contract: ManusV2KnowledgeBaseOperationContract = {
        operationToken,
        turnId: operationTurnId,
        generation: 1,
        baseRevision: fence.state.build.revision,
        action: input.action,
        fromLeafId: input.fromLeafId,
        expectContentCompleted: input.contentCompleted,
        requiresManifest: input.action === "start",
      };
      const result: ManusV2KnowledgeBaseStructuredResult = {
        schemaVersion: 1,
        operationToken,
        turnId: operationTurnId,
        generation: 1,
        baseRevision: contract.baseRevision,
        action: input.action,
        fromLeafId: input.fromLeafId,
        nextLeafId: input.nextLeafId,
        visibleMarkdown: input.visibleMarkdown,
        contentCompleted: input.contentCompleted,
        manifestJson: input.manifestJson ?? null,
      };
      provider.register(result);

      const leaseToken = `lease-${operationIndex}`;
      fence.installTurn(
        operationTurn({
          index: operationIndex,
          operationToken,
          operationType: input.action,
          expectedRevision: contract.baseRevision,
          expectedLeafId: input.fromLeafId,
          leaseToken,
        }),
      );
      const schema = buildManusV2KnowledgeBaseStructuredOutputSchema(contract);
      const prompt = appendManusV2KnowledgeBaseOperationContract(
        `${input.action} ${input.fromLeafId || "new build"}`,
        contract,
      );
      const frozenProviderRequestHash = sha256(
        JSON.stringify({
          prompt,
          schema,
          attachments: input.attachments ?? [],
        }),
      );

      const attempts = input.raceSameOperation
        ? await Promise.allSettled([
            beginKnowledgeBaseManusV2Dispatch(
              {
                userId: 1,
                turnId: operationTurnId,
                leaseToken,
                frozenProviderRequestHash,
              },
              fence.executor,
            ),
            beginKnowledgeBaseManusV2Dispatch(
              {
                userId: 1,
                turnId: operationTurnId,
                leaseToken,
                frozenProviderRequestHash,
              },
              fence.executor,
            ),
          ])
        : [
            await beginKnowledgeBaseManusV2Dispatch(
              {
                userId: 1,
                turnId: operationTurnId,
                leaseToken,
                frozenProviderRequestHash,
              },
              fence.executor,
            ).then(
              (value) => ({ status: "fulfilled", value }) as const,
              (reason) => ({ status: "rejected", reason }) as const,
            ),
          ];
      const winners = attempts.filter(
        (
          attempt,
        ): attempt is PromiseFulfilledResult<
          Awaited<ReturnType<typeof beginKnowledgeBaseManusV2Dispatch>>
        > => attempt.status === "fulfilled",
      );
      expect(winners).toHaveLength(1);
      if (input.raceSameOperation) {
        const rejected = attempts.find(
          (attempt): attempt is PromiseRejectedResult =>
            attempt.status === "rejected",
        );
        expect(rejected?.reason).toBeInstanceOf(
          KnowledgeBaseTurnReservationError,
        );
        expect(rejected?.reason).toMatchObject({ code: "IDEMPOTENCY_PENDING" });
      }
      const authority = winners[0]!.value;

      let acknowledgement: {
        taskId: string;
        taskUrl?: string | null;
        requestId: string | null;
      };
      if (authority.method === "task.create") {
        const created = await client.createTask({
          title: authority.title,
          prompt,
          attachments: input.attachments,
          structuredOutputSchema: schema,
        });
        acknowledgement = created;
      } else {
        expect(authority.canonicalTaskId).toBe(CANONICAL_TASK_ID);
        const sent = await client.sendMessage({
          taskId: authority.canonicalTaskId!,
          prompt,
          attachments: input.attachments,
          structuredOutputSchema: schema,
        });
        acknowledgement = sent;
      }
      expect(acknowledgement.taskId).toBe(CANONICAL_TASK_ID);
      await bindKnowledgeBaseManusV2Submission(
        {
          userId: 1,
          turnId: operationTurnId,
          leaseToken,
          method: authority.method,
          taskId: acknowledgement.taskId,
          taskUrl: acknowledgement.taskUrl,
          manusRequestId: acknowledgement.requestId,
        },
        fence.executor,
      );

      const history = await client.listAllMessages({
        taskId: CANONICAL_TASK_ID,
        order: "asc",
      });
      const exact = manusV2KnowledgeBaseStructuredResultForOperation(
        history,
        contract,
      );
      expect(exact?.value).toEqual(result);
      const core = normalizeManusV2Output(history, contract);
      expect(core).toHaveLength(1);
      expect(core[0]?.text).toBe(input.visibleMarkdown);
      return { contract, result };
    }

    const manifestJson = JSON.stringify({
      leaves: nodes.map((node) => ({
        id: node.leafId,
        title: node.title,
        branchId: node.branchId,
        branchTitle: node.branchTitle,
      })),
    });
    await runOperation({
      action: "start",
      fromLeafId: null,
      nextLeafId: leafId(1),
      visibleMarkdown: `## ${leafId(1)}\n\n首个节点正文。`,
      contentCompleted: false,
      manifestJson,
    });
    expect(JSON.parse(manifestJson).leaves).toHaveLength(NODE_COUNT);
    nodes[0] = {
      ...nodes[0]!,
      status: "current",
      contentMarkdown: `## ${leafId(1)}\n\n首个节点正文。`,
      contentSha256: knowledgeBaseMarkdownSha256(
        `## ${leafId(1)}\n\n首个节点正文。`,
      ),
    };
    fence.state.build.currentLeafId = leafId(1);

    // Revision stays on the same leaf and still uses task.sendMessage.
    const revisedBody = `## ${leafId(1)}\n\n经客户修订后的首个节点正文。`;
    await runOperation({
      action: "revise",
      fromLeafId: leafId(1),
      nextLeafId: leafId(1),
      visibleMarkdown: revisedBody,
      contentCompleted: false,
    });
    fence.state.build.revision += 1;
    nodes[0] = {
      ...nodes[0]!,
      contentMarkdown: revisedBody,
      contentSha256: knowledgeBaseMarkdownSha256(revisedBody),
    };

    for (let current = 1; current <= NODE_COUNT; current += 1) {
      const next = current === NODE_COUNT ? null : leafId(current + 1);
      const nextBody = next
        ? `## ${next}\n\n第 ${current + 1} 个节点正文。`
        : "";
      await runOperation({
        action: "confirm",
        fromLeafId: leafId(current),
        nextLeafId: next,
        visibleMarkdown: nextBody,
        contentCompleted: next === null,
        // A continuation with a newly ready attachment remains a send on the
        // same canonical task; it never creates a second task.
        ...(current === 58
          ? {
              attachments: [
                { file_id: "ready-supplement-58", filename: "supplement.pdf" },
              ],
            }
          : {}),
        // Two browsers confirming the same logical operation race here.
        raceSameOperation: current === 2,
      });

      nodes[current - 1] = {
        ...nodes[current - 1]!,
        status: "confirmed",
      };
      fence.state.build.revision += 1;
      fence.state.build.currentLeafId = next;
      if (next) {
        nodes[current] = {
          ...nodes[current]!,
          status: "current",
          contentMarkdown: nextBody,
          contentSha256: knowledgeBaseMarkdownSha256(nextBody),
        };
      }
    }

    // Final semantic acceptance is committed before package generation.
    fence.state.build.status = "ready_to_publish";
    fence.state.build.contentCompletedAt = new Date("2026-08-12T00:05:00.000Z");
    fence.state.build.packageStatus = "preparing";
    expect(fence.state.build.currentLeafId).toBeNull();
    expect(nodes).toHaveLength(NODE_COUNT);
    expect(nodes.every((node) => node.status === "confirmed")).toBe(true);
    expect(fence.state.build.contentCompletedAt).not.toBeNull();
    expect(fence.state.build.packageStatus).toBe("preparing");

    const createCalls = provider.calls.filter(
      (call) => call.method === "task.create",
    );
    const sendCalls = provider.calls.filter(
      (call) => call.method === "task.sendMessage",
    );
    expect(createCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(NODE_COUNT + 1); // one revision + 115 confirms
    expect(provider.calls).toHaveLength(NODE_COUNT + 2);
    expect(
      provider.calls.every((call) =>
        Boolean(call.body.structured_output_schema),
      ),
    ).toBe(true);
    expect(
      sendCalls.every((call) => call.body.task_id === CANONICAL_TASK_ID),
    ).toBe(true);
    expect(fence.state.build.canonicalTaskId).toBe(CANONICAL_TASK_ID);
    expect(fence.state.build.canonicalTaskGeneration).toBe(1);
    expect(
      sendCalls.filter((call) =>
        call.body.message.content.some(
          (part: Record<string, unknown>) => part.type === "file",
        ),
      ),
    ).toHaveLength(1);

    const finalHistory = await client.listAllMessages({
      taskId: CANONICAL_TASK_ID,
      order: "asc",
    });
    expect(finalHistory).toHaveLength(provider.events.length);
    expect(new Set(finalHistory.map((event) => event.id)).size).toBe(
      provider.events.length,
    );
    expect(finalHistory.map((event) => event.timestamp)).toEqual(
      [...finalHistory].map((event) => event.timestamp).sort((a, b) => a - b),
    );
    expect(provider.pageRequests.some((cursor) => cursor !== null)).toBe(true);

    const completedAtBeforePackage = fence.state.build.contentCompletedAt;
    const packaged = await buildDashboardOwnedKnowledgePackage({
      build: fence.state.build as KnowledgeBaseBuild,
      nodes,
    });
    const verified = await readDashboardOwnedKnowledgePackage({
      buffer: packaged.buffer,
      expected: {
        buildId: BUILD_ID,
        generation: 1,
        revision: fence.state.build.revision,
        companyName: fence.state.build.companyName,
      },
      nodes,
    });
    expect(verified.documents).toHaveLength(NODE_COUNT);
    expect(verified.manifest.missing_optional_assets).toContain(
      "official_logo",
    );
    expect(fence.state.build.contentCompletedAt).toBe(completedAtBeforePackage);
    fence.state.build.packageStatus = "ready";
    expect(fence.state.build.packageStatus).toBe("ready");
  }, 60_000);
});
