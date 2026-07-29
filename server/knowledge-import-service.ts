import axios from "axios";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  knowledgeImportReceipts,
  websiteUserProvisions,
} from "../drizzle/schema";
import {
  collectKnowledgeArchiveDescriptors,
  knowledgeArchiveDescriptorHash,
} from "./knowledge-base-artifact";
import {
  assertKnowledgeArchiveEnterpriseIdentity,
  downloadArchiveBytes,
  readKnowledgeArchive,
  removeStoredKnowledgeAssets,
} from "./dashboard-api";
import {
  createKnowledgeSnapshot,
  getDashboardWorkspace,
  getLatestKnowledgeSnapshot,
} from "./dashboard-service";
import {
  getPresalesCredentialForResource,
  getPresalesTaskProjectBinding,
} from "./presales-service";
import { getDb } from "./db";
import { getUpstreamBaseUrl } from "./upstream-config";
import {
  assertServiceCapability,
  ServiceEntitlementError,
} from "./service-entitlement";

const sha256Schema = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{64}$/i);

const websiteKnowledgeImportBaseSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  taskId: z.string().trim().min(1).max(255),
  outputItemId: z.string().trim().min(1).max(255),
  fileId: z.string().trim().min(1).max(255).optional(),
  descriptorHash: sha256Schema,
  artifactSha256: sha256Schema,
  filename: z.string().trim().min(1).max(512),
});

export const websiteKnowledgeImportSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    websiteKnowledgeImportBaseSchema
      .extend({
        schemaVersion: z.literal(2),
      })
      .strict(),
    websiteKnowledgeImportBaseSchema
      .extend({
        schemaVersion: z.literal(3),
        archiveContractVersion: z.union([z.literal(1), z.literal(2)]),
        validationProfile: z.literal("website-lead-v1"),
        packageManifestSha256: sha256Schema,
      })
      .strict(),
  ],
);

export type WebsiteKnowledgeImport = z.infer<
  typeof websiteKnowledgeImportSchema
>;

export type KnowledgeImportErrorCode =
  | "PROJECT_NOT_PROVISIONED"
  | "PROJECT_OWNER_CONFLICT"
  | "PROJECT_ENTERPRISE_CONFLICT"
  | "PROJECT_ENTERPRISE_MISMATCH"
  | "TASK_PROJECT_MISMATCH"
  | "TASK_NOT_COMPLETED"
  | "ARTIFACT_DESCRIPTOR_MISMATCH"
  | "ARTIFACT_HASH_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_PENDING"
  | "SERVICE_NOT_WRITABLE"
  | "DATABASE_UNAVAILABLE"
  | "KNOWLEDGE_IMPORT_FAILED";

export class KnowledgeImportError extends Error {
  constructor(
    public readonly code: KnowledgeImportErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "KnowledgeImportError";
  }
}

function normalizedEnterpriseName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, "").toLowerCase();
}

export function resolveKnowledgeImportProjectOwner(
  provisions: Array<{
    userId: number | null;
    companyName: string;
    status: string;
  }>,
  requestedCompanyName: string,
) {
  const completed = provisions.filter(
    (provision) =>
      provision.status === "completed" &&
      Number.isInteger(provision.userId) &&
      Number(provision.userId) > 0,
  );
  if (completed.length === 0) {
    throw new KnowledgeImportError(
      "PROJECT_NOT_PROVISIONED",
      "当前官网项目尚未完成账号开通",
      409,
    );
  }
  const userIds = new Set(completed.map((provision) => provision.userId!));
  if (userIds.size !== 1) {
    throw new KnowledgeImportError(
      "PROJECT_OWNER_CONFLICT",
      "同一官网项目关联了多个用户账号，无法确定知识库归属",
      409,
    );
  }
  const enterpriseNames = new Set(
    completed.map((provision) =>
      normalizedEnterpriseName(provision.companyName),
    ),
  );
  if (enterpriseNames.size !== 1) {
    throw new KnowledgeImportError(
      "PROJECT_ENTERPRISE_CONFLICT",
      "同一官网项目包含相互冲突的企业身份，无法导入知识库",
      409,
    );
  }
  const provision = completed[0]!;
  if (
    normalizedEnterpriseName(provision.companyName) !==
    normalizedEnterpriseName(requestedCompanyName)
  ) {
    throw new KnowledgeImportError(
      "PROJECT_ENTERPRISE_MISMATCH",
      "知识库企业与官网开通企业不一致",
      409,
    );
  }
  return {
    userId: provision.userId!,
    companyName: provision.companyName,
    purchaseCount: completed.length,
  };
}

