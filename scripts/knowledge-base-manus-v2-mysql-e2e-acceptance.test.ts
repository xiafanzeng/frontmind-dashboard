import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import axios, {
  AxiosHeaders,
  type AxiosAdapter,
  type InternalAxiosRequestConfig,
} from "axios";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import express from "express";
import mysql, {
  type Pool,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  apiCredentials,
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  knowledgeBaseSnapshots,
  messages,
  upstreamResources,
  userDashboardContents,
} from "../drizzle/schema";
import { createDefaultDashboardPayload } from "../shared/dashboard";
import { KNOWLEDGE_BASE_COMPLETION_MESSAGE_CONTENT } from "../shared/knowledge-base-message";
import { knowledgeBaseMarkdownSha256 } from "../server/knowledge-base-package-validation";
import { KNOWLEDGE_BASE_TREE_POLICY_V1_SKILL_CONTENT_HASH } from "../server/knowledge-base-tree-policy-rollout";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  assertServiceCapability: vi.fn(),
  assertKnowledgeBaseWritable: vi.fn(),
  createKnowledgeMonitoringHandoff: vi.fn(),
  getCredentialForUpstreamResource: vi.fn(),
  getDecryptedCredentialForKnowledgeBaseUploadReservation: vi.fn(),
  recordUpstreamResource: vi.fn(),
  upstreamBaseUrl: "",
  userId: 0,
  credentialId: "",
  credentialFingerprint: "",
  apiKey: "",
}));

vi.mock("../server/db", () => ({ getDb: dependencies.getDb }));

vi.mock("../server/_core/express-auth", () => ({
  requireExpressAuth: (req: any, res: any, next: () => void) => {
    if (req.header("x-test-auth") !== "user") {
      res
        .status(401)
        .json({ error: { message: "请先登录", code: "UNAUTHORIZED" } });
      return;
    }
    req.frontmindUser = {
      id: dependencies.userId,
      username: "frontmind-manus-v2-mysql-e2e",
      displayName: SYNTHETIC_COMPANY,
      role: "user",
      adminAccessLevel: null,
      engineerRoleType: null,
      marketEdition: "domestic",
      isActive: true,
    };
    req.frontmindCredential = {
      id: dependencies.credentialId,
      userId: dependencies.userId,
      version: 1,
      label: "Synthetic Manus v2 MySQL E2E credential",
      apiKey: dependencies.apiKey,
      fingerprint: dependencies.credentialFingerprint,
    };
    next();
  },
}));

vi.mock("../server/service-entitlement", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/service-entitlement")>();
  return {
    ...actual,
    assertServiceCapability: dependencies.assertServiceCapability,
  };
});

vi.mock("../server/knowledge-base-reset-service", () => ({
  assertKnowledgeBaseWritable: dependencies.assertKnowledgeBaseWritable,
}));

vi.mock("../server/delivery-role-service", () => ({
  assertDeliveryProjectContext: vi.fn(),
  createKnowledgeMonitoringHandoff:
    dependencies.createKnowledgeMonitoringHandoff,
}));

vi.mock("../server/auth-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/auth-service")>();
  return {
    ...actual,
    getCredentialForUpstreamResource:
      dependencies.getCredentialForUpstreamResource,
    getDecryptedCredentialForKnowledgeBaseUploadReservation:
      dependencies.getDecryptedCredentialForKnowledgeBaseUploadReservation,
    recordUpstreamResource: dependencies.recordUpstreamResource,
  };
});

vi.mock("../server/upstream-config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/upstream-config")>();
  return {
    ...actual,
    getUpstreamBaseUrl: () => dependencies.upstreamBaseUrl,
    getFrontMindCredentials: (req: any) => ({
      apiKey: req.frontmindCredential?.apiKey || "",
      baseUrl: dependencies.upstreamBaseUrl,
    }),
  };
});

const ACCEPTANCE_ENV = "FRONTMIND_KB_MANUS_V2_MYSQL_ACCEPTANCE_DATABASE_URL";
const REQUIRED_ENV = "FRONTMIND_KB_MANUS_V2_MYSQL_ACCEPTANCE_REQUIRED";
const DATABASE_MARKER = "frontmind_kb_acceptance";
const REPOSITORY_ROOT = path.resolve(process.cwd());
const SYNTHETIC_COMPANY = "合成示例企业";
const SYNTHETIC_WEBSITE = "https://synthetic.invalid/";
const FINAL_REVISION = 8;
const PROVIDER_BASE_URL = "https://fake.manus-v2.frontmind.test";
const PROVIDER_UPLOAD_ORIGIN = "https://upload.manus-v2.frontmind.test";

type AcceptanceTarget = { url: string; databaseName: string };

