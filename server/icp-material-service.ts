import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray, lt, notInArray } from "drizzle-orm";

import {
  deliveryTicketAttachments,
  deliveryTickets,
  icpSensitiveMaterials,
} from "../drizzle/schema";
import type { IcpSensitiveMaterialCategory } from "../shared/delivery-ticket";
import type { AuthenticatedUser } from "./auth-service";
import { assertWorkspaceAccess } from "./dashboard-service";
import { getDb } from "./db";
import { DeliveryTicketError } from "./delivery-ticket-error";
import { writeWorkspaceAuditEvent } from "./admin-control-plane-service";

const MAX_ICP_MATERIAL_BYTES = 20 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 365;
const DOWNLOAD_TTL_SECONDS = 5 * 60;

function storageRoot() {
  return path.resolve(
    process.env.FRONTMIND_ICP_MATERIAL_DIR ||
      path.join(process.cwd(), ".frontmind-icp-materials"),
  );
}

function encryptionKey() {
  const configured = process.env.FRONTMIND_ICP_MATERIAL_KEY?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("FRONTMIND_ICP_MATERIAL_KEY is required in production");
    }
    return createHash("sha256")
      .update("frontmind-development-icp-material-key", "utf8")
      .digest();
  }
  const [encoding, encodedValue] = configured.startsWith("base64:")
    ? (["base64", configured.slice("base64:".length)] as const)
    : configured.startsWith("hex:")
      ? (["hex", configured.slice("hex:".length)] as const)
      : /^[a-f0-9]{64}$/i.test(configured)
        ? (["hex", configured] as const)
        : (["base64", configured] as const);
  const decoded = Buffer.from(encodedValue, encoding);
  if (decoded.byteLength !== 32) {
    throw new Error(
      "FRONTMIND_ICP_MATERIAL_KEY must be a 32-byte base64 or hex key",
    );
  }
  return decoded;
}

export function assertIcpMaterialStorageConfigured() {
  encryptionKey();
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.FRONTMIND_ICP_MATERIAL_DIR
  ) {
    throw new Error(
      "FRONTMIND_ICP_MATERIAL_DIR is required in production",
    );
  }
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new DeliveryTicketError(
      "DATABASE_UNAVAILABLE",
      "数据库暂时不可用。",
      503,
    );
  }
  return db;
}

function materialAad(input: {
  id: string;
  workspaceUserId: number;
  category: string;
}) {
  return Buffer.from(
    `frontmind-icp-material:v1:${input.workspaceUserId}:${input.id}:${input.category}`,
    "utf8",
  );
}

function encryptedStoragePath(storageKey: string) {
  if (!/^[0-9a-f-]{36}\.bin$/i.test(storageKey)) {
    throw new DeliveryTicketError(
      "ICP_MATERIAL_UNAVAILABLE",
      "ICP 材料不可用。",
      410,
    );
  }
  return path.join(storageRoot(), storageKey);
}

function retentionUntil(now = new Date()) {
  const configured = Number(process.env.FRONTMIND_ICP_RETENTION_DAYS);
  const days =
    Number.isInteger(configured) && configured > 0 && configured <= 3650
      ? configured
      : DEFAULT_RETENTION_DAYS;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1_000);
}

export async function cleanupExpiredIcpMaterials(now = new Date()) {
  const db = await requireDb();
  const rows = await db
    .select({
      id: icpSensitiveMaterials.id,
      storageKey: icpSensitiveMaterials.storageKey,
    })
    .from(icpSensitiveMaterials)
    .where(
      and(
        inArray(icpSensitiveMaterials.status, ["active", "replaced"]),
        lt(icpSensitiveMaterials.retentionUntil, now),
      ),
    )
    .limit(100);
  for (const row of rows) {
    await unlink(encryptedStoragePath(row.storageKey)).catch(() => undefined);
    await db
      .update(icpSensitiveMaterials)
      .set({ status: "expired", updatedAt: now })
      .where(eq(icpSensitiveMaterials.id, row.id));
  }
  return rows.length;
}

async function cleanupAllExpiredIcpMaterials() {
  let removed = 0;
  for (let batch = 0; batch < 100; batch += 1) {
    const count = await cleanupExpiredIcpMaterials();
    removed += count;
    if (count < 100) break;
  }
  return removed;
}

export function startIcpMaterialRetentionScheduler() {
  if (process.env.NODE_ENV === "test") return () => undefined;
  const run = () =>
    cleanupAllExpiredIcpMaterials().catch((error) => {
      console.error("[ICP material] Retention cleanup failed", error);
    });
  const initial = setTimeout(run, 30_000);
  initial.unref();
  const interval = setInterval(run, 24 * 60 * 60 * 1_000);
  interval.unref();
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}