function idempotencyHash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const websiteKnowledgeImportV3ReferencePrefix = "website-kb:v3";

export function knowledgeImportReceiptSourceReference(input: {
  projectId: string;
  value: WebsiteKnowledgeImport;
}) {
  if (input.value.schemaVersion === 3) {
    return [
      websiteKnowledgeImportV3ReferencePrefix,
      input.value.archiveContractVersion,
      input.value.validationProfile,
      input.value.packageManifestSha256.toLowerCase(),
    ].join(":");
  }
  return `${input.projectId}:${input.value.taskId}`.slice(0, 191);
}

function knowledgeArtifactReceiptDescriptorMatchesRequest(
  receipt: {
    projectId: string | null;
    taskId: string | null;
    outputItemId: string | null;
    fileId: string | null;
    descriptorHash: string | null;
  },
  input: {
    projectId: string;
    value: WebsiteKnowledgeImport;
  },
) {
  return (
    receipt.projectId === input.projectId &&
    receipt.taskId === input.value.taskId &&
    receipt.outputItemId === input.value.outputItemId &&
    (receipt.fileId ?? null) === (input.value.fileId ?? null) &&
    receipt.descriptorHash?.toLowerCase() ===
      input.value.descriptorHash.toLowerCase()
  );
}

export function knowledgeArtifactReceiptMatchesRequest(
  receipt: {
    projectId: string | null;
    taskId: string | null;
    outputItemId: string | null;
    fileId: string | null;
    descriptorHash: string | null;
    sourceReference?: string | null;
  },
  input: {
    projectId: string;
    value: WebsiteKnowledgeImport;
  },
) {
  if (!knowledgeArtifactReceiptDescriptorMatchesRequest(receipt, input)) {
    return false;
  }
  return (
    input.value.schemaVersion === 2 ||
    receipt.sourceReference === knowledgeImportReceiptSourceReference(input)
  );
}

async function requireImportDb() {
  const db = await getDb();
  if (!db) {
    throw new KnowledgeImportError(
      "DATABASE_UNAVAILABLE",
      "知识库同步服务暂不可用",
      503,
    );
  }
  return db;
}

type ReceiptReservation =
  | {
      state: "completed";
      receiptId: string;
      snapshot: Awaited<ReturnType<typeof getLatestKnowledgeSnapshot>>;
    }
  | { state: "acquired"; receiptId: string };