export function parseKnowledgeBaseManusV2MysqlE2eAcceptanceTarget(
  rawValue: string | undefined,
): AcceptanceTarget {
  const value = rawValue?.trim();
  if (!value) throw new Error(`${ACCEPTANCE_ENV}_MISSING`);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${ACCEPTANCE_ENV}_INVALID`);
  }
  if (parsed.protocol !== "mysql:") {
    throw new Error(`${ACCEPTANCE_ENV}_MUST_USE_MYSQL`);
  }
  if (
    [...parsed.searchParams.keys()].some((key) =>
      ["database", "schema", "db"].includes(key.toLowerCase()),
    )
  ) {
    throw new Error(`${ACCEPTANCE_ENV}_DATABASE_OVERRIDE_FORBIDDEN`);
  }

  const encodedDatabaseName = parsed.pathname.replace(/^\/+/, "");
  let databaseName = "";
  try {
    databaseName = decodeURIComponent(encodedDatabaseName);
  } catch {
    throw new Error(`${ACCEPTANCE_ENV}_DATABASE_INVALID`);
  }
  if (
    !databaseName ||
    databaseName.includes("/") ||
    !/^[A-Za-z0-9_$-]+$/u.test(databaseName) ||
    !databaseName.toLowerCase().includes(DATABASE_MARKER)
  ) {
    throw new Error(`${ACCEPTANCE_ENV}_DATABASE_NOT_DISPOSABLE`);
  }
  return { url: value, databaseName };
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function providerOperationContract(prompt: string) {
  const line = prompt
    .split(/\r?\n/u)
    .find((candidate) =>
      candidate.startsWith("FRONTMIND_MANUS_V2_OPERATION_CONTRACT="),
    );
  if (!line) throw new Error("FAKE_MANUS_V2_OPERATION_CONTRACT_MISSING");
  const value = JSON.parse(line.slice(line.indexOf("=") + 1)) as Record<
    string,
    unknown
  >;
  if (
    typeof value.operationToken !== "string" ||
    typeof value.turnId !== "string" ||
    !Number.isSafeInteger(value.generation) ||
    !Number.isSafeInteger(value.baseRevision) ||
    typeof value.action !== "string" ||
    typeof value.contentCompleted !== "boolean" ||
    typeof value.requiresManifest !== "boolean"
  ) {
    throw new Error("FAKE_MANUS_V2_OPERATION_CONTRACT_INVALID");
  }
  return value as {
    schemaVersion: number;
    operationToken: string;
    turnId: string;
    generation: number;
    baseRevision: number;
    action: string;
    fromLeafId: string | null;
    contentCompleted: boolean;
    requiresManifest: boolean;
  };
}

function messagePrompt(body: any) {
  const parts = Array.isArray(body?.message?.content)
    ? body.message.content
    : [];
  const text = parts.find((part: any) => part?.type === "text")?.text;
  if (typeof text !== "string" || !text) {
    throw new Error("FAKE_MANUS_V2_TEXT_PART_MISSING");
  }
  return text;
}

function requestBody(config: InternalAxiosRequestConfig) {
  if (typeof config.data !== "string") return config.data;
  try {
    return JSON.parse(config.data);
  } catch {
    return config.data;
  }
}

function uploadBytes(value: unknown) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value);
  throw new Error("FAKE_MANUS_V2_UPLOAD_BYTES_INVALID");
}

function axiosResponse(
  config: InternalAxiosRequestConfig,
  status: number,
  data: unknown,
) {
  return {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "ERROR",
    headers: new AxiosHeaders(),
    config,
    data,
  };
}

function syntheticLeaf(index: number) {
  const leafId = `1.${index + 1}`;
  const title = `合成知识节点 ${index + 1}`;
  // Deliberately omit the workspace's exact enterprise name. Dashboard-owned
  // package identity is bound by the frozen build + embedded manifest, not by
  // forcing every accepted business node to repeat a legal company name.
  const visibleMarkdown = `# ${leafId} ${title}\n\n## 核心事实\n\n本验收节点只包含“合成产品代号 A”的完全合成资料，用于证明 Dashboard 接受正文、保持单调展示并生成本地知识库下载包。节点编号为 ${leafId}，不引用任何客户文档、生产任务或真实 API 凭证。`;
  return { leafId, title, visibleMarkdown };
}

const syntheticLeaves = Array.from({ length: FINAL_REVISION }, (_, index) =>
  syntheticLeaf(index),
);

function expectedStructuredValue(
  contract: ReturnType<typeof providerOperationContract>,
) {
  if (contract.requiresManifest) {
    return {
      schemaVersion: 1,
      operationToken: contract.operationToken,
      turnId: contract.turnId,
      generation: contract.generation,
      baseRevision: contract.baseRevision,
      action: contract.action,
      fromLeafId: contract.fromLeafId,
      nextLeafId: syntheticLeaves[0]!.leafId,
      visibleMarkdown: syntheticLeaves[0]!.visibleMarkdown,
      contentCompleted: false,
      manifestJson: JSON.stringify({
        leaves: syntheticLeaves.map((leaf) => ({
          id: leaf.leafId,
          title: leaf.title,
          branchId: "synthetic_products",
          branchTitle: "合成产品",
        })),
      }),
    };
  }

  const nextIndex = contract.baseRevision + 1;
  const next = syntheticLeaves[nextIndex];
  const completed = nextIndex === FINAL_REVISION;
  return {
    schemaVersion: 1,
    operationToken: contract.operationToken,
    turnId: contract.turnId,
    generation: contract.generation,
    baseRevision: contract.baseRevision,
    action: contract.action,
    fromLeafId: contract.fromLeafId,
    nextLeafId: next?.leafId ?? null,
    visibleMarkdown: next?.visibleMarkdown ?? "",
    contentCompleted: completed,
  };
}

function assertStructuredSchema(
  schema: any,
  contract: ReturnType<typeof providerOperationContract>,
) {
  expect(schema).toMatchObject({
    type: "object",
    additionalProperties: false,
    properties: {
      schemaVersion: { enum: [1] },
      operationToken: { enum: [contract.operationToken] },
      turnId: { enum: [contract.turnId] },
      generation: { enum: [contract.generation] },
      baseRevision: { enum: [contract.baseRevision] },
      action: { enum: [contract.action] },
      fromLeafId: { enum: [contract.fromLeafId] },
      contentCompleted: { enum: [contract.contentCompleted] },
    },
  });
  expect(schema.required).toEqual(
    expect.arrayContaining([
      "schemaVersion",
      "operationToken",
      "turnId",
      "generation",
      "baseRevision",
      "action",
      "fromLeafId",
      "nextLeafId",
      "visibleMarkdown",
      "contentCompleted",
      ...(contract.requiresManifest ? ["manifestJson"] : []),
    ]),
  );
  if (contract.requiresManifest) {
    expect(schema.properties.manifestJson).toEqual({ type: "string" });
  } else {
    expect(schema.properties.manifestJson).toBeUndefined();
  }
}

type FakeProviderState = {
  adapter: AxiosAdapter;
  fileUploads: Array<{ id: string; filename: string }>;
  fileDetailCalls: string[];
  uploadedFiles: Map<
    string,
    { filename: string; bytes: Buffer | null; contentType: string | null }
  >;
  taskCreateBodies: any[];
  taskSendBodies: any[];
  taskUpdateBodies: any[];
  taskListCalls: number;
  canonicalTaskId: string;
  taskEvents: Map<string, Array<Record<string, unknown>>>;
};