export async function storeIcpMaterial(input: {
  actor: AuthenticatedUser;
  workspaceUserId: number;
  filename: string;
  mimeType?: string | null;
  category: IcpSensitiveMaterialCategory;
  bytes: Buffer;
  replacesMaterialId?: string | null;
}) {
  await assertWorkspaceAccess(input.actor, input.workspaceUserId);
  if (!input.bytes.length) {
    throw new DeliveryTicketError(
      "ICP_MATERIAL_EMPTY",
      "上传的 ICP 材料为空。",
      400,
    );
  }
  if (input.bytes.byteLength > MAX_ICP_MATERIAL_BYTES) {
    throw new DeliveryTicketError(
      "ICP_MATERIAL_TOO_LARGE",
      "单个 ICP 材料不能超过 20 MB。",
      413,
    );
  }
  const db = await requireDb();
  const now = new Date();
  const id = randomUUID();
  const storageKey = `${randomUUID()}.bin`;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(
    materialAad({
      id,
      workspaceUserId: input.workspaceUserId,
      category: input.category,
    }),
  );
  const encrypted = Buffer.concat([
    cipher.update(input.bytes),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  await mkdir(storageRoot(), { recursive: true, mode: 0o700 });
  await writeFile(encryptedStoragePath(storageKey), encrypted, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await db.transaction(async (tx) => {
      let replaced: typeof icpSensitiveMaterials.$inferSelect | null = null;
      if (input.replacesMaterialId) {
        const rows = await tx
          .select()
          .from(icpSensitiveMaterials)
          .where(
            and(
              eq(icpSensitiveMaterials.id, input.replacesMaterialId),
              eq(
                icpSensitiveMaterials.workspaceUserId,
                input.workspaceUserId,
              ),
              eq(icpSensitiveMaterials.status, "active"),
            ),
          )
          .limit(1)
          .for("update");
        replaced = rows[0] ?? null;
        if (!replaced) {
          throw new DeliveryTicketError(
            "ICP_MATERIAL_NOT_FOUND",
            "需要替换的 ICP 材料不存在。",
            404,
          );
        }
      }
      await tx.insert(icpSensitiveMaterials).values({
        id,
        workspaceUserId: input.workspaceUserId,
        ownerUserId: input.actor.id,
        storageKey,
        encryptionVersion: 1,
        encryptionIv: iv.toString("base64"),
        encryptionAuthTag: authTag.toString("base64"),
        filename: input.filename.trim().slice(0, 512) || "ICP 材料",
        mimeType: input.mimeType?.trim().slice(0, 255) || null,
        sizeBytes: input.bytes.byteLength,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
        category: input.category,
        status: "active",
        retentionUntil: retentionUntil(now),
        createdAt: now,
        updatedAt: now,
      });
      if (replaced) {
        await tx
          .update(icpSensitiveMaterials)
          .set({
            status: "replaced",
            replacedByMaterialId: id,
            updatedAt: now,
          })
          .where(eq(icpSensitiveMaterials.id, replaced.id));
        await tx
          .update(deliveryTicketAttachments)
          .set({
            protectedMaterialId: id,
            filename: "ICP 敏感材料",
            mimeType: input.mimeType?.trim().slice(0, 255) || null,
            sizeBytes: input.bytes.byteLength,
            sha256: createHash("sha256").update(input.bytes).digest("hex"),
          })
          .where(
            eq(
              deliveryTicketAttachments.protectedMaterialId,
              replaced.id,
            ),
          );
      }
      await writeWorkspaceAuditEvent(
        {
          actor: input.actor,
          action: replaced
            ? "icp_material.replaced"
            : "icp_material.uploaded",
          targetType: "icp_sensitive_material",
          targetId: id,
          workspaceUserId: input.workspaceUserId,
          metadata: {
            category: input.category,
            sizeBytes: input.bytes.byteLength,
            replacedMaterialId: replaced?.id ?? null,
          },
        },
        tx,
      );
    });
  } catch (error) {
    await unlink(encryptedStoragePath(storageKey)).catch(() => undefined);
    throw error;
  }
  void cleanupExpiredIcpMaterials().catch(() => undefined);
  return {
    id,
    protectedMaterialId: id,
    storageKind: "icp_protected" as const,
    filename: "ICP 敏感材料",
    mimeType: input.mimeType?.trim().slice(0, 255) || null,
    sizeBytes: input.bytes.byteLength,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    sensitiveCategory: input.category,
    retentionUntil: retentionUntil(now).getTime(),
  };
}

export async function listIcpMaterials(input: {
  actor: AuthenticatedUser;
  workspaceUserId: number;
}) {
  await assertWorkspaceAccess(input.actor, input.workspaceUserId);
  const db = await requireDb();
  const rows = await db
    .select({
      id: icpSensitiveMaterials.id,
      category: icpSensitiveMaterials.category,
      mimeType: icpSensitiveMaterials.mimeType,
      sizeBytes: icpSensitiveMaterials.sizeBytes,
      retentionUntil: icpSensitiveMaterials.retentionUntil,
      createdAt: icpSensitiveMaterials.createdAt,
    })
    .from(icpSensitiveMaterials)
    .where(
      and(
        eq(icpSensitiveMaterials.workspaceUserId, input.workspaceUserId),
        eq(icpSensitiveMaterials.status, "active"),
      ),
    );
  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    filename: "ICP 敏感材料",
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    retentionUntil: row.retentionUntil.getTime(),
    createdAt: row.createdAt.getTime(),
    downloadUrl: createIcpMaterialDownloadUrl(row.id),
  }));
}

