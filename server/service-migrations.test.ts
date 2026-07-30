import { readFile } from "node:fs/promises";
import path from "node:path";

import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";

import {
  websitePaymentReceipts,
  websiteProjectOrders,
} from "../drizzle/schema";

const drizzleRoot = path.resolve(process.cwd(), "drizzle");

async function migration(name: string) {
  return readFile(path.join(drizzleRoot, name), "utf8");
}

describe("service portal migration chain", () => {
  it("keeps a complete Drizzle snapshot chain for every registered migration", async () => {
    const journal = JSON.parse(
      await readFile(path.join(drizzleRoot, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };

    let previousId: string | undefined;
    const ids = new Set<string>();
    for (const entry of journal.entries) {
      const snapshot = JSON.parse(
        await readFile(
          path.join(
            drizzleRoot,
            "meta",
            `${String(entry.idx).padStart(4, "0")}_snapshot.json`,
          ),
          "utf8",
        ),
      ) as {
        id: string;
        prevId: string;
        version: string;
        dialect: string;
      };

      expect(snapshot.version).toBe("5");
      expect(snapshot.dialect).toBe("mysql");
      expect(ids.has(snapshot.id)).toBe(false);
      if (previousId) {
        expect(snapshot.prevId).toBe(previousId);
      }
      ids.add(snapshot.id);
      previousId = snapshot.id;
    }
  });

  it("registers every service migration in executable order", async () => {
    const journal = JSON.parse(
      await readFile(path.join(drizzleRoot, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(
      journal.entries
        .filter((entry) => entry.idx >= 15)
        .map((entry) => entry.tag),
    ).toEqual([
      "0015_service_portal",
      "0016_backfill_website_basic",
      "0017_contract_commercial_evidence",
      "0018_backfill_contract_commercial_evidence",
      "0019_scheduled_replacement_linkage",
      "0020_busy_zemo",
      "0021_flawless_husk",
      "0022_manual_service_orders",
      "0023_wide_turbo",
      "0024_condemned_oracle",
      "0025_admin_control_plane",
      "0026_workspace_content_revisions",
      "0027_delivery_tickets",
      "0028_production_delivery_workflows",
      "0029_dashboard_import_preflights",
      "0030_response_logic_record_revisions",
      "0031_payment_receipt_ledger",
      "0032_project_order_registry",
      "0033_huge_toxin",
      "0034_known_scarlet_spider",
      "0035_nervous_sauron",
      "0036_account-market-edition",
      "0037_remove-knowledge-plan",
      "0038_fine_loners",
      "0039_delivery_roles_and_knowledge_reset",
      "0040_flaky_the_executioner",
      "0041_lovely_harry_osborn",
      "0042_heavy_xorn",
      "0043_clumsy_lilandra",
    ]);
  });

  it("drops the delivery-role foreign keys by their executable migration names", async () => {
    const previousMigration = await migration(
      "0039_delivery_roles_and_knowledge_reset.sql",
    );
    const projectTeamMigration = await migration(
      "0040_flaky_the_executioner.sql",
    );

    for (const foreignKeyName of [
      "delivery_tickets_assigned_role_fk",
      "knowledge_base_reset_requests_role_fk",
    ]) {
      expect(previousMigration).toContain(`CONSTRAINT \`${foreignKeyName}\``);
      expect(projectTeamMigration).toContain(
        `DROP FOREIGN KEY \`${foreignKeyName}\``,
      );
    }
  });

  it("updates the reset-request member foreign key by its executable name", async () => {
    const originalResetMigration = await migration(
      "0039_delivery_roles_and_knowledge_reset.sql",
    );
    const projectIsolationMigration = await migration("0042_heavy_xorn.sql");

    expect(originalResetMigration).toContain(
      "CONSTRAINT `knowledge_base_reset_requests_member_fk`",
    );
    expect(projectIsolationMigration).toContain(
      "DROP FOREIGN KEY `knowledge_base_reset_requests_member_fk`",
    );
  });

  it("cascades project-owned conversations and resources with the customer project", async () => {
    const migrationSql = await migration("0042_heavy_xorn.sql");
    for (const foreignKeyName of [
      "conversations_project_assignment_fk",
      "upstream_resources_project_assignment_fk",
    ]) {
      expect(migrationSql).toMatch(
        new RegExp(
          `CONSTRAINT \`${foreignKeyName}\`[^;]*ON DELETE cascade ON UPDATE no action`,
        ),
      );
    }
    expect(
      migrationSql.match(/ON DELETE cascade ON UPDATE no action/g),
    ).toHaveLength(2);
  });

  it("keeps role slots nullable while preserving project ownership boundaries", async () => {
    const projectIsolationMigration = await migration("0042_heavy_xorn.sql");
    const snapshot = JSON.parse(
      await readFile(
        path.join(drizzleRoot, "meta", "0042_snapshot.json"),
        "utf8",
      ),
    ) as {
      tables: Record<
        string,
        {
          columns: Record<string, { notNull: boolean; type: string }>;
          foreignKeys: Record<
            string,
            {
              columnsFrom: string[];
              tableTo: string;
              onDelete?: string;
            }
          >;
        }
      >;
    };

    for (const statement of [
      "MODIFY COLUMN `engineerUserId` int;",
      "MODIFY COLUMN `assignedProjectAssignmentId` varchar(36);",
      "MODIFY COLUMN `assignedMemberId` int;",
      "ALTER TABLE `conversations` ADD `projectAssignmentId` varchar(36);",
      "ALTER TABLE `upstream_resources` ADD `projectAssignmentId` varchar(36);",
    ]) {
      expect(projectIsolationMigration).toContain(statement);
    }
    for (const foreignKeyName of [
      "delivery_project_assignments_engineerUserId_users_id_fk",
      "knowledge_base_reset_requests_assignedMemberId_users_id_fk",
      "kb_reset_project_assignment_fk",
    ]) {
      expect(projectIsolationMigration).toMatch(
        new RegExp(`CONSTRAINT \`${foreignKeyName}\`[^;]*ON DELETE set null`),
      );
    }

    expect(
      snapshot.tables.delivery_project_assignments.columns.engineerUserId,
    ).toMatchObject({ type: "int", notNull: false });
    expect(
      snapshot.tables.knowledge_base_reset_requests.columns
        .assignedProjectAssignmentId,
    ).toMatchObject({ type: "varchar(36)", notNull: false });
    expect(
      snapshot.tables.knowledge_base_reset_requests.columns.assignedMemberId,
    ).toMatchObject({ type: "int", notNull: false });
    expect(
      snapshot.tables.conversations.columns.projectAssignmentId,
    ).toMatchObject({ type: "varchar(36)", notNull: false });
    expect(
      snapshot.tables.upstream_resources.columns.projectAssignmentId,
    ).toMatchObject({ type: "varchar(36)", notNull: false });

    for (const [tableName, foreignKeyName] of [
      [
        "delivery_project_assignments",
        "delivery_project_assignments_engineerUserId_users_id_fk",
      ],
      [
        "knowledge_base_reset_requests",
        "knowledge_base_reset_requests_assignedMemberId_users_id_fk",
      ],
      ["knowledge_base_reset_requests", "kb_reset_project_assignment_fk"],
    ] as const) {
      expect(
        snapshot.tables[tableName].foreignKeys[foreignKeyName],
      ).toMatchObject({ onDelete: "set null" });
    }
    for (const [tableName, foreignKeyName] of [
      ["conversations", "conversations_project_assignment_fk"],
      ["upstream_resources", "upstream_resources_project_assignment_fk"],
    ] as const) {
      expect(
        snapshot.tables[tableName].foreignKeys[foreignKeyName],
      ).toMatchObject({ onDelete: "cascade" });
    }
  });

  it("merges delivery roles and removes protected ICP storage", async () => {
    const migrationSql = await migration("0043_clumsy_lilandra.sql");
    const snapshot = JSON.parse(
      await readFile(
        path.join(drizzleRoot, "meta", "0043_snapshot.json"),
        "utf8",
      ),
    ) as {
      tables: Record<
        string,
        {
          columns: Record<string, { type: string }>;
          foreignKeys: Record<string, unknown>;
          indexes: Record<string, unknown>;
        }
      >;
    };

    expect(migrationSql).toContain(
      "CONSTRAINT `_frontmind_three_roles_preflight_empty`",
    );
    expect(migrationSql).toContain(
      "CONSTRAINT `_frontmind_icp_purge_preflight_empty`",
    );
    expect(migrationSql).toContain(
      "SET `workflowDomain` = 'ai_operations_engineer'",
    );
    expect(migrationSql).toContain(
      "DROP FOREIGN KEY `ticket_attachments_protected_material_fk`",
    );
    expect(migrationSql).toContain("DROP TABLE `icp_sensitive_materials`");

    expect(snapshot.tables).not.toHaveProperty("icp_sensitive_materials");
    expect(
      snapshot.tables.delivery_ticket_attachments.columns,
    ).not.toHaveProperty("protectedMaterialId");
    expect(
      snapshot.tables.delivery_ticket_attachments.columns,
    ).not.toHaveProperty("sensitivity");
    expect(snapshot.tables.users.columns.engineerRoleType.type).toBe(
      "enum('ai_operations_engineer','monitoring_optimization_engineer','content_distribution_engineer')",
    );
    expect(
      snapshot.tables.delivery_project_assignments.columns.roleType.type,
    ).toBe(
      "enum('ai_operations_engineer','monitoring_optimization_engineer','content_distribution_engineer')",
    );
  });

  it("keeps journal indexes and migration timestamps strictly increasing", async () => {
    const journal = JSON.parse(
      await readFile(path.join(drizzleRoot, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };

    for (const [position, entry] of journal.entries.entries()) {
      expect(entry.idx, entry.tag).toBe(position);
      if (position === 0) continue;
      const previous = journal.entries[position - 1];
      expect(entry.idx, `${previous.tag} -> ${entry.tag}`).toBeGreaterThan(
        previous.idx,
      );
      expect(entry.when, `${previous.tag} -> ${entry.tag}`).toBeGreaterThan(
        previous.when,
      );
    }
  });

  it("keeps every MySQL constraint and index identifier within 64 bytes", async () => {
    const journal = JSON.parse(
      await readFile(path.join(drizzleRoot, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };

    for (const entry of journal.entries) {
      const sql = await migration(`${entry.tag}.sql`);
      for (const match of sql.matchAll(
        /(?:CONSTRAINT|INDEX|TABLE|TRIGGER)\s+(?:IF NOT EXISTS\s+)?`([^`]+)`/g,
      )) {
        expect(
          Buffer.byteLength(match[1], "utf8"),
          `${entry.tag}: ${match[1]}`,
        ).toBeLessThanOrEqual(64);
      }
    }
  });

  it("keeps automatic timestamp precision aligned for MySQL 8.4", async () => {
    const journal = JSON.parse(
      await readFile(path.join(drizzleRoot, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string }> };

    for (const entry of journal.entries) {
      const migrationSql = await migration(`${entry.tag}.sql`);
      for (const definition of migrationSql.matchAll(
        /`([^`]+)`\s+(?:timestamp|datetime)\((\d)\)[^\n]*/gi,
      )) {
        const [, columnName, precision] = definition;
        for (const automaticValue of definition[0].matchAll(
          /\b(?:CURRENT_TIMESTAMP|LOCALTIMESTAMP|LOCALTIME|NOW)\s*(?:\(\s*(\d*)\s*\))?/gi,
        )) {
          expect(
            automaticValue[1],
            `${entry.tag}.${columnName}: ${definition[0]}`,
          ).toBe(precision);
        }
      }
    }
  });

  it("keeps the fractional defaults and snapshots aligned with the schema", async () => {
    const dialect = new MySqlDialect();
    for (const column of [
      websitePaymentReceipts.createdAt,
      websiteProjectOrders.createdAt,
      websiteProjectOrders.updatedAt,
    ]) {
      expect(column.getSQLType()).toBe("timestamp(3)");
      expect(dialect.sqlToQuery(column.default!).sql).toBe(
        "CURRENT_TIMESTAMP(3)",
      );
    }
    expect(websiteProjectOrders.updatedAt.hasOnUpdateNow).toBe(true);

    for (const index of [31, 32, 33, 34]) {
      const snapshot = JSON.parse(
        await readFile(
          path.join(
            drizzleRoot,
            "meta",
            `${String(index).padStart(4, "0")}_snapshot.json`,
          ),
          "utf8",
        ),
      ) as {
        tables: Record<
          string,
          {
            columns: Record<
              string,
              { type: string; default?: string; onUpdate?: boolean }
            >;
          }
        >;
      };
      expect(
        snapshot.tables.website_payment_receipts.columns.createdAt,
      ).toMatchObject({
        type: "timestamp(3)",
        default: "CURRENT_TIMESTAMP(3)",
      });
      if (index >= 32) {
        expect(
          snapshot.tables.website_project_orders.columns.createdAt,
        ).toMatchObject({
          type: "timestamp(3)",
          default: "CURRENT_TIMESTAMP(3)",
        });
        expect(
          snapshot.tables.website_project_orders.columns.updatedAt,
        ).toMatchObject({
          type: "timestamp(3)",
          default: "CURRENT_TIMESTAMP(3)",
          onUpdate: true,
        });
      }
    }
  });

  it("creates period-bound delivery tickets with durable quota ordering", async () => {
    const servicePortal = await migration("0015_service_portal.sql");
    const tickets = await migration("0027_delivery_tickets.sql");
    expect(servicePortal).toMatch(
      /CREATE TABLE `service_quota_periods`[\s\S]*`revision` int unsigned NOT NULL DEFAULT 1/,
    );
    expect(tickets).toContain(
      "ALTER TABLE `service_quota_periods` ADD `contentAssetPublishLimit` int unsigned NOT NULL DEFAULT 0",
    );
    expect(tickets).toContain(
      "ALTER TABLE `service_quota_periods` ADD `websiteContentPublishLimit` int unsigned NOT NULL DEFAULT 0",
    );
    expect(tickets).toContain("CREATE TABLE `delivery_tickets`");
    expect(tickets).toContain(
      "CONSTRAINT `delivery_tickets_period_pool_ordinal_uq` UNIQUE(`quotaPeriodId`,`quotaPool`,`ordinal`)",
    );
    expect(tickets).toContain(
      "CREATE UNIQUE INDEX `delivery_redirect_previews_user_hash_uq` ON `delivery_redirect_previews` (`userId`,`fileHash`)",
    );
    expect(tickets).toContain(
      "CREATE INDEX `delivery_tickets_user_updated_id_idx` ON `delivery_tickets` (`userId`,`updatedAt`,`id`)",
    );
    expect(tickets).toContain(
      "CREATE INDEX `delivery_tickets_type_status_updated_id_idx` ON `delivery_tickets` (`type`,`status`,`updatedAt`,`id`)",
    );
    expect(tickets).toContain("'content_asset','website_operation'");
    expect(tickets).toContain(
      "'submitted','needs_information','scheduled','in_progress','completed','rejected','cancelled'",
    );
    for (const column of [
      "contractId",
      "quotaPeriodId",
      "materialUrls",
      "quotaState",
      "contentAssetPublishLimit",
      "websiteContentPublishLimit",
      "technicalDedupeKey",
      "operationResult",
      "purpose",
      "authorization",
      "copyrightNote",
      "revision",
    ]) {
      expect(tickets).toContain(`\`${column}\``);
    }
    for (const table of [
      "delivery_ticket_events",
      "delivery_ticket_attachments",
      "workspace_site_profiles",
      "workspace_site_checks",
      "delivery_redirect_previews",
    ]) {
      expect(tickets).toContain(`CREATE TABLE \`${table}\``);
    }
  });

  it("adds protected ICP materials, public delivery fields, and per-key usage snapshots", async () => {
    const productionWorkflows = await migration(
      "0028_production_delivery_workflows.sql",
    );
    for (const column of [
      "preferredMedia",
      "icpProvince",
      "publicSummary",
      "deliveryLinks",
      "protectedMaterialId",
      "sensitivity",
      "domainStatus",
      "domainVerifiedAt",
      "icpVerifiedAt",
    ]) {
      expect(productionWorkflows).toContain(`\`${column}\``);
    }
    for (const table of [
      "icp_sensitive_materials",
      "api_usage_policies",
      "api_usage_snapshots",
    ]) {
      expect(productionWorkflows).toContain(`CREATE TABLE \`${table}\``);
    }
    expect(productionWorkflows).toContain(
      "`category` enum('business_license','subject_responsible_person_id','website_responsible_person_id'",
    );
    expect(productionWorkflows).toContain(
      "`scope` enum('website_frontend','managed_user')",
    );
    expect(productionWorkflows).toContain(
      "`limit` int unsigned NOT NULL DEFAULT 230000",
    );
    expect(productionWorkflows).toContain(
      "`warningRatioBasisPoints` int unsigned NOT NULL DEFAULT 8000",
    );

    const monthlyUsageAndBasicQuota = await migration("0033_huge_toxin.sql");
    expect(monthlyUsageAndBasicQuota).toContain(
      "ALTER TABLE `api_usage_snapshots` ADD `accountUsed`",
    );
    expect(monthlyUsageAndBasicQuota).toContain(
      "`period`.`contentAssetPublishLimit` = 1",
    );
    expect(monthlyUsageAndBasicQuota).toContain("'pending_confirmation'");
    expect(monthlyUsageAndBasicQuota).toContain("'suspended'");

    const usageOwner = await migration("0034_known_scarlet_spider.sql");
    expect(usageOwner).toContain("CREATE TABLE `user_usage_owners`");
    expect(usageOwner).toContain(
      "HAVING COUNT(DISTINCT `assignment`.`adminId`) = 1",
    );
    expect(usageOwner).toContain("`credential`.`status` = 'retired'");
  });

  it("adds a password-safe customer account stage after verified payment", async () => {
    const accountSetup = await migration("0023_wide_turbo.sql");
    expect(accountSetup).toContain(
      "'payment_required','account_setup_required','activation_required'",
    );
    for (const column of [
      "accountSetupIdempotencyKeyHash",
      "accountSetupRequestHash",
      "requestedPasswordHash",
      "accountSetupAt",
    ]) {
      expect(accountSetup).toContain(`\`${column}\``);
    }
    expect(accountSetup).not.toMatch(/password(?!Hash)/i);
  });

  it("creates the durable signing-first website order boundary", async () => {
    const manualOrders = await migration("0022_manual_service_orders.sql");
    expect(manualOrders).toContain(
      "CREATE TABLE `website_manual_service_orders`",
    );
    for (const column of [
      "externalContractId",
      "signingUrl",
      "signedPdfFileId",
      "signedPdfSha256",
      "paymentOrderId",
      "paymentTradeNo",
      "provisioningReference",
      "status",
    ]) {
      expect(manualOrders).toContain(`\`${column}\``);
    }
    expect(manualOrders).toContain(
      "'pending_admin','signature_required','payment_required','activation_required','active','rejected','failed'",
    );
  });

  it("adds every post-0015 service column before runtime can select it", async () => {
    const commercial = await migration("0017_contract_commercial_evidence.sql");
    for (const column of [
      "amountFen",
      "currency",
      "prepaidMonths",
      "orderReference",
      "externalContractReference",
      "signedAt",
      "signatoryId",
      "signingEvidence",
      "sourceQuestionId",
    ]) {
      expect(commercial).toContain(`ADD \`${column}\``);
    }
    expect(await migration("0019_scheduled_replacement_linkage.sql")).toContain(
      "ADD `replacesContractIds`",
    );
    expect(await migration("0020_busy_zemo.sql")).toContain(
      "ADD `enterpriseIdentityBoundAt`",
    );
    const versionedService = await migration("0021_flawless_husk.sql");
    expect(versionedService).toContain(
      "CREATE TABLE `service_progress_reports`",
    );
    expect(versionedService).toContain(
      "CREATE TABLE `user_password_setup_tokens`",
    );
    expect(versionedService).toContain(
      "ALTER TABLE `monitoring_batches` ADD `quotaPeriodId`",
    );
    expect(versionedService).toContain(
      "ALTER TABLE `workspace_questions` ADD `intentConfirmedRevision`",
    );
    expect(versionedService).not.toMatch(
      /UPDATE\s+`workspace_questions`[\s\S]*intentConfirmed/i,
    );
  });

  it("adds administrator-confirmed question selection and backfills history", async () => {
    const approval = await migration("0024_condemned_oracle.sql");
    for (const column of [
      "selectionApprovalStatus",
      "selectionRequestedAt",
      "selectionRequestedByUserId",
      "selectionApprovedAt",
      "selectionApprovedByUserId",
    ]) {
      expect(approval).toContain(`\`${column}\``);
    }
    expect(approval).toContain("WHERE `status` = 'selected'");
    expect(approval).toContain("`selectionApprovalStatus` = 'approved'");
    expect(approval).toContain("COALESCE(`selectedAt`, `createdAt`)");
    expect(approval).toContain("`locked` = true");
  });

  it("backfills commercial evidence only from completed website provisions", async () => {
    const backfill = await migration(
      "0018_backfill_contract_commercial_evidence.sql",
    );
    expect(backfill).toContain("contract.`source` = 'website'");
    expect(backfill).toContain("provision.`status` = 'completed'");
    expect(backfill).toContain("provision.`userId` IS NOT NULL");
    expect(backfill).toContain("contract.`signingEvidence`");
  });

  it("adds durable one-time dashboard import preflight nonces", async () => {
    const preflights = await migration("0029_dashboard_import_preflights.sql");
    expect(preflights).toContain("CREATE TABLE `dashboard_import_preflights`");
    for (const column of [
      "actorUserId",
      "workspaceUserId",
      "module",
      "dashboardRevision",
      "fileHash",
      "sectionId",
      "targetBatchKey",
      "expiresAt",
      "consumedAt",
    ]) {
      expect(preflights).toContain(`\`${column}\``);
    }
    expect(preflights).toContain(
      "dashboard_import_preflights_consumed_expires_idx",
    );
  });

  it("adds an optimistic revision to every response-logic record", async () => {
    const revisions = await migration(
      "0030_response_logic_record_revisions.sql",
    );
    expect(revisions).toContain(
      "ALTER TABLE `response_logic_entries` ADD `revision`",
    );
    expect(revisions).toContain("DEFAULT 1 NOT NULL");
  });

  it("creates an append-only hash-bound payment receipt ledger", async () => {
    const receipts = await migration("0031_payment_receipt_ledger.sql");
    expect(receipts).toContain("CREATE TABLE `website_payment_receipts`");
    for (const column of [
      "schemaVersion",
      "orderId",
      "tradeNo",
      "amountFen",
      "paidAt",
      "purchaseType",
      "scopeHash",
      "authorizationDigest",
      "reviewRequired",
    ]) {
      expect(receipts).toContain(`\`${column}\``);
    }
    expect(receipts).toContain(
      "CONSTRAINT `website_payment_receipts_orderId` PRIMARY KEY(`orderId`)",
    );
    expect(receipts).toContain(
      "CONSTRAINT `website_payment_receipts_tradeNo_unique` UNIQUE(`tradeNo`)",
    );
    expect(receipts).toContain(
      "`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)",
    );
    expect(receipts).toContain("`tradeNo` varchar(128) NOT NULL");
    expect(receipts).toContain(
      "`purchaseType` enum('monitoring','service') NOT NULL",
    );
    expect(receipts).toMatch(
      /website_payment_receipts_amount_ck` CHECK\([^)]*`amountFen` > 0 AND [^)]*`amountFen` <= 10000000\)/,
    );
    expect(receipts).toContain(
      "CREATE TRIGGER `website_payment_receipts_no_update`",
    );
    expect(receipts).toContain(
      "CREATE TRIGGER `website_payment_receipts_no_delete`",
    );
    expect(receipts).not.toMatch(/ON UPDATE CURRENT_TIMESTAMP/i);
    expect(receipts).not.toMatch(
      /`(?:token|session|userId|companyName|question|content)`/i,
    );
  });

  it("creates a durable project-order deletion registry", async () => {
    const orders = await migration("0032_project_order_registry.sql");
    expect(orders).toContain("CREATE TABLE `website_project_orders`");
    for (const column of [
      "orderId",
      "schemaVersion",
      "projectId",
      "purchaseType",
      "amountFen",
      "authorizationDigest",
      "state",
      "checkoutExpiresAt",
      "paidAt",
      "fulfilledAt",
      "lastEventAt",
      "revision",
    ]) {
      expect(orders).toContain(`\`${column}\``);
    }
    expect(orders).toContain(
      "`state` enum('pending','paid','fulfilling','fulfilled','review_required','terminal_failed','closed') NOT NULL",
    );
    expect(orders).toContain(
      "CONSTRAINT `website_project_orders_authorizationDigest_unique` UNIQUE(`authorizationDigest`)",
    );
    expect(orders).toContain(
      "`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)",
    );
    expect(orders).toContain(
      "`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)",
    );
    expect(orders).toContain(
      "CREATE INDEX `website_project_orders_project_state_idx`",
    );
    expect(orders).not.toMatch(
      /`(?:authorizationToken|ownerSessionId|companyName)`/i,
    );
    expect(orders).toContain(
      "CONSTRAINT `website_project_orders_paid_state_ck`",
    );
    expect(orders).toContain(
      "CONSTRAINT `website_project_orders_fulfilled_state_ck`",
    );
    expect(orders).toContain(
      "CONSTRAINT `website_project_orders_fulfilled_time_ck`",
    );
  });
});