function createFakeManusV2Provider(input: {
  apiKey: string;
  canonicalTaskId: string;
}): FakeProviderState {
  let fileSequence = 0;
  let eventSequence = 0;
  const uploadedFiles: FakeProviderState["uploadedFiles"] = new Map();
  const taskEvents: FakeProviderState["taskEvents"] = new Map();
  const state: FakeProviderState = {
    adapter: undefined as unknown as AxiosAdapter,
    fileUploads: [],
    fileDetailCalls: [],
    uploadedFiles,
    taskCreateBodies: [],
    taskSendBodies: [],
    taskUpdateBodies: [],
    taskListCalls: 0,
    canonicalTaskId: input.canonicalTaskId,
    taskEvents,
  };

  const assertProviderCredential = (config: InternalAxiosRequestConfig) => {
    const headers = AxiosHeaders.from(config.headers);
    expect(headers.get("x-manus-api-key")).toBe(input.apiKey);
    expect(headers.has("authorization")).toBe(false);
  };

  const appendOperationEvents = (taskId: string, body: any) => {
    const prompt = messagePrompt(body);
    const contract = providerOperationContract(prompt);
    const schema = body.structured_output_schema;
    assertStructuredSchema(schema, contract);
    const value = expectedStructuredValue(contract);
    expect(value.contentCompleted).toBe(contract.contentCompleted);
    expect(value.fromLeafId).toBe(contract.fromLeafId);
    const attachments = (body.message.content as any[]).filter(
      (part) => part?.type === "file",
    );
    for (const attachment of attachments) {
      const file = uploadedFiles.get(String(attachment.file_id));
      expect(file?.bytes?.length).toBeGreaterThan(0);
      expect(attachment.filename).toBe(file?.filename);
    }
    const events = taskEvents.get(taskId) || [];
    const at = Date.now() + eventSequence * 10;
    events.push(
      {
        id: `event-user-${++eventSequence}`,
        type: "user_message",
        timestamp: at,
        user_message: { content: prompt },
      },
      {
        id: `event-result-${++eventSequence}`,
        type: "structured_output_result",
        timestamp: at + 1,
        structured_output_result: { success: true, value },
      },
      {
        id: `event-status-${++eventSequence}`,
        type: "status_update",
        timestamp: at + 2,
        status_update: { agent_status: "stopped" },
      },
    );
    taskEvents.set(taskId, events);
  };

  state.adapter = async (config) => {
    const method = String(config.method || "get").toLowerCase();
    const url = new URL(String(config.url || ""), PROVIDER_BASE_URL);

    if (url.origin === PROVIDER_UPLOAD_ORIGIN && method === "put") {
      const fileId = decodeURIComponent(url.pathname.split("/").at(-1) || "");
      const file = uploadedFiles.get(fileId);
      if (!file) throw new Error("FAKE_MANUS_V2_UPLOAD_FILE_NOT_FOUND");
      const bytes = uploadBytes(config.data);
      file.bytes = bytes;
      file.contentType = String(
        AxiosHeaders.from(config.headers).get("content-type") ||
          "application/octet-stream",
      );
      expect(
        String(AxiosHeaders.from(config.headers).get("content-length")),
      ).toBe(String(bytes.length));
      return axiosResponse(config, 200, { ok: true });
    }

    if (url.origin !== PROVIDER_BASE_URL) {
      throw new Error(`FAKE_MANUS_V2_UNEXPECTED_ORIGIN:${url.origin}`);
    }
    assertProviderCredential(config);

    if (method === "post" && url.pathname === "/v2/file.upload") {
      const body = requestBody(config) as { filename?: unknown };
      const filename = String(body?.filename || "");
      expect(filename).toBeTruthy();
      const fileId = `fake-v2-file-${++fileSequence}`;
      uploadedFiles.set(fileId, { filename, bytes: null, contentType: null });
      state.fileUploads.push({ id: fileId, filename });
      return axiosResponse(config, 200, {
        ok: true,
        file: { id: fileId, filename },
        upload_url: `${PROVIDER_UPLOAD_ORIGIN}/content/${encodeURIComponent(fileId)}`,
        upload_expires_at: Math.floor(Date.now() / 1_000) + 180,
        request_id: `request-file-${fileSequence}`,
      });
    }

    if (method === "get" && url.pathname === "/v2/file.detail") {
      const fileId = String((config.params as any)?.file_id || "");
      const file = uploadedFiles.get(fileId);
      if (!file) {
        return axiosResponse(config, 404, {
          ok: false,
          error: { code: "FILE_NOT_FOUND" },
        });
      }
      state.fileDetailCalls.push(fileId);
      return axiosResponse(config, 200, {
        ok: true,
        file: {
          id: fileId,
          filename: file.filename,
          status: file.bytes ? "uploaded" : "pending",
          bytes: file.bytes?.length ?? null,
          expires_at: Math.floor(Date.now() / 1_000) + 48 * 60 * 60,
          content_type: file.contentType,
        },
        request_id: `request-detail-${state.fileDetailCalls.length}`,
      });
    }

    if (method === "post" && url.pathname === "/v2/task.create") {
      const body = requestBody(config) as any;
      state.taskCreateBodies.push(body);
      expect(state.taskCreateBodies).toHaveLength(1);
      expect(body).toMatchObject({
        interactive_mode: false,
        hide_in_task_list: true,
        share_visibility: "private",
      });
      expect(body.title).toEqual(expect.any(String));
      appendOperationEvents(input.canonicalTaskId, body);
      return axiosResponse(config, 200, {
        ok: true,
        task_id: input.canonicalTaskId,
        task_url: `https://manus.im/app/${input.canonicalTaskId}`,
        task_title: body.title,
        request_id: "request-task-create-1",
      });
    }

    if (method === "post" && url.pathname === "/v2/task.sendMessage") {
      const body = requestBody(config) as any;
      state.taskSendBodies.push(body);
      expect(body.task_id).toBe(input.canonicalTaskId);
      appendOperationEvents(input.canonicalTaskId, body);
      return axiosResponse(config, 200, {
        ok: true,
        task_id: input.canonicalTaskId,
        request_id: `request-task-send-${state.taskSendBodies.length}`,
      });
    }

    if (method === "get" && url.pathname === "/v2/task.listMessages") {
      state.taskListCalls += 1;
      const taskId = String((config.params as any)?.task_id || "");
      expect(taskId).toBe(input.canonicalTaskId);
      return axiosResponse(config, 200, {
        ok: true,
        task_id: taskId,
        messages: taskEvents.get(taskId) || [],
        has_more: false,
        next_cursor: null,
        request_id: `request-task-list-${state.taskListCalls}`,
      });
    }

    if (method === "post" && url.pathname === "/v2/task.update") {
      const body = requestBody(config) as any;
      state.taskUpdateBodies.push(body);
      expect(body).toEqual({
        task_id: input.canonicalTaskId,
        enable_visible_in_task_list: true,
      });
      return axiosResponse(config, 200, {
        ok: true,
        task_id: input.canonicalTaskId,
        request_id: `request-task-update-${state.taskUpdateBodies.length}`,
      });
    }

    throw new Error(
      `FAKE_MANUS_V2_UNEXPECTED_REQUEST:${method}:${url.pathname}`,
    );
  };
  return state;
}