async function resolveIcpMaterial(input: {
  actor: AuthenticatedUser;
  materialId: string;
  activeOnly?: boolean;
}) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(icpSensitiveMaterials)
    .where(eq(icpSensitiveMaterials.id, input.materialId))
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    (input.activeOnly !== false && row.status !== "active") ||
    row.retentionUntil.getTime() <= Date.now()
  ) {
    throw new DeliveryTicketError(
      "ICP_MATERIAL_NOT_FOUND",
      "ICP 材料不存在或已撤回。",
      404,
    );
  }
  await assertWorkspaceAccess(input.actor, row.workspaceUserId);
  return row;
}

export function createIcpMaterialDownloadUrl(materialId: string) {
  const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
  const payload = `${materialId}.${expires}`;
  const signature = createHmac("sha256", encryptionKey())
    .update(payload)
    .digest("base64url");
  return `/api/icp-materials/${materialId}/content?expires=${expires}&signature=${encodeURIComponent(signature)}`;
}

function verifyDownloadSignature(
  materialId: string,
  expiresValue: string,
  signatureValue: string,
) {
  const expires = Number(expiresValue);
  if (
    !Number.isSafeInteger(expires) ||
    expires < Math.floor(Date.now() / 1000) ||
    expires > Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS + 30
  ) {
    return false;
  }
  const expected = createHmac("sha256", encryptionKey())
    .update(`${materialId}.${expires}`)
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signatureValue, "base64url");
  } catch {
    return false;
  }
  return supplied.byteLength === expected.byteLength &&
    timingSafeEqual(supplied, expected);
}

export async function readIcpMaterial(input: {
  actor: AuthenticatedUser;
  materialId: string;
  expires: string;
  signature: string;
}) {
  if (
    !verifyDownloadSignature(
      input.materialId,
      input.expires,
      input.signature,
    )
  ) {
    throw new DeliveryTicketError(
      "ICP_DOWNLOAD_URL_EXPIRED",
      "下载地址已失效，请刷新后重试。",
      403,
    );
  }
  const row = await resolveIcpMaterial({
    actor: input.actor,
    materialId: input.materialId,
  });
  const encrypted = await readFile(encryptedStoragePath(row.storageKey));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(row.encryptionIv, "base64"),
  );
  decipher.setAAD(
    materialAad({
      id: row.id,
      workspaceUserId: row.workspaceUserId,
      category: row.category,
    }),
  );
  decipher.setAuthTag(Buffer.from(row.encryptionAuthTag, "base64"));
  const bytes = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== row.sha256) {
    throw new DeliveryTicketError(
      "ICP_MATERIAL_INTEGRITY_FAILED",
      "ICP 材料完整性校验失败。",
      500,
    );
  }
  await writeWorkspaceAuditEvent({
    actor: input.actor,
    action: "icp_material.downloaded",
    targetType: "icp_sensitive_material",
    targetId: row.id,
    workspaceUserId: row.workspaceUserId,
    metadata: { category: row.category, sizeBytes: row.sizeBytes },
  });
  return {
    bytes,
    mimeType: row.mimeType || "application/octet-stream",
    category: row.category,
  };
}

export async function withdrawIcpMaterial(input: {
  actor: AuthenticatedUser;
  materialId: string;
}) {
  const row = await resolveIcpMaterial({
    actor: input.actor,
    materialId: input.materialId,
  });
  const db = await requireDb();
  const now = new Date();
  const activeTicketReferences = await db
    .select({ ticketId: deliveryTickets.id })
    .from(deliveryTicketAttachments)
    .innerJoin(
      deliveryTickets,
      eq(deliveryTickets.id, deliveryTicketAttachments.ticketId),
    )
    .where(
      and(
        eq(deliveryTicketAttachments.protectedMaterialId, row.id),
        notInArray(deliveryTickets.status, [
          "completed",
          "rejected",
          "cancelled",
        ]),
      ),
    )
    .limit(1);
  if (activeTicketReferences[0]) {
    throw new DeliveryTicketError(
      "ICP_MATERIAL_STILL_IN_USE",
      "该材料仍用于待受理备案工单，请使用“替换”上传新材料。",
      409,
    );
  }
  await db.transaction(async (tx) => {
    await tx
      .update(icpSensitiveMaterials)
      .set({ status: "withdrawn", withdrawnAt: now, updatedAt: now })
      .where(
        and(
          eq(icpSensitiveMaterials.id, row.id),
          eq(icpSensitiveMaterials.status, "active"),
        ),
      );
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "icp_material.withdrawn",
        targetType: "icp_sensitive_material",
        targetId: row.id,
        workspaceUserId: row.workspaceUserId,
        metadata: { category: row.category },
      },
      tx,
    );
  });
  await unlink(encryptedStoragePath(row.storageKey)).catch(() => undefined);
  return { success: true };
}