async function reserveReceipt(input: {
  userId: number;
  projectId: string;
  idempotencyKey: string;
  value: WebsiteKnowledgeImport;
  now: Date;
}): Promise<ReceiptReservation> {
  const db = await requireImportDb();
  const keyHash = idempotencyHash(input.idempotencyKey);
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(knowledgeImportReceipts)
      .where(eq(knowledgeImportReceipts.idempotencyKeyHash, keyHash))
      .limit(1)
      .for("update");
    const existing = rows[0];
    if (existing) {
      const sameArtifact =
        existing.userId === input.userId &&
        knowledgeArtifactReceiptDescriptorMatchesRequest(existing, input) &&
        existing.artifactHash.toLowerCase() ===
          input.value.artifactSha256.toLowerCase();
      if (!sameArtifact) {
        throw new KnowledgeImportError(
          "IDEMPOTENCY_CONFLICT",
          "该幂等键已用于不同的知识库产物",
          409,
        );
      }
      const sameRequest = knowledgeArtifactReceiptMatchesRequest(
        existing,
        input,
      );
      if (
        sameRequest &&
        existing.status === "completed" &&
        existing.snapshotId
      ) {
        return {
          state: "completed",
          receiptId: existing.id,
          snapshot: await getLatestKnowledgeSnapshot(input.userId),
        };
      }
      const ageMs = input.now.getTime() - existing.updatedAt.getTime();
      if (
        (existing.status === "pending" || existing.status === "processing") &&
        ageMs < 5 * 60 * 1000
      ) {
        throw new KnowledgeImportError(
          "IDEMPOTENCY_PENDING",
          "相同知识库正在同步中",
          425,
          2_000,
        );
      }
      await tx
        .update(knowledgeImportReceipts)
        .set({
          status: "processing",
          attemptCount: existing.attemptCount + 1,
          errorCode: null,
          errorMessage: null,
          sourceReference: knowledgeImportReceiptSourceReference(input),
          updatedAt: input.now,
        })
        .where(eq(knowledgeImportReceipts.id, existing.id));
      return { state: "acquired", receiptId: existing.id };
    }

    const artifactRows = await tx
      .select()
      .from(knowledgeImportReceipts)
      .where(
        and(
          eq(knowledgeImportReceipts.userId, input.userId),
          eq(
            knowledgeImportReceipts.artifactHash,
            input.value.artifactSha256.toLowerCase(),
          ),
        ),
      )
      .limit(1)
      .for("update");
    const existingArtifact = artifactRows[0];
    if (existingArtifact) {
      const sameArtifactDescriptor =
        knowledgeArtifactReceiptDescriptorMatchesRequest(
          existingArtifact,
          input,
        );
      if (!sameArtifactDescriptor) {
        throw new KnowledgeImportError(
          "IDEMPOTENCY_CONFLICT",
          "相同知识库产物已由另一份任务描述导入，不能重复绑定",
          409,
        );
      }
      const sameArtifactRequest = knowledgeArtifactReceiptMatchesRequest(
        existingArtifact,
        input,
      );
      if (
        sameArtifactRequest &&
        existingArtifact.status === "completed" &&
        existingArtifact.snapshotId
      ) {
        return {
          state: "completed",
          receiptId: existingArtifact.id,
          snapshot: await getLatestKnowledgeSnapshot(input.userId),
        };
      }
      if (
        input.value.schemaVersion === 3 &&
        !sameArtifactRequest &&
        existingArtifact.status === "completed" &&
        existingArtifact.snapshotId
      ) {
        await tx
          .update(knowledgeImportReceipts)
          .set({
            status: "processing",
            attemptCount: existingArtifact.attemptCount + 1,
            errorCode: null,
            errorMessage: null,
            sourceReference: knowledgeImportReceiptSourceReference(input),
            updatedAt: input.now,
          })
          .where(eq(knowledgeImportReceipts.id, existingArtifact.id));
        return { state: "acquired", receiptId: existingArtifact.id };
      }
      if (
        existingArtifact.status === "pending" ||
        existingArtifact.status === "processing"
      ) {
        throw new KnowledgeImportError(
          "IDEMPOTENCY_PENDING",
          "相同知识库正在同步中",
          425,
          2_000,
        );
      }
      throw new KnowledgeImportError(
        "IDEMPOTENCY_CONFLICT",
        "相同知识库产物已有失败记录，请使用原幂等键重试",
        409,
      );
    }

    const receiptId = randomUUID();
    try {
      await tx.insert(knowledgeImportReceipts).values({
        id: receiptId,
        userId: input.userId,
        source: "website",
        projectId: input.projectId,
        companyName: input.value.companyName,
        taskId: input.value.taskId,
        fileId: input.value.fileId ?? null,
        outputItemId: input.value.outputItemId,
        descriptorHash: input.value.descriptorHash.toLowerCase(),
        sourceReference: knowledgeImportReceiptSourceReference(input),
        idempotencyKeyHash: keyHash,
        artifactHash: input.value.artifactSha256.toLowerCase(),
        sourceFileName: input.value.filename,
        status: "processing",
        attemptCount: 1,
        revision: 1,
        createdAt: input.now,
        updatedAt: input.now,
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "ER_DUP_ENTRY") {
        throw new KnowledgeImportError(
          "IDEMPOTENCY_PENDING",
          "相同知识库正在同步中",
          425,
          2_000,
        );
      }
      throw error;
    }
    return { state: "acquired", receiptId };
  });
}