async function listen(app: express.Express) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server | undefined) {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function waitFor<T>(input: {
  label: string;
  read: () => Promise<T>;
  accept: (value: T) => boolean;
  timeoutMs?: number;
}) {
  const deadline = Date.now() + (input.timeoutMs ?? 45_000);
  let last: T | undefined;
  do {
    last = await input.read();
    if (input.accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(
    `${input.label} did not settle: ${JSON.stringify(last, null, 2)}`,
  );
}

describe("knowledge-base Manus v2 MySQL E2E acceptance URL guard", () => {
  it("accepts only an explicitly named disposable MySQL acceptance database", () => {
    expect(
      parseKnowledgeBaseManusV2MysqlE2eAcceptanceTarget(
        "mysql://tester:secret@127.0.0.1:3306/frontmind_kb_acceptance_manus_v2_ci_01",
      ).databaseName,
    ).toBe("frontmind_kb_acceptance_manus_v2_ci_01");

    for (const unsafe of [
      undefined,
      "postgres://tester:secret@127.0.0.1/frontmind_kb_acceptance_manus_v2",
      "mysql://tester:secret@127.0.0.1/frontmind_manus_v2_production",
      "mysql://tester:secret@127.0.0.1/frontmind_kb_acceptance/other",
      "mysql://tester:secret@127.0.0.1/frontmind_kb_acceptance?database=production",
    ]) {
      expect(() =>
        parseKnowledgeBaseManusV2MysqlE2eAcceptanceTarget(unsafe),
      ).toThrow();
    }
  });
});

const acceptanceUrl = process.env[ACCEPTANCE_ENV]?.trim();
if (process.env[REQUIRED_ENV] === "1" && !acceptanceUrl) {
  throw new Error(`${ACCEPTANCE_ENV}_REQUIRED_FOR_RELEASE_GATE`);
}
const mysqlDescribe = acceptanceUrl ? describe.sequential : describe.skip;

mysqlDescribe(
  "knowledge-base Manus v2 controllers on disposable real MySQL",
  () => {
    let pool: Pool;
    let executor: ReturnType<typeof drizzle>;
    let assetRoot = "";
    let dashboardServer: Server | undefined;
    let dashboardBaseUrl = "";
    let userId: number | null = null;
    let fakeProvider: FakeProviderState;
    let acceptancePassed = false;
    const runId = randomUUID().replaceAll("-", "");
    const publicConversationId = `kb-v2-mysql-e2e-${runId}`;
    const credentialId = randomUUID();
    const upstreamApiKey = "sk-synthetic-manus-v2-mysql-e2e-only";
    const credentialFingerprint = `fp_${sha256(upstreamApiKey).slice(0, 16)}`;
    const canonicalTaskId = `task-v2-canonical-${runId}`;
    const previousAssetRoot = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
    const previousRolloutPercent = process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT;
    const previousTreePolicyWriter =
      process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER;
    const previousManusV2Writer = process.env.FRONTMIND_KB_MANUS_V2_WRITER;
    const previousUpstreamBaseUrl = process.env.FRONTMIND_UPSTREAM_BASE_URL;
    const previousCredentialEncryptionKey =
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    const previousAxiosAdapter = axios.defaults.adapter;

    const getProgress = async () => {
      const response = await fetch(
        `${dashboardBaseUrl}/api/knowledge-base/progress/${encodeURIComponent(publicConversationId)}`,
        { headers: { "x-test-auth": "user" } },
      );
      const payload = (await response.json()) as any;
      if (response.status !== 200) {
        throw new Error(
          `/progress returned ${response.status}: ${JSON.stringify(payload)}`,
        );
      }
      if (payload.observation?.interaction?.interactionState === "failed") {
        throw new Error(
          `knowledge-base projection failed: ${JSON.stringify(payload.observation.notice)}`,
        );
      }
      return payload;
    };

    const postKnowledgeBase = async (
      pathname: "/start/reserve" | "/turn/dispatch" | "/turn",
      body: Record<string, unknown>,
    ) => {
      const response = await fetch(
        `${dashboardBaseUrl}/api/knowledge-base${pathname}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify(body),
        },
      );
      const payload = (await response.json()) as any;
      if (![200, 201, 202].includes(response.status)) {
        throw new Error(
          `${pathname} returned ${response.status}: ${JSON.stringify(payload)}`,
        );
      }
      return payload;
    };

    beforeAll(async () => {
      const target =
        parseKnowledgeBaseManusV2MysqlE2eAcceptanceTarget(acceptanceUrl);
      pool = mysql.createPool({
        uri: target.url,
        connectionLimit: 16,
        multipleStatements: false,
      });
      const [databaseRows] = await pool.query<RowDataPacket[]>(
        "SELECT DATABASE() AS databaseName",
      );
      expect(String(databaseRows[0]?.databaseName || "")).toBe(
        target.databaseName,
      );
      const [preMigrationRows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS tableCount
           FROM information_schema.tables
          WHERE table_schema = DATABASE()`,
      );
      if (Number(preMigrationRows[0]?.tableCount || 0) !== 0) {
        throw new Error(`${ACCEPTANCE_ENV}_DATABASE_MUST_BE_EMPTY`);
      }

      executor = drizzle(pool);
      await migrate(executor, {
        migrationsFolder: path.join(REPOSITORY_ROOT, "drizzle"),
      });
      const journal = JSON.parse(
        await readFile(
          path.join(REPOSITORY_ROOT, "drizzle/meta/_journal.json"),
          "utf8",
        ),
      ) as { entries: Array<{ tag?: string }> };
      const [ledgerRows] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS migrationCount FROM __drizzle_migrations",
      );
      expect(Number(ledgerRows[0]?.migrationCount || 0)).toBe(
        journal.entries.length,
      );
      expect(
        journal.entries.some(
          (entry) => entry.tag === "0061_knowledge_base_resilient_manus_v2",
        ),
      ).toBe(true);
      const [engineRows] = await pool.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS tableName, ENGINE AS engine
           FROM information_schema.tables
          WHERE table_schema = DATABASE()
            AND table_name IN (
              'knowledge_base_builds', 'knowledge_base_build_nodes',
              'conversation_turns', 'conversations', 'messages',
              'upstream_resources'
            )`,
      );
      expect(engineRows).toHaveLength(6);
      expect(engineRows.every((row) => row.engine === "InnoDB")).toBe(true);

      const [userResult] = await pool.execute<ResultSetHeader>(
        `INSERT INTO users
           (openId, username, displayName, role, marketEdition, isActive)
         VALUES (?, ?, ?, 'user', 'domestic', 1)`,
        [
          `kb-v2-e2e-${runId}`.slice(0, 64),
          `kb_v2_e2e_${runId}`.slice(0, 64),
          SYNTHETIC_COMPANY,
        ],
      );
      userId = userResult.insertId;
      dependencies.userId = userId;
      dependencies.credentialId = credentialId;
      dependencies.credentialFingerprint = credentialFingerprint;
      dependencies.apiKey = upstreamApiKey;
      dependencies.upstreamBaseUrl = PROVIDER_BASE_URL;

      await executor.insert(apiCredentials).values({
        id: credentialId,
        userId,
        version: 1,
        encryptionVersion: 1,
        encryptedKey: "synthetic-acceptance-placeholder",
        encryptionIv: "synthetic-acceptance-placeholder",
        encryptionAuthTag: "synthetic-acceptance-placeholder",
        fingerprint: credentialFingerprint,
        status: "active",
        validationStatus: "verified",
        verifiedAt: new Date(),
      });
      await executor.insert(userDashboardContents).values({
        userId,
        payload: createDefaultDashboardPayload(SYNTHETIC_COMPANY),
        sourceName: "synthetic-manus-v2-mysql-e2e.json",
        enterpriseIdentityBoundAt: new Date(),
        revision: 1,
      });

      const decryptedCredential = {
        id: credentialId,
        userId,
        version: 1,
        apiKey: upstreamApiKey,
        fingerprint: credentialFingerprint,
        status: "active",
        validationStatus: "verified",
        verifiedAt: new Date(),
      };
      dependencies.getDb.mockResolvedValue(executor);
      dependencies.assertServiceCapability.mockResolvedValue(undefined);
      dependencies.assertKnowledgeBaseWritable.mockResolvedValue(undefined);
      dependencies.createKnowledgeMonitoringHandoff.mockResolvedValue({
        created: [],
        assigned: false,
      });
      dependencies.getCredentialForUpstreamResource.mockResolvedValue(
        decryptedCredential,
      );
      dependencies.getDecryptedCredentialForKnowledgeBaseUploadReservation.mockResolvedValue(
        decryptedCredential,
      );
      // The authoritative task/file ownership rows are inserted by the v2
      // binding transactions. The legacy compatibility callback is a no-op.
      dependencies.recordUpstreamResource.mockResolvedValue(undefined);

      assetRoot = await mkdtemp(
        path.join(tmpdir(), "frontmind-kb-manus-v2-mysql-e2e-"),
      );
      process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetRoot;
      process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT = "100";
      process.env.FRONTMIND_KB_TREE_POLICY_V2_WRITER = "false";
      process.env.FRONTMIND_KB_MANUS_V2_WRITER = "true";
      process.env.FRONTMIND_UPSTREAM_BASE_URL = PROVIDER_BASE_URL;
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = `base64:${Buffer.alloc(32, 73).toString("base64")}`;

      fakeProvider = createFakeManusV2Provider({
        apiKey: upstreamApiKey,
        canonicalTaskId,
      });
      // Manus endpoints remain HTTPS. This adapter is the only network seam;
      // TLS validation is never disabled and Dashboard HTTP routes stay real.
      axios.defaults.adapter = fakeProvider.adapter;

      const { default: knowledgeBaseRouter } = await import(
        "../server/knowledge-base-api"
      );
      const { default: artifactRouter } = await import(
        "../server/knowledge-base-artifact-api"
      );
      const { default: dashboardRouter } = await import(
        "../server/dashboard-api"
      );
      const { requireExpressAuth } = await import(
        "../server/_core/express-auth"
      );
      const dashboard = express();
      dashboard.use(express.json({ limit: "5mb" }));
      dashboard.use(
        "/api/knowledge-base/artifacts",
        requireExpressAuth,
        artifactRouter,
      );
      dashboard.use(
        "/api/knowledge-base",
        requireExpressAuth,
        knowledgeBaseRouter,
      );
      dashboard.use("/api/dashboard", dashboardRouter);
      const listener = await listen(dashboard);
      dashboardServer = listener.server;
      dashboardBaseUrl = listener.baseUrl;
    }, 300_000);

    afterAll(async () => {
      let cleanupError: unknown;
      const preserveCleanupError = (error: unknown) => {
        if (!cleanupError) cleanupError = error;
      };
      try {
        await close(dashboardServer);
      } catch (error) {
        preserveCleanupError(error);
      }
      try {
        if (pool && userId) {
          await pool.execute(
            "DELETE FROM upstream_resources WHERE userId = ?",
            [userId],
          );
          await pool.execute(
            "UPDATE knowledge_base_builds SET publishedSnapshotId = NULL WHERE userId = ?",
            [userId],
          );
          await pool.execute(
            "DELETE FROM knowledge_base_snapshots WHERE userId = ?",
            [userId],
          );
          await pool.execute(
            "DELETE FROM knowledge_base_builds WHERE userId = ?",
            [userId],
          );
          await pool.execute("DELETE FROM conversations WHERE userId = ?", [
            userId,
          ]);
          await pool.execute(
            "DELETE FROM user_dashboard_contents WHERE userId = ?",
            [userId],
          );
          await pool.execute("DELETE FROM api_credentials WHERE userId = ?", [
            userId,
          ]);
          await pool.execute("DELETE FROM users WHERE id = ?", [userId]);
        }
      } catch (error) {
        preserveCleanupError(error);
      }
      try {
        if (pool) await pool.end();
      } catch (error) {
        preserveCleanupError(error);
      }
      try {
        if (assetRoot) await rm(assetRoot, { recursive: true, force: true });
      } catch (error) {
        preserveCleanupError(error);
      }
      axios.defaults.adapter = previousAxiosAdapter;
      const restoreEnvironment = (
        key: string,
        previous: string | undefined,
      ) => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      };
      restoreEnvironment("FRONTMIND_DASHBOARD_ASSET_DIR", previousAssetRoot);
      restoreEnvironment(
        "FRONTMIND_KB_V4_ROLLOUT_PERCENT",
        previousRolloutPercent,
      );
      restoreEnvironment(
        "FRONTMIND_KB_TREE_POLICY_V2_WRITER",
        previousTreePolicyWriter,
      );
      restoreEnvironment("FRONTMIND_KB_MANUS_V2_WRITER", previousManusV2Writer);
      restoreEnvironment(
        "FRONTMIND_UPSTREAM_BASE_URL",
        previousUpstreamBaseUrl,
      );
      restoreEnvironment(
        "FRONTMIND_CREDENTIAL_ENCRYPTION_KEY",
        previousCredentialEncryptionKey,
      );
      if (cleanupError) throw cleanupError;
      if (acceptancePassed) {
        console.log("KB_MANUS_V2_MYSQL_E2E_ACCEPTANCE_COMPLETE");
      }
    }, 120_000);

    it("runs reserve/dispatch, create-once/send-many, receipt acceptance, content completion, local packaging and immutable publication", async () => {
      expect(process.env.FRONTMIND_KB_MANUS_V2_WRITER).toBe("true");
      expect(userId).not.toBeNull();

      const startRequest = {
        conversationId: publicConversationId,
        clientRequestId: `start-${runId}`,
        companyName: SYNTHETIC_COMPANY,
        companyWebsite: SYNTHETIC_WEBSITE,
        operatorNotes: "仅包含合成验收资料",
        attachmentManifest: [],
      };
      const reserved = await postKnowledgeBase("/start/reserve", startRequest);
      expect(reserved).toMatchObject({
        accepted: true,
        reservationCreated: true,
        reservation: {
          turnId: expect.any(String),
          requiresUpload: false,
        },
      });
      // A reservation must not cross the provider boundary.
      expect(fakeProvider.fileUploads).toHaveLength(0);
      expect(fakeProvider.taskCreateBodies).toHaveLength(0);

      await postKnowledgeBase("/turn/dispatch", {
        conversationId: publicConversationId,
        turnId: reserved.reservation.turnId,
        clientRequestId: startRequest.clientRequestId,
        attachmentManifest: [],
      });
      let progress = await waitFor({
        label: "initial Manus v2 presentation",
        read: getProgress,
        accept: (payload) =>
          payload.observation?.interaction?.interactionState ===
            "awaiting_input" &&
          payload.observation?.approvedPresentation?.leafId === "1.1",
      });
      expect(progress.observation).toMatchObject({
        generation: 1,
        contentState: "building",
        publicationState: "draft",
        authoritativeTaskId: canonicalTaskId,
        canonicalTaskUrl: `https://manus.im/app/${canonicalTaskId}`,
        approvedPresentation: {
          revision: 0,
          leafId: "1.1",
          visibleMarkdown: syntheticLeaves[0]!.visibleMarkdown,
          contentSha256: knowledgeBaseMarkdownSha256(
            syntheticLeaves[0]!.visibleMarkdown,
          ),
          resources: [],
        },
      });
      expect(fakeProvider.taskCreateBodies).toHaveLength(1);
      expect(fakeProvider.taskSendBodies).toHaveLength(0);
      expect(fakeProvider.fileUploads.length).toBeGreaterThanOrEqual(2);
      expect(fakeProvider.fileDetailCalls.length).toBeGreaterThanOrEqual(
        fakeProvider.fileUploads.length * 2,
      );

      const build = (
        await executor
          .select()
          .from(knowledgeBaseBuilds)
          .where(eq(knowledgeBaseBuilds.conversationId, publicConversationId))
          .limit(1)
      )[0];
      expect(build).toMatchObject({
        providerProtocol: "manus_v2",
        canonicalTaskId,
        canonicalTaskGeneration: 1,
        canonicalCredentialId: credentialId,
        canonicalTaskState: "active",
        upstreamTaskId: canonicalTaskId,
        treePolicyVersion: 1,
        skillContentHash: KNOWLEDGE_BASE_TREE_POLICY_V1_SKILL_CONTENT_HASH,
        revision: 0,
        currentLeafId: "1.1",
      });

      for (let index = 0; index < FINAL_REVISION; index += 1) {
        const leaf = syntheticLeaves[index]!;
        const presentationKey =
          progress.observation.approvedPresentation?.presentationKey;
        expect(presentationKey).toEqual(expect.any(String));
        await postKnowledgeBase("/turn", {
          conversationId: publicConversationId,
          clientRequestId: `confirm-${index + 1}-${runId}`,
          userMessage: "确认",
          expectedGeneration: 1,
          expectedRevision: index,
          expectedLeafId: leaf.leafId,
          expectedPresentationKey: presentationKey,
        });
        const isFinal = index === FINAL_REVISION - 1;
        progress = await waitFor({
          label: `confirmation ${index + 1}`,
          read: getProgress,
          accept: (payload) =>
            isFinal
              ? payload.observation?.contentState === "completed" &&
                payload.observation?.interaction?.progress?.build?.revision ===
                  FINAL_REVISION
              : payload.observation?.interaction?.interactionState ===
                  "awaiting_input" &&
                payload.observation?.approvedPresentation?.leafId ===
                  syntheticLeaves[index + 1]!.leafId,
        });
        if (!isFinal) {
          expect(progress.observation.approvedPresentation).toMatchObject({
            revision: index + 1,
            leafId: syntheticLeaves[index + 1]!.leafId,
            visibleMarkdown: syntheticLeaves[index + 1]!.visibleMarkdown,
          });
        }
      }

      expect(fakeProvider.taskCreateBodies).toHaveLength(1);
      expect(fakeProvider.taskSendBodies).toHaveLength(FINAL_REVISION);
      expect(fakeProvider.taskSendBodies.length).toBeGreaterThanOrEqual(2);
      expect(
        new Set(
          fakeProvider.taskSendBodies.map((body) => String(body.task_id)),
        ),
      ).toEqual(new Set([canonicalTaskId]));
      expect(fakeProvider.taskListCalls).toBeGreaterThanOrEqual(
        FINAL_REVISION + 1,
      );
      for (const body of [
        ...fakeProvider.taskCreateBodies,
        ...fakeProvider.taskSendBodies,
      ]) {
        const contract = providerOperationContract(messagePrompt(body));
        assertStructuredSchema(body.structured_output_schema, contract);
      }

      const contentCompleteBuild = (
        await executor
          .select()
          .from(knowledgeBaseBuilds)
          .where(eq(knowledgeBaseBuilds.id, build.id))
          .limit(1)
      )[0];
      expect(contentCompleteBuild).toMatchObject({
        status: "ready_to_publish",
        providerProtocol: "manus_v2",
        canonicalTaskId,
        upstreamTaskId: canonicalTaskId,
        revision: FINAL_REVISION,
        confirmedCount: FINAL_REVISION,
        currentLeafId: null,
        activeTurnId: null,
        packageStatus: "preparing",
        packageStorageKey: null,
        packageArchiveSha256: null,
        protocolErrorCode: null,
      });
      expect(contentCompleteBuild.contentCompletedAt).toBeInstanceOf(Date);
      expect(progress.observation).toMatchObject({
        contentState: "completed",
        packageState: "preparing",
        publicationState: "draft",
        authoritativeTaskId: canonicalTaskId,
        approvedPresentation: {
          leafId: "1.8",
          visibleMarkdown: syntheticLeaves[7]!.visibleMarkdown,
        },
        package: null,
      });
      expect(progress.observation.displaySequence).toEqual(expect.any(Number));

      const turns = await executor
        .select()
        .from(conversationTurns)
        .where(eq(conversationTurns.userId, userId!));
      expect(turns).toHaveLength(FINAL_REVISION + 1);
      expect(turns.every((turn) => turn.status === "completed")).toBe(true);
      expect(new Set(turns.map((turn) => turn.upstreamTaskId))).toEqual(
        new Set([canonicalTaskId]),
      );
      const createTurns = turns.filter(
        (turn) => (turn.metadata as any).providerMethod === "task.create",
      );
      const sendTurns = turns.filter(
        (turn) => (turn.metadata as any).providerMethod === "task.sendMessage",
      );
      expect(createTurns).toHaveLength(1);
      expect(createTurns[0]!.expectedRevision).toBe(0);
      expect(sendTurns).toHaveLength(FINAL_REVISION);
      expect(
        sendTurns
          .map((turn) => turn.expectedRevision)
          .sort((left, right) => Number(left) - Number(right)),
      ).toEqual(Array.from({ length: FINAL_REVISION }, (_, index) => index));
      expect(
        turns.every(
          (turn) =>
            (turn.metadata as any).providerProtocol === "manus_v2" &&
            (turn.metadata as any).providerAttemptState === "accepted",
        ),
      ).toBe(true);

      const acceptedMessages = await executor
        .select()
        .from(messages)
        .where(eq(messages.userId, userId!))
        .orderBy(asc(messages.sequence));
      const presentations = acceptedMessages.filter(
        (message) =>
          (message.metadata as any)?.knowledgeBase?.kind === "presentation",
      );
      const completions = acceptedMessages.filter(
        (message) =>
          (message.metadata as any)?.knowledgeBase?.kind === "completion",
      );
      expect(presentations).toHaveLength(FINAL_REVISION);
      expect(completions).toHaveLength(1);
      expect(
        presentations.map((message) => ({
          leafId: (message.metadata as any).knowledgeBase.leafId,
          generation: (message.metadata as any).knowledgeBase.generation,
          serverOwned: (message.metadata as any).knowledgeBase.serverOwned,
          content: message.content,
        })),
      ).toEqual(
        syntheticLeaves.map((leaf) => ({
          leafId: leaf.leafId,
          generation: 1,
          serverOwned: true,
          content: leaf.visibleMarkdown,
        })),
      );
      expect(completions[0]).toMatchObject({
        role: "assistant",
        content: KNOWLEDGE_BASE_COMPLETION_MESSAGE_CONTENT,
      });
      expect((completions[0]!.metadata as any).knowledgeBase).toMatchObject({
        schemaVersion: 1,
        kind: "completion",
        buildId: build.id,
        generation: 1,
        revision: FINAL_REVISION,
        leafId: null,
        serverOwned: true,
      });
      expect(completions[0]!.sequence).toBeGreaterThan(
        presentations.at(-1)!.sequence,
      );
      expect(progress.observation.displaySequence).toBe(
        completions[0]!.sequence,
      );

      const nodes = await executor
        .select()
        .from(knowledgeBaseBuildNodes)
        .where(eq(knowledgeBaseBuildNodes.buildId, build.id))
        .orderBy(asc(knowledgeBaseBuildNodes.ordinal));
      expect(nodes).toHaveLength(FINAL_REVISION);
      expect(nodes.every((node) => node.status === "confirmed")).toBe(true);
      expect(
        nodes.map((node) => ({
          leafId: node.leafId,
          content: node.contentMarkdown,
          sha256: node.contentSha256,
        })),
      ).toEqual(
        syntheticLeaves.map((leaf) => ({
          leafId: leaf.leafId,
          content: leaf.visibleMarkdown,
          sha256: knowledgeBaseMarkdownSha256(leaf.visibleMarkdown),
        })),
      );

      const resources = await executor
        .select()
        .from(upstreamResources)
        .where(eq(upstreamResources.userId, userId!));
      const taskResources = resources.filter(
        (resource) => resource.kind === "task",
      );
      const fileResources = resources.filter(
        (resource) => resource.kind === "file",
      );
      expect(taskResources).toHaveLength(1);
      expect(taskResources[0]).toMatchObject({
        upstreamId: canonicalTaskId,
        apiCredentialId: credentialId,
      });
      expect(fileResources.length).toBe(fakeProvider.fileUploads.length);
      expect(
        new Set(resources.map((resource) => resource.apiCredentialId)),
      ).toEqual(new Set([credentialId]));

      const {
        runKnowledgeBasePackageSweep,
        readDashboardOwnedKnowledgePackage,
      } = await import("../server/knowledge-base-local-package");
      const packageSettlement = await waitFor({
        label: "Dashboard-owned package",
        read: async () => {
          const sweep = await runKnowledgeBasePackageSweep(1);
          const projection = await getProgress();
          return { sweep, projection };
        },
        accept: ({ sweep, projection }) => {
          const packageState = projection.observation?.packageState;
          if (
            sweep.failed !== 0 ||
            packageState === "retrying" ||
            packageState === "attention_required"
          ) {
            throw new Error(
              `Dashboard-owned package failed: ${JSON.stringify({ sweep, packageState })}`,
            );
          }
          return packageState === "ready";
        },
      });
      progress = packageSettlement.projection;
      expect(progress.observation).toMatchObject({
        contentState: "completed",
        packageState: "ready",
        publicationState: "draft",
        package: {
          revision: FINAL_REVISION,
          outputItemId: `dashboard-local:${build.id}:${FINAL_REVISION}`,
          downloadPath: `/api/knowledge-base/artifacts/${build.id}/package`,
          mimeType: "application/zip",
        },
      });

      const unauthenticatedPackage = await fetch(
        `${dashboardBaseUrl}/api/knowledge-base/artifacts/${build.id}/package`,
      );
      expect(unauthenticatedPackage.status).toBe(401);
      const packageResponse = await fetch(
        `${dashboardBaseUrl}/api/knowledge-base/artifacts/${build.id}/package`,
        { headers: { "x-test-auth": "user" } },
      );
      expect(packageResponse.status).toBe(200);
      const packageBytes = Buffer.from(await packageResponse.arrayBuffer());
      const packageBuild = (
        await executor
          .select()
          .from(knowledgeBaseBuilds)
          .where(eq(knowledgeBaseBuilds.id, build.id))
          .limit(1)
      )[0];
      expect(packageBuild).toMatchObject({
        contentCompletedAt: contentCompleteBuild.contentCompletedAt,
        packageStatus: "ready",
        packageAttemptCount: 1,
        packageRevision: FINAL_REVISION,
        packageTaskId: canonicalTaskId,
        packageOutputItemId: `dashboard-local:${build.id}:${FINAL_REVISION}`,
        packageFileId: null,
        packageArchiveSha256: sha256(packageBytes),
        packageSizeBytes: packageBytes.length,
      });
      expect(packageBuild.packageStorageKey).toEqual(expect.any(String));
      const parsedPackage = await readDashboardOwnedKnowledgePackage({
        buffer: packageBytes,
        expected: {
          buildId: build.id,
          generation: 1,
          revision: FINAL_REVISION,
          companyName: SYNTHETIC_COMPANY,
        },
        nodes,
      });
      expect(parsedPackage.documents).toHaveLength(FINAL_REVISION);
      expect(parsedPackage.manifest.missing_optional_assets).toContain(
        "official_logo",
      );
      expect(fakeProvider.taskCreateBodies).toHaveLength(1);
      expect(fakeProvider.taskSendBodies).toHaveLength(FINAL_REVISION);

      const unauthenticatedPublish = await fetch(
        `${dashboardBaseUrl}/api/dashboard/knowledge/publish`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId: publicConversationId }),
        },
      );
      expect(unauthenticatedPublish.status).toBe(401);
      const publishResponse = await fetch(
        `${dashboardBaseUrl}/api/dashboard/knowledge/publish`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify({ conversationId: publicConversationId }),
        },
      );
      expect(publishResponse.status).toBe(200);
      const published = (await publishResponse.json()) as any;
      expect(published).toMatchObject({
        kind: "knowledge",
        snapshot: {
          id: expect.any(String),
          sourceBuildId: build.id,
          sourceBuildRevision: FINAL_REVISION,
          sourceTaskId: canonicalTaskId,
          sourceArtifactHash: sha256(packageBytes),
          archiveHash: sha256(packageBytes),
          archiveAvailable: true,
          documentCount: FINAL_REVISION,
        },
      });

      const repeatedPublishResponse = await fetch(
        `${dashboardBaseUrl}/api/dashboard/knowledge/publish`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-auth": "user",
          },
          body: JSON.stringify({ conversationId: publicConversationId }),
        },
      );
      expect(repeatedPublishResponse.status).toBe(200);
      const repeatedPublished = (await repeatedPublishResponse.json()) as any;
      expect(repeatedPublished).toMatchObject({
        kind: "knowledge",
        idempotent: true,
        snapshot: { id: published.snapshot.id },
      });

      const snapshots = await executor
        .select()
        .from(knowledgeBaseSnapshots)
        .where(eq(knowledgeBaseSnapshots.sourceBuildId, build.id));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        id: published.snapshot.id,
        userId,
        sourceBuildRevision: FINAL_REVISION,
        sourceTaskId: canonicalTaskId,
        sourceArtifactHash: sha256(packageBytes),
        archiveHash: sha256(packageBytes),
        documentCount: FINAL_REVISION,
        imageCount: 0,
        totalBytes: packageBytes.length,
        status: "active",
      });
      expect(
        (snapshots[0]!.documents as any[]).map((document) => ({
          id: document.id,
          order: document.order,
          contentSha256: knowledgeBaseMarkdownSha256(document.content),
        })),
      ).toEqual(
        syntheticLeaves.map((leaf, order) => ({
          id: leaf.leafId,
          order,
          contentSha256: knowledgeBaseMarkdownSha256(leaf.visibleMarkdown),
        })),
      );

      const publishedArchiveUrl = `${dashboardBaseUrl}/api/dashboard/knowledge/snapshots/${published.snapshot.id}/archive`;
      expect((await fetch(publishedArchiveUrl)).status).toBe(401);
      const publishedArchiveResponse = await fetch(publishedArchiveUrl, {
        headers: { "x-test-auth": "user" },
      });
      expect(publishedArchiveResponse.status).toBe(200);
      expect(publishedArchiveResponse.headers.get("cache-control")).toBe(
        "private, no-store",
      );
      expect(Buffer.from(await publishedArchiveResponse.arrayBuffer())).toEqual(
        packageBytes,
      );

      const publishedBuild = (
        await executor
          .select()
          .from(knowledgeBaseBuilds)
          .where(eq(knowledgeBaseBuilds.id, build.id))
          .limit(1)
      )[0];
      expect(publishedBuild).toMatchObject({
        status: "published",
        publishedSnapshotId: published.snapshot.id,
        contentCompletedAt: contentCompleteBuild.contentCompletedAt,
        packageStatus: "ready",
        packageArchiveSha256: sha256(packageBytes),
      });
      progress = await getProgress();
      expect(progress.observation).toMatchObject({
        contentState: "completed",
        packageState: "ready",
        publicationState: "published",
      });
      expect(fakeProvider.taskCreateBodies).toHaveLength(1);
      expect(fakeProvider.taskSendBodies).toHaveLength(FINAL_REVISION);

      acceptancePassed = true;
    }, 300_000);
  },
);
