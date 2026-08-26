DELETE FROM `site_dns_records`;--> statement-breakpoint
DELETE FROM `site_domain_operations`;--> statement-breakpoint
DELETE FROM `site_operations`
WHERE `kind` IN ('domain_search','domain_purchase','domain_renewal','domain_auto_renew')
   OR `provider` IN ('aliyun_domain','aliyun_alidns')
   OR (`provider` = 'aliyun_esa' AND `kind` IN ('dns_apply','dns_rollback'))
   OR JSON_UNQUOTE(JSON_EXTRACT(`input`, '$.resumeMode')) = 'recover_design_output';--> statement-breakpoint
UPDATE `messages`
SET `deletedAt` = NOW()
WHERE `deletedAt` IS NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$.siteOps.kind')) IN ('domain_quote','domain_status','operation_recovery');--> statement-breakpoint
DELETE FROM `site_provider_connections`;--> statement-breakpoint
UPDATE `workspace_site_profiles`
SET
	`domain` = NULL,
	`normalizedAsciiDomain` = NULL,
	`unicodeDisplayDomain` = NULL,
	`domainRevision` = `domainRevision` + 1,
	`providerAccountUid` = NULL,
	`domainOwnershipStatus` = NULL,
	`dnsStatus` = NULL,
	`icpDomainRevision` = NULL,
	`siteMode` = 'unknown',
	`domainStatus` = 'not_started',
	`domainVerifiedAt` = NULL,
	`icpProvince` = NULL,
	`icpNumber` = NULL,
	`icpStatus` = 'not_submitted',
	`icpVerifiedAt` = NULL,
	`revision` = `revision` + 1;--> statement-breakpoint
UPDATE `site_projects`
SET
	`canonical_hostname` = NULL,
	`global_live_deployment_id` = NULL,
	`mainland_live_deployment_id` = NULL,
	`revision` = `revision` + 1;--> statement-breakpoint
DELETE FROM `presales_api_credentials`
WHERE `slot` = 'siteops_aliyun_broker';--> statement-breakpoint
ALTER TABLE `site_dns_records` DROP FOREIGN KEY `site_dns_domain_operation_fk`;--> statement-breakpoint
ALTER TABLE `site_dns_records` DROP COLUMN `domain_operation_id`;--> statement-breakpoint
DROP TABLE `site_domain_operations`;--> statement-breakpoint
DROP TABLE `site_provider_connections`;--> statement-breakpoint
ALTER TABLE `site_operations` MODIFY COLUMN `kind` enum('brief_message','visual_search','site_build','build_revision','deploy','rollback','social_package','domain_sync','dns_apply','dns_rollback') NOT NULL;--> statement-breakpoint
ALTER TABLE `site_projects` ADD `current_task_started_at` timestamp NULL;--> statement-breakpoint
ALTER TABLE `site_projects` ADD `minimum_knowledge_snapshot_version` int unsigned;--> statement-breakpoint
UPDATE `site_projects`
SET `current_task_started_at` = `created_at`
WHERE `current_task_started_at` IS NULL;--> statement-breakpoint
UPDATE `site_projects` AS `project`
INNER JOIN (
	SELECT
		`reset_fact`.`project_id`,
		MAX(`reset_fact`.`reset_at`) AS `reset_at`,
		MAX(`reset_fact`.`minimum_snapshot_version`) AS `minimum_snapshot_version`
	FROM (
		SELECT
			JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(`internalNote`) THEN `internalNote` ELSE NULL END, '$.projectId')) AS `project_id`,
			STR_TO_DATE(JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(`internalNote`) THEN `internalNote` ELSE NULL END, '$.resetAppliedAt')), '%Y-%m-%dT%H:%i:%s.%fZ') AS `reset_at`,
			CAST(JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(`internalNote`) THEN `internalNote` ELSE NULL END, '$.minimumKnowledgeSnapshotVersion')) AS UNSIGNED) AS `minimum_snapshot_version`
		FROM `delivery_tickets`
		WHERE `operation` = 'site_rebuild'
		  AND `status` = 'completed'
		  AND JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(`internalNote`) THEN `internalNote` ELSE NULL END, '$.schemaVersion')) = '4'
		  AND JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(`internalNote`) THEN `internalNote` ELSE NULL END, '$.kind')) = 'frontmind.siteops-rebuild.v1'
		  AND JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(`internalNote`) THEN `internalNote` ELSE NULL END, '$.resetIntent')) = 'approved_reset_unpublish'
		  AND JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(`internalNote`) THEN `internalNote` ELSE NULL END, '$.freshRootApplied')) = 'true'
		  AND JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(`internalNote`) THEN `internalNote` ELSE NULL END, '$.unpublishOperationId')) = JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(`internalNote`) THEN `internalNote` ELSE NULL END, '$.resetOperationId'))
		UNION ALL
		SELECT
			JSON_UNQUOTE(JSON_EXTRACT(`result`, '$.projectId')) AS `project_id`,
			COALESCE(`completed_at`, `updated_at`) AS `reset_at`,
			CAST(JSON_UNQUOTE(JSON_EXTRACT(`result`, '$.minimumKnowledgeSnapshotVersion')) AS UNSIGNED) AS `minimum_snapshot_version`
		FROM `site_operations`
		WHERE `status` = 'succeeded'
		  AND `kind` = 'rollback'
		  AND `provider` = 'aliyun_esa'
		  AND JSON_UNQUOTE(JSON_EXTRACT(`result`, '$.schemaVersion')) = '2'
		  AND JSON_UNQUOTE(JSON_EXTRACT(`result`, '$.intent')) = 'approved_reset_unpublish'
		  AND JSON_UNQUOTE(JSON_EXTRACT(`result`, '$.stage')) = 'exposure_removed'
		  AND JSON_UNQUOTE(JSON_EXTRACT(`result`, '$.freshRootApplied')) = 'true'
		  AND JSON_UNQUOTE(JSON_EXTRACT(`result`, '$.resetOperationId')) = `id`
	) AS `reset_fact`
	WHERE `reset_fact`.`reset_at` IS NOT NULL
	  AND `reset_fact`.`minimum_snapshot_version` >= 1
	GROUP BY `reset_fact`.`project_id`
) AS `migrated_reset`
	ON `migrated_reset`.`project_id` = `project`.`id`
