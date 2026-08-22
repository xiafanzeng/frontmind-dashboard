import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, max, or } from "drizzle-orm";
import {
  messages,
  siteBuilds,
  siteDeployments,
  siteDomainOperations,
  siteOperations,
  siteProjects,
  socialPackages,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { finalizePendingTwentyFirstCredentialRevocations } from "../twenty-first-service";
import { runtimeErrorForLog } from "../_core/runtime-error-log";
import {
  getSiteOpsProviderHandler,
  type SiteOpsProviderResult,
} from "./providers";
import { siteOpsQuotaStateForProviderResult } from "./quota-service";
import { publicSiteOpsProviderResult } from "./public-errors";

const DEFAULT_LEASE_MS = 2 * 60_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_BATCH = 4;

type Claimed = typeof siteOperations.$inferSelect & { leaseOwner: string };

export function exclusiveSiteOpsLiveHeadProjection(
  target: "global_excluding_cn" | "mainland_cn",
  deploymentId: string,
) {
  return {
    globalLiveDeploymentId:
      target === "global_excluding_cn" ? deploymentId : null,
    mainlandLiveDeploymentId: target === "mainland_cn" ? deploymentId : null,
  } as const;
}

export function domainFinancialTerminalProjection(
  status: "succeeded" | "failed" | "attention_required",
) {
  return {
    status,
    ...(status === "succeeded" || status === "failed"
      ? { activeFinancialKey: null }
      : {}),
  } as const;
}

export function siteOpsWorkerMayClaimStatus(status: string) {
  return status === "queued" || status === "running";
}

export function unexpectedSiteOpsProviderFailure(): SiteOpsProviderResult {
  return failureResult(
    "attention_required",
    "PROVIDER_ERROR",
    "外部服务操作未能安全完成，请根据错误码和任务编号联系处理。",
  );
}

async function claimOne(db: any): Promise<Claimed | null> {
  return db.transaction(async (tx: any) => {
    const now = new Date();
    const rows = await tx
      .select()
      .from(siteOperations)
      .where(
        or(
          eq(siteOperations.status, "queued"),
          and(
            eq(siteOperations.status, "running"),
            or(
              isNull(siteOperations.leaseExpiresAt),
              lt(siteOperations.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(siteOperations.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    const operation = rows[0];
    if (!operation || !siteOpsWorkerMayClaimStatus(operation.status)) {
      return null;
    }
    const leaseOwner = randomUUID();
    await tx
      .update(siteOperations)
      .set({
        status: "running",
        leaseOwner,
        leaseExpiresAt: new Date(now.getTime() + DEFAULT_LEASE_MS),
        attempt: operation.attempt + 1,
        startedAt: operation.startedAt ?? now,
        updatedAt: now,
      })
      .where(
        and(
          eq(siteOperations.id, operation.id),
          eq(siteOperations.status, operation.status),
        ),
      );
    return { ...operation, status: "running", leaseOwner };
  });
}

function failureResult(
  status: "failed" | "attention_required" | "outcome_unknown",
  code: string,
  message: string,
): SiteOpsProviderResult {
  return { status, code, message };
}

async function invokeProvider(operation: Claimed) {
  const handler = getSiteOpsProviderHandler(operation.provider);
  if (!handler) {
    return failureResult(
      "attention_required",
      "PROVIDER_NOT_CONFIGURED",
      `${operation.provider ?? "SiteOps"} 适配器尚未配置；未伪造外部成功结果。`,
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  timeout.unref?.();
  try {
    return await handler({ operation, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      return failureResult(
        "outcome_unknown",
        "PROVIDER_TIMEOUT",
        "外部操作超时，结果未知；系统只会查询对账，不会盲目重发。",
      );
    }
    console.error("[SiteOpsWorker] provider_failed", {
      operationId: operation.id,
      projectId: operation.projectId,
      provider: operation.provider,
      error: runtimeErrorForLog(error),
    });
    return unexpectedSiteOpsProviderFailure();
  } finally {
    clearTimeout(timeout);
  }
}

async function finalize(
  db: any,
  operation: Claimed,
  providerResult: SiteOpsProviderResult,
) {
  await db.transaction(async (tx: any) => {
    const lockedRows = await tx
      .select()
      .from(siteOperations)
      .where(eq(siteOperations.id, operation.id))
      .limit(1)
      .for("update");
    const locked = lockedRows[0];
    if (
      !locked ||
      locked.status !== "running" ||
      locked.leaseOwner !== operation.leaseOwner
    ) {
      return;
    }
    const result = publicSiteOpsProviderResult(locked.provider, providerResult);
    const now = new Date();
    if (result.status === "pending") {
      const nextPollMs = Math.max(
        2_000,
        Math.min(result.nextPollMs ?? 10_000, 5 * 60_000),
      );
      await tx
        .update(siteOperations)
        .set({
          // A running row with a future lease is the existing operation's
          // durable poll schedule. It cannot be mistaken for a new side effect.
          status: "running",
          result: result.result,
          providerOperationId:
            result.providerOperationId ?? locked.providerOperationId,
          providerTaskId: result.providerTaskId ?? locked.providerTaskId,
          leaseOwner: null,
          leaseExpiresAt: new Date(now.getTime() + nextPollMs),
          updatedAt: now,
        })
        .where(
          and(
            eq(siteOperations.id, locked.id),
            eq(siteOperations.leaseOwner, operation.leaseOwner),
          ),
        );
      if (locked.buildId && result.buildStatus) {
        await tx
          .update(siteBuilds)
          .set({ status: result.buildStatus, updatedAt: now })
          .where(eq(siteBuilds.id, locked.buildId));
      }
      if (result.projectStatus) {
        await tx
          .update(siteProjects)
          .set({ status: result.projectStatus, updatedAt: now })
          .where(eq(siteProjects.id, locked.projectId));
      }
      return;
    }
    if (result.status === "outcome_unknown") {
      // A timeout after a provider mutation is not a terminal failure. Keep
      // the original reservation and let the same provider handler enter its
      // read-only reconciliation branch on the next lease; never create a
      // replacement operation or repeat the side effect.
      await tx
        .update(siteOperations)
        .set({
          status: "running",
          result: result.result ?? locked.result,
          providerOperationId:
            result.providerOperationId ?? locked.providerOperationId,
          providerTaskId: result.providerTaskId ?? locked.providerTaskId,
          errorCode: result.code,
          errorMessage: result.message,
          leaseOwner: null,
          leaseExpiresAt: new Date(now.getTime() + 15_000),
          updatedAt: now,
        })
        .where(
          and(
            eq(siteOperations.id, locked.id),
            eq(siteOperations.leaseOwner, operation.leaseOwner),
          ),
        );
      await tx
        .update(siteDomainOperations)
        .set({
          status: "outcome_unknown",
          providerTaskNo: result.providerTaskId ?? locked.providerTaskId,
          providerResult: result.result,
          errorCode: result.code,
          errorMessage: result.message,
          updatedAt: now,
        })
        .where(eq(siteDomainOperations.operationId, locked.id));
      return;
    }
    const terminalStatus = result.status;
    await tx
      .update(siteOperations)
      .set({
        status: terminalStatus,
        result: result.result,
        providerOperationId: result.providerOperationId,
        providerTaskId: result.providerTaskId,
        errorCode: result.status === "succeeded" ? null : result.code,
        errorMessage: result.status === "succeeded" ? null : result.message,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(siteOperations.id, locked.id),
          eq(siteOperations.leaseOwner, operation.leaseOwner),
        ),
      );

    const unsuccessful = result.status !== "succeeded";
    if (locked.buildId) {
      await tx
        .update(siteBuilds)
        .set({
          status: unsuccessful
            ? result.status === "failed"
              ? "failed"
              : "attention_required"
            : result.buildStatus,
          errorCode: unsuccessful ? result.code : null,
          errorMessage: unsuccessful ? result.message : null,
          ...(locked.kind === "build_revision"
            ? { quotaState: siteOpsQuotaStateForProviderResult(result.status) }
            : {}),
          updatedAt: now,
        })
        .where(eq(siteBuilds.id, locked.buildId));
    }
    await tx
      .update(socialPackages)
      .set({
        status: unsuccessful
          ? result.status === "failed"
            ? "failed"
            : "attention_required"
          : (result.socialPackageStatus ?? "ready"),
        errorCode: unsuccessful ? result.code : null,
        errorMessage: unsuccessful ? result.message : null,
        quotaState: siteOpsQuotaStateForProviderResult(result.status),
        updatedAt: now,
      })
      .where(eq(socialPackages.operationId, locked.id));
    if (unsuccessful || result.projectStatus !== "live") {
      await tx
        .update(siteDeployments)
        .set({
          status: unsuccessful
            ? result.status === "failed"
              ? "failed"
              : "attention_required"
            : "verifying",
          errorCode: unsuccessful ? result.code : null,
          errorMessage: unsuccessful ? result.message : null,
          updatedAt: now,
        })
        .where(eq(siteDeployments.operationId, locked.id));
    }
    await tx
      .update(siteDomainOperations)
      .set({
        // Known failure is terminal and releases the financial intent.
        // attention_required retains it so neither staff nor a retry can
        // produce a second charge while the provider outcome is unresolved.
        ...domainFinancialTerminalProjection(result.status),
        providerTaskNo: result.providerTaskId,
        providerResult: result.result,
        errorCode: unsuccessful ? result.code : null,
        errorMessage: unsuccessful ? result.message : null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(siteDomainOperations.operationId, locked.id));

    const projectRows = await tx
      .select()
      .from(siteProjects)
      .where(eq(siteProjects.id, locked.projectId))
      .limit(1)
      .for("update");
    const project = projectRows[0];
    if (!project) return;
    let liveHeadConflict = false;
    if (!unsuccessful && result.projectStatus === "live") {
      const deploymentRows = await tx
        .select()
        .from(siteDeployments)
        .where(eq(siteDeployments.operationId, locked.id))
        .limit(1)
        .for("update");
      const deployment = deploymentRows[0];
      if (!deployment) {
        liveHeadConflict = true;
      } else {
        const currentHead =
          deployment.target === "mainland_cn"
            ? project.mainlandLiveDeploymentId
            : project.globalLiveDeploymentId;
        if ((deployment.expectedHeadDeploymentId ?? null) !== currentHead) {
          liveHeadConflict = true;
          await tx
            .update(siteOperations)
            .set({
              status: "attention_required",
              errorCode: "LIVE_HEAD_CONFLICT",
              errorMessage:
                "线上版本在发布期间发生变化；已部署版本未被切换为 FrontMind live head。",
              updatedAt: now,
            })
            .where(eq(siteOperations.id, locked.id));
          await tx
            .update(siteDeployments)
            .set({
              status: "attention_required",
              errorCode: "LIVE_HEAD_CONFLICT",
              errorMessage:
                "线上版本在发布期间发生变化；已部署版本未被切换为 FrontMind live head。",
              updatedAt: now,
            })
            .where(eq(siteDeployments.id, deployment.id));
        } else {
          const otherHead =
            deployment.target === "mainland_cn"
              ? project.globalLiveDeploymentId
              : project.mainlandLiveDeploymentId;
          if (currentHead) {
            await tx
              .update(siteDeployments)
              .set({ status: "superseded", updatedAt: now })
              .where(
                and(
                  eq(siteDeployments.id, currentHead),
                  eq(siteDeployments.projectId, project.id),
                  eq(siteDeployments.target, deployment.target),
                  eq(siteDeployments.status, "active"),
                ),
              );
          }
          if (otherHead && otherHead !== currentHead) {
            await tx
              .update(siteDeployments)
              .set({ status: "superseded", updatedAt: now })
              .where(
                and(
                  eq(siteDeployments.id, otherHead),
                  eq(siteDeployments.projectId, project.id),
                  eq(siteDeployments.status, "active"),
                ),
              );
          }
          await tx
            .update(siteDeployments)
            .set({
              status: "active",
              errorCode: null,
              errorMessage: null,
              activatedAt: now,
              updatedAt: now,
            })
            .where(eq(siteDeployments.id, deployment.id));
          await tx
            .update(siteProjects)
            .set({
              ...exclusiveSiteOpsLiveHeadProjection(
                deployment.target,
                deployment.id,
              ),
              currentBuildId: deployment.buildId,
              updatedAt: now,
            })
            .where(eq(siteProjects.id, project.id));
        }
      }
    }
    const messageText = liveHeadConflict
      ? "ESA 已返回验证结果，但线上 head 在发布期间发生变化；系统未覆盖较新的线上版本，请人工核对。"
      : result.status === "succeeded"
        ? result.message
        : result.message || "该操作需要人工处理。";
    if (messageText) {
      const sequenceRows = await tx
        .select({ sequence: max(messages.sequence) })
        .from(messages)
        .where(eq(messages.conversationId, project.conversationId));
      await tx.insert(messages).values({
        id: randomUUID(),
        conversationId: project.conversationId,
        userId: project.userId,
        role: "assistant",
        content: messageText,
        sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
        metadata: {
          siteOps: {
            kind:
              unsuccessful || liveHeadConflict
                ? "operation_recovery"
                : locked.kind === "deploy" || locked.kind === "rollback"
                  ? "release_status"
                  : locked.kind === "social_package"
                    ? "social_package"
                    : locked.kind.startsWith("domain_") ||
                        locked.kind.startsWith("dns_")
                      ? "domain_status"
                      : "build_progress",
            subjectId: locked.id,
            revision: project.revision + 1,
            status: unsuccessful || liveHeadConflict ? "active" : "resolved",
            payload: {
              operationKind: locked.kind,
              operationStatus: liveHeadConflict
                ? "attention_required"
                : result.status,
              errorCode: liveHeadConflict
                ? "LIVE_HEAD_CONFLICT"
                : unsuccessful
                  ? result.code
                  : undefined,
            },
          },
        },
      });
    }
    await tx
      .update(siteProjects)
      .set({
        status: liveHeadConflict
          ? "attention_required"
          : unsuccessful
            ? result.status === "failed"
              ? "failed"
              : "attention_required"
            : result.projectStatus,
        revision: project.revision + 1,
        updatedAt: now,
      })
      .where(eq(siteProjects.id, project.id));
  });
}

export async function runSiteOpsWorkerSweep(options?: { max?: number }) {
  const db = await getDb();
  if (!db || process.env.FRONTMIND_SITEOPS_ENABLED?.trim() === "0") {
    return {
      claimed: 0,
      succeeded: 0,
      deferred: 0,
      attentionRequired: 0,
      failed: 0,
    };
  }
  const limit = Math.max(1, Math.min(options?.max ?? DEFAULT_BATCH, 20));
  const summary = {
    claimed: 0,
    succeeded: 0,
    deferred: 0,
    attentionRequired: 0,
    failed: 0,
  };
  for (let index = 0; index < limit; index += 1) {
    const operation = await claimOne(db);
    if (!operation) break;
    summary.claimed += 1;
    const result = await invokeProvider(operation);
    await finalize(db, operation, result);
    if (result.status === "pending") summary.deferred += 1;
    else if (result.status === "succeeded") summary.succeeded += 1;
    else if (result.status === "failed") summary.failed += 1;
    else summary.attentionRequired += 1;
  }
  await finalizePendingTwentyFirstCredentialRevocations().catch((error) => {
    console.error(
      "[SiteOpsWorker] twenty_first_revocation_finalize_failed",
      runtimeErrorForLog(error),
    );
  });
  return summary;
}

let scheduler: NodeJS.Timeout | null = null;
let sweep: Promise<unknown> | null = null;

export function startSiteOpsWorkerScheduler(options?: { intervalMs?: number }) {
  if (scheduler || process.env.FRONTMIND_SITEOPS_ENABLED?.trim() === "0")
    return;
  const run = () => {
    if (sweep) return;
    sweep = runSiteOpsWorkerSweep()
      .catch((error) => {
        console.error(
          "[SiteOpsWorker] sweep_failed",
          runtimeErrorForLog(error),
        );
      })
      .finally(() => {
        sweep = null;
      });
  };
  run();
  scheduler = setInterval(run, Math.max(10_000, options?.intervalMs ?? 30_000));
  scheduler.unref?.();
}

export async function stopSiteOpsWorkerScheduler() {
  if (scheduler) clearInterval(scheduler);
  scheduler = null;
  await sweep;
}