async function markReceiptFailed(receiptId: string, error: unknown) {
  const db = await requireImportDb();
  await db
    .update(knowledgeImportReceipts)
    .set({
      status: "failed",
      errorCode:
        error instanceof KnowledgeImportError
          ? error.code
          : "KNOWLEDGE_IMPORT_FAILED",
      errorMessage: (error instanceof Error
        ? error.message
        : "知识库同步失败"
      ).slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(eq(knowledgeImportReceipts.id, receiptId));
}

export async function importWebsiteKnowledgeArtifact(input: {
  projectId: string;
  idempotencyKey: string;
  value: WebsiteKnowledgeImport;
  now?: Date;
}) {
  const value = websiteKnowledgeImportSchema.parse(input.value);
  const db = await requireImportDb();
  const provisions = await db
    .select({
      userId: websiteUserProvisions.userId,
      companyName: websiteUserProvisions.companyName,
      status: websiteUserProvisions.status,
    })
    .from(websiteUserProvisions)
    .where(eq(websiteUserProvisions.projectId, input.projectId));
  const provision = resolveKnowledgeImportProjectOwner(
    provisions,
    value.companyName,
  );
  const binding = await getPresalesTaskProjectBinding(value.taskId);
  if (!binding || binding.projectId !== input.projectId) {
    throw new KnowledgeImportError(
      "TASK_PROJECT_MISMATCH",
      "知识库任务不属于当前官网项目",
      403,
    );
  }

  const reservation = await reserveReceipt({
    userId: provision.userId,
    projectId: input.projectId,
    idempotencyKey: input.idempotencyKey,
    value,
    now: input.now ?? new Date(),
  });
  if (reservation.state === "completed") {
    return {
      status: "completed" as const,
      replayed: true,
      receiptId: reservation.receiptId,
      snapshot: reservation.snapshot,
    };
  }

  let storedAssetKeys: string[] = [];
  try {
    try {
      await assertServiceCapability(provision.userId, "knowledgeDisplay");
    } catch (error) {
      if (error instanceof ServiceEntitlementError) {
        throw new KnowledgeImportError(
          "SERVICE_NOT_WRITABLE",
          error.message,
          error.statusCode,
        );
      }
      throw error;
    }
    const credential = await getPresalesCredentialForResource(
      "task",
      value.taskId,
    );
    if (
      !credential ||
      credential.id !== binding.apiCredentialId ||
      credential.version !== binding.credentialVersion
    ) {
      throw new KnowledgeImportError(
        "TASK_PROJECT_MISMATCH",
        "知识库任务的凭据归属无法验证",
        403,
      );
    }
    const taskResponse = await axios.get(
      `${getUpstreamBaseUrl()}/v1/tasks/${encodeURIComponent(value.taskId)}`,
      {
        headers: {
          API_KEY: credential.apiKey,
          Authorization: `Bearer ${credential.apiKey}`,
        },
        timeout: 120_000,
        validateStatus: () => true,
      },
    );
    if (taskResponse.status !== 200) {
      throw new KnowledgeImportError(
        "KNOWLEDGE_IMPORT_FAILED",
        `读取知识库任务失败 (${taskResponse.status})`,
        502,
      );
    }
    const task = taskResponse.data?.task || taskResponse.data || {};
    const returnedTaskId = String(task.id || task.task_id || "");
    if (returnedTaskId !== value.taskId) {
      throw new KnowledgeImportError(
        "TASK_PROJECT_MISMATCH",
        "读取到的知识库任务标识不匹配",
        409,
      );
    }
    if (task.status !== "completed") {
      throw new KnowledgeImportError(
        "TASK_NOT_COMPLETED",
        "知识库任务尚未完成",
        409,
      );
    }
    const matches = collectKnowledgeArchiveDescriptors(task.output).filter(
      (descriptor) =>
        descriptor.outputItemId === value.outputItemId &&
        (!value.fileId || descriptor.fileId === value.fileId) &&
        knowledgeArchiveDescriptorHash(descriptor) ===
          value.descriptorHash.toLowerCase(),
    );
    if (matches.length !== 1) {
      throw new KnowledgeImportError(
        "ARTIFACT_DESCRIPTOR_MISMATCH",
        "无法在知识库任务中唯一确认所声明的 ZIP 产物",
        409,
      );
    }
    const downloaded = await downloadArchiveBytes({
      descriptor: matches[0]!,
      apiKey: credential.apiKey,
      baseUrl: getUpstreamBaseUrl(),
    });
    const archiveHash = createHash("sha256")
      .update(downloaded.buffer)
      .digest("hex");
    if (archiveHash !== value.artifactSha256.toLowerCase()) {
      throw new KnowledgeImportError(
        "ARTIFACT_HASH_MISMATCH",
        "知识库 ZIP 哈希与官网声明不一致",
        409,
      );
    }
    const snapshotId = randomUUID();
    const parsed = await readKnowledgeArchive(
      downloaded.buffer,
      downloaded.filename,
      snapshotId,
      {
        validationProfile:
          value.schemaVersion === 3 ? "website-lead-v1" : "historical",
        archiveContractVersion:
          value.schemaVersion === 3 ? value.archiveContractVersion : undefined,
      },
    );
    if (
      value.schemaVersion === 3 &&
      parsed.packageManifestSha256?.toLowerCase() !==
        value.packageManifestSha256.toLowerCase()
    ) {
      throw new KnowledgeImportError(
        "ARTIFACT_HASH_MISMATCH",
        "知识库 package manifest 哈希与官网声明不一致",
        409,
      );
    }
    storedAssetKeys = parsed.storedAssetKeys;
    const workspace = await getDashboardWorkspace(provision.userId);
    if (
      normalizedEnterpriseName(workspace.payload.brandName) !==
      normalizedEnterpriseName(value.companyName)
    ) {
      throw new KnowledgeImportError(
        "PROJECT_ENTERPRISE_MISMATCH",
        "用户工作空间企业与官网知识库企业不一致",
        409,
      );
    }
    assertKnowledgeArchiveEnterpriseIdentity({
      enterpriseIdentityConfirmed: true,
      brandName: workspace.payload.brandName,
      documents: parsed.documents,
    });
    const snapshot = await createKnowledgeSnapshot({
      snapshotId,
      userId: provision.userId,
      actorUserId: provision.userId,
      sourceFileName: downloaded.filename,
      sourceTaskId: value.taskId,
      sourceArtifactHash: value.descriptorHash.toLowerCase(),
      archiveHash,
      documents: parsed.documents,
      assets: parsed.assets,
      totalBytes: downloaded.buffer.length,
    });
    await db
      .update(knowledgeImportReceipts)
      .set({
        status: "completed",
        snapshotId,
        sourceFileName: downloaded.filename,
        completedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(knowledgeImportReceipts.id, reservation.receiptId),
          eq(knowledgeImportReceipts.status, "processing"),
        ),
      );
    return {
      status: "completed" as const,
      replayed: false,
      receiptId: reservation.receiptId,
      snapshot,
    };
  } catch (error) {
    await removeStoredKnowledgeAssets(storedAssetKeys);
    await markReceiptFailed(reservation.receiptId, error);
    throw error instanceof KnowledgeImportError
      ? error
      : new KnowledgeImportError(
          "KNOWLEDGE_IMPORT_FAILED",
          error instanceof Error ? error.message : "知识库同步失败",
          400,
        );
  }
}
