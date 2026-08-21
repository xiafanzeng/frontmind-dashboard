import { createHash } from "node:crypto";
import { and, eq, inArray, max, ne } from "drizzle-orm";

import {
  messages,
  siteProjects,
  siteProviderConnections,
  workspaceSiteProfiles,
} from "../../drizzle/schema";
import { runtimeErrorForLog } from "../_core/runtime-error-log";
import { getDb } from "../db";

const DAY_MS = 24 * 60 * 60 * 1_000;
const EXPIRY_THRESHOLDS = [60, 30, 15, 7, 3, 1, 0] as const;

export type SiteOpsDomainReminderInput = {
  domain: string | null;
  domainRevision: number;
  expiresAt: Date | null;
  autoRenewDesired: boolean;
  autoRenewObserved: boolean | null;
  dnsStatus: string | null;
  connectionStatus: string | null;
  hasLiveDeployment: boolean;
};

export type SiteOpsDomainReminder = {
  key: string;
  kind: "domain_status" | "operation_recovery";
  content: string;
};

export function siteOpsDomainReminderCandidates(
  input: SiteOpsDomainReminderInput,
  now = new Date(),
): SiteOpsDomainReminder[] {
  const domain = input.domain?.trim().toLowerCase();
  if (!domain) return [];
  const revisionKey = `${domain}:${input.domainRevision}`;
  const reminders: SiteOpsDomainReminder[] = [];
  if (input.expiresAt) {
    const remainingDays = Math.max(
      0,
      Math.ceil((input.expiresAt.getTime() - now.getTime()) / DAY_MS),
    );
    const threshold = [...EXPIRY_THRESHOLDS]
      .reverse()
      .find((candidate) => candidate >= remainingDays);
    if (threshold !== undefined) {
      reminders.push({
        key: `domain-expiry:${revisionKey}:${input.expiresAt.toISOString()}:${threshold}`,
        kind: "domain_status",
        content:
          threshold === 0
            ? `域名 ${domain} 已到期或将在 24 小时内到期。现有站点不会被自动删除，请立即在客户自己的阿里云账号核对续费状态。`
            : `域名 ${domain} 距离到期不超过 ${threshold} 天。请核对客户阿里云账号余额、到期日和续费状态。`,
      });
    }
  }
  if (input.autoRenewDesired && input.autoRenewObserved !== true) {
    reminders.push({
      key: `auto-renew-drift:${revisionKey}:on:${String(input.autoRenewObserved)}`,
      kind: "domain_status",
      content: `域名 ${domain} 期望开启自动续费，但阿里云当前状态尚未确认。系统不会重复发送 SET，请在产品内同步或人工核对。`,
    });
  }
  if (input.connectionStatus === "invalid") {
    reminders.push({
      key: `aliyun-permission-drift:${revisionKey}`,
      kind: "operation_recovery",
      content: `域名 ${domain} 的客户阿里云 RAM Role 权限已失效或发生漂移。现有网站保持在线，请重新验证连接；FrontMind 不会回退收集永久 AccessKey。`,
    });
  }
  if (
    input.hasLiveDeployment &&
    input.dnsStatus &&
    !["active", "pending"].includes(input.dnsStatus)
  ) {
    reminders.push({
      key: `dns-drift:${revisionKey}:${input.dnsStatus}`,
      kind: "operation_recovery",
      content: `域名 ${domain} 的 DNS 状态为 ${input.dnsStatus}。现有 live head 未被覆盖，请核对 FrontMind 管理的精确记录。`,
    });
  }
  return reminders;
}

function reminderMessageId(projectId: string, key: string) {
  return `siteops-reminder:${createHash("sha256")
    .update(`${projectId}:${key}`)
    .digest("hex")}`;
}