SET
	`project`.`current_task_started_at` = GREATEST(`project`.`current_task_started_at`, `migrated_reset`.`reset_at`),
	`project`.`minimum_knowledge_snapshot_version` = GREATEST(COALESCE(`project`.`minimum_knowledge_snapshot_version`, 0), `migrated_reset`.`minimum_snapshot_version`);--> statement-breakpoint
ALTER TABLE `site_projects` MODIFY COLUMN `current_task_started_at` timestamp NOT NULL DEFAULT (now());--> statement-breakpoint
CREATE TABLE `site_provider_connections` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`provider` enum('aliyun_cn') NOT NULL,
	`account_uid` varchar(128) NOT NULL,
	`oauth_credential_id` varchar(36) NOT NULL,
	`encryption_version` int NOT NULL DEFAULT 1,
	`encrypted_refresh_token` text NOT NULL,
	`encryption_iv` varchar(32) NOT NULL,
	`encryption_auth_tag` varchar(32) NOT NULL,
	`capabilities` json NOT NULL DEFAULT ('[]'),
	`status` enum('active','invalid','revoked') NOT NULL DEFAULT 'active',
	`verified_at` timestamp,
	`last_error_code` varchar(128),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_provider_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_provider_connections_project_provider_uq` UNIQUE(`project_id`,`provider`)
);--> statement-breakpoint
ALTER TABLE `site_provider_connections` ADD CONSTRAINT `site_provider_connections_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_provider_connections` ADD CONSTRAINT `site_provider_connections_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_provider_connections` ADD CONSTRAINT `site_provider_connections_oauth_credential_fk` FOREIGN KEY (`oauth_credential_id`) REFERENCES `presales_api_credentials`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `site_provider_connections_account_idx` ON `site_provider_connections` (`account_uid`);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` DROP COLUMN `registrar`;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` DROP COLUMN `domainInstanceId`;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` DROP COLUMN `domainExpiresAt`;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` DROP COLUMN `domainRealNameStatus`;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` DROP COLUMN `domainEmailStatus`;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` DROP COLUMN `domainClientHold`;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` DROP COLUMN `autoRenewDesired`;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` DROP COLUMN `autoRenewObserved`;