export async function runSiteOpsDomainReminderSweep(options?: {
  now?: Date;
  limit?: number;
}) {
  const db = await getDb();
  if (!db || process.env.FRONTMIND_SITEOPS_ENABLED?.trim() === "0") {
    return { inspected: 0, inserted: 0 };
  }
  const now = options?.now ?? new Date();
  const limit = Math.max(1, Math.min(options?.limit ?? 500, 2_000));
  const rows = await db
    .select({
      project: siteProjects,
      profile: workspaceSiteProfiles,
      connectionStatus: siteProviderConnections.status,
    })
    .from(siteProjects)
    .innerJoin(
      workspaceSiteProfiles,
      eq(workspaceSiteProfiles.userId, siteProjects.userId),
    )
    .leftJoin(
      siteProviderConnections,
      and(
        eq(siteProviderConnections.projectId, siteProjects.id),
        eq(siteProviderConnections.provider, "aliyun_cn"),
      ),
    )
    .where(ne(siteProjects.status, "cancelled"))
    .limit(limit);
  let inserted = 0;
  for (const row of rows) {
    const candidates = siteOpsDomainReminderCandidates(
      {
        domain: row.profile.normalizedAsciiDomain ?? row.profile.domain ?? null,
        domainRevision: row.profile.domainRevision,
        expiresAt: row.profile.domainExpiresAt,
        autoRenewDesired: row.profile.autoRenewDesired,
        autoRenewObserved: row.profile.autoRenewObserved,
        dnsStatus: row.profile.dnsStatus,
        connectionStatus: row.connectionStatus ?? null,
        hasLiveDeployment: Boolean(
          row.project.globalLiveDeploymentId ||
            row.project.mainlandLiveDeploymentId,
        ),
      },
      now,
    );
    if (candidates.length === 0) continue;
    inserted += await db.transaction(async (tx: any) => {
      const projectRows = await tx
        .select()
        .from(siteProjects)
        .where(eq(siteProjects.id, row.project.id))
        .limit(1)
        .for("update");
      const project = projectRows[0];
      if (!project || project.status === "cancelled") return 0;
      const candidateIds = candidates.map((candidate) =>
        reminderMessageId(project.id, candidate.key),
      );
      const existingRows = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, project.conversationId),
            inArray(messages.id, candidateIds),
          ),
        );
      const existing = new Set(
        existingRows.map((item: { id: string }) => item.id),
      );
      const pending = candidates.filter(
        (candidate) =>
          !existing.has(reminderMessageId(project.id, candidate.key)),
      );
      if (pending.length === 0) return 0;
      const sequenceRows = await tx
        .select({ sequence: max(messages.sequence) })
        .from(messages)
        .where(eq(messages.conversationId, project.conversationId));
      const baseSequence = Number(sequenceRows[0]?.sequence ?? 0);
      await tx.insert(messages).values(
        pending.map((candidate, index) => ({
          id: reminderMessageId(project.id, candidate.key),
          conversationId: project.conversationId,
          userId: project.userId,
          role: "assistant" as const,
          content: candidate.content,
          sequence: baseSequence + index + 1,
          metadata: {
            siteOps: {
              kind: candidate.kind,
              subjectId: project.id,
              revision: project.revision + 1,
              status: "active",
              payload: { reminderKey: candidate.key },
            },
          },
        })),
      );
      await tx
        .update(siteProjects)
        .set({ revision: project.revision + 1, updatedAt: now })
        .where(
          and(
            eq(siteProjects.id, project.id),
            eq(siteProjects.revision, project.revision),
          ),
        );
      return pending.length;
    });
  }
  return { inspected: rows.length, inserted };
}

let scheduler: NodeJS.Timeout | null = null;
let running: Promise<unknown> | null = null;

export function startSiteOpsDomainReminderScheduler(options?: {
  intervalMs?: number;
  initialDelayMs?: number;
}) {
  if (scheduler || process.env.FRONTMIND_SITEOPS_ENABLED?.trim() === "0")
    return;
  const run = () => {
    if (running) return;
    running = runSiteOpsDomainReminderSweep()
      .catch((error) =>
        console.error(
          "[SiteOpsDomainReminder] sweep_failed",
          runtimeErrorForLog(error),
        ),
      )
      .finally(() => {
        running = null;
      });
  };
  const initial = setTimeout(run, options?.initialDelayMs ?? 2 * 60_000);
  initial.unref?.();
  scheduler = setInterval(
    run,
    Math.max(DAY_MS / 4, options?.intervalMs ?? DAY_MS),
  );
  scheduler.unref?.();
}
