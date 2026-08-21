CREATE TABLE `site_builds` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`knowledge_snapshot_id` varchar(36) NOT NULL,
	`knowledge_archive_hash` varchar(64) NOT NULL,
	`parent_build_id` varchar(36),
	`quota_period_id` varchar(36),
	`quota_state` enum('reserved','consumed','released'),
	`ordinal` int unsigned NOT NULL,
	`workflow_upstream_version` varchar(32) NOT NULL,
	`workflow_upstream_hash` varchar(64) NOT NULL,
	`workflow_version` varchar(32) NOT NULL,
	`workflow_package_hash` varchar(64),
	`starter_version` varchar(32) NOT NULL,
	`twenty_first_credential_id` varchar(36),
	`twenty_first_credential_version` int unsigned,
	`style_sample_id` varchar(36),
	`style_revision` int unsigned,
	`brief` json NOT NULL,
	`selection_hash` varchar(64),
	`contract_local_asset_id` varchar(36),
	`contract_hash` varchar(64),
	`source_local_asset_id` varchar(36),
	`source_hash` varchar(64),
	`dist_local_asset_id` varchar(36),
	`dist_hash` varchar(64),
	`qa_local_asset_id` varchar(36),
	`provenance_local_asset_id` varchar(36),
	`upstream_manus_task_id` varchar(255),
	`repair_attempts` int unsigned NOT NULL DEFAULT 0,
	`status` enum('preparing','visual_searching','awaiting_visual_selection','design_compiling','contract_ready','building','qa_running','preview_ready','approved','failed','attention_required','cancelled','superseded') NOT NULL DEFAULT 'preparing',
	`approved_at` timestamp,
	`error_code` varchar(128),
	`error_message` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_builds_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_builds_project_ordinal_uq` UNIQUE(`project_id`,`ordinal`),
	CONSTRAINT `site_builds_credential_version_ck` CHECK((
        (`site_builds`.`twenty_first_credential_id` IS NULL AND `site_builds`.`twenty_first_credential_version` IS NULL)
        OR
        (`site_builds`.`twenty_first_credential_id` IS NOT NULL AND `site_builds`.`twenty_first_credential_version` IS NOT NULL)
      )),
	CONSTRAINT `site_builds_quota_pair_ck` CHECK((
        (`site_builds`.`quota_period_id` IS NULL AND `site_builds`.`quota_state` IS NULL)
        OR
        (`site_builds`.`quota_period_id` IS NOT NULL AND `site_builds`.`quota_state` IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE `site_deployments` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`build_id` varchar(36) NOT NULL,
	`operation_id` varchar(36),
	`target` enum('global_excluding_cn','mainland_cn') NOT NULL,
	`intent` enum('deploy','rollback') NOT NULL,
	`rollback_of_deployment_id` varchar(36),
	`expected_head_deployment_id` varchar(36),
	`dist_local_asset_id` varchar(36) NOT NULL,
	`dist_hash` varchar(64) NOT NULL,
	`domain_revision` int unsigned NOT NULL,
	`provider_deployment_id` varchar(512),
	`public_url` text,
	`verification` json,
	`status` enum('reserved','deploying','verifying','active','superseded','failed','attention_required') NOT NULL DEFAULT 'reserved',
	`activated_at` timestamp,
	`error_code` varchar(128),
	`error_message` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_deployments_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_deployments_operation_uq` UNIQUE(`operation_id`)
);
--> statement-breakpoint
CREATE TABLE `site_dns_records` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`domain_operation_id` varchar(36),
	`domain_ascii` varchar(255) NOT NULL,
	`domain_revision` int unsigned NOT NULL,
	`record_type` varchar(16) NOT NULL,
	`rr` varchar(255) NOT NULL,
	`expected_value` text NOT NULL,
	`expected_ttl` int unsigned NOT NULL,
	`before_value` text,
	`before_ttl` int unsigned,
	`observed_value` text,
	`observed_ttl` int unsigned,
	`provider_record_id` varchar(191),
	`remark_marker` varchar(255) NOT NULL,
	`status` enum('planned','applying','propagating','active','conflict','failed','outcome_unknown','rolled_back') NOT NULL DEFAULT 'planned',
	`verified_at` timestamp,
	`error_code` varchar(128),
	`error_message` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_dns_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_dns_records_project_revision_tuple_uq` UNIQUE(`project_id`,`domain_revision`,`rr`,`record_type`)
);
--> statement-breakpoint
CREATE TABLE `site_domain_operations` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`connection_id` varchar(36),
	`operation_id` varchar(36),
	`kind` enum('search','purchase','renewal','set_auto_renew','cancel_auto_renew','sync') NOT NULL,
	`domain_ascii` varchar(255) NOT NULL,
	`domain_unicode` varchar(255),
	`domain_revision` int unsigned,
	`client_request_id` varchar(128) NOT NULL,
	`request_fingerprint` varchar(64) NOT NULL,
	`quote_hash` varchar(64),
	`quote_expires_at` timestamp,
	`amount_minor` bigint unsigned,
	`currency` varchar(8),
	`years` int unsigned,
	`registrant_profile_id` varchar(191),
	`masked_registrant_name` varchar(255),
	`customer_confirmed_at` timestamp,
	`customer_confirmation_hash` varchar(64),
	`active_financial_key` varchar(64),
	`provider_task_no` varchar(512),
	`provider_result` json,
	`status` enum('quoted','reserved','submitted','reconciling','succeeded','failed','outcome_unknown','attention_required','expired','cancelled') NOT NULL,
	`error_code` varchar(128),
	`error_message` text,
	`completed_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_domain_operations_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_domain_operations_project_request_uq` UNIQUE(`project_id`,`client_request_id`),
	CONSTRAINT `site_domain_operations_site_operation_uq` UNIQUE(`operation_id`),
	CONSTRAINT `site_domain_operations_active_financial_uq` UNIQUE(`active_financial_key`)
);
--> statement-breakpoint
CREATE TABLE `site_operations` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`conversation_turn_id` varchar(36),
	`build_id` varchar(36),
	`kind` enum('brief_message','visual_search','site_build','build_revision','deploy','rollback','social_package','domain_search','domain_purchase','domain_renewal','domain_auto_renew','dns_apply','dns_rollback') NOT NULL,
	`status` enum('queued','running','succeeded','failed','outcome_unknown','attention_required','cancelled') NOT NULL DEFAULT 'queued',
	`client_request_id` varchar(128) NOT NULL,
	`input_hash` varchar(64) NOT NULL,
	`input` json NOT NULL,
	`provider` varchar(64),
	`provider_operation_id` varchar(512),
	`provider_task_id` varchar(512),
	`lease_owner` varchar(128),
	`lease_expires_at` timestamp,
	`attempt` int unsigned NOT NULL DEFAULT 0,
	`result` json,
	`error_code` varchar(128),
	`error_message` text,
	`started_at` timestamp,
	`completed_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_operations_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_operations_project_request_uq` UNIQUE(`project_id`,`client_request_id`)
);
--> statement-breakpoint
CREATE TABLE `site_projects` (
	`id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`conversation_id` varchar(191) NOT NULL,
	`current_knowledge_snapshot_id` varchar(36),
	`current_build_id` varchar(36),
	`global_live_deployment_id` varchar(36),
	`mainland_live_deployment_id` varchar(36),
	`primary_language` varchar(32) NOT NULL DEFAULT 'zh-CN',
	`canonical_hostname` varchar(255),
	`status` enum('draft','collecting_brief','visual_searching','awaiting_visual_selection','building','preview_ready','approved','live','attention_required','failed','cancelled') NOT NULL DEFAULT 'draft',
	`brief` json,
	`revision` int unsigned NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_projects_user_uq` UNIQUE(`user_id`),
	CONSTRAINT `site_projects_conversation_uq` UNIQUE(`conversation_id`)
);
--> statement-breakpoint
CREATE TABLE `site_provider_connections` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`provider` enum('aliyun_cn') NOT NULL,
	`account_uid` varchar(128) NOT NULL,
	`role_arn` varchar(512) NOT NULL,
	`encryption_version` int NOT NULL DEFAULT 1,
	`encrypted_external_id` text NOT NULL,
	`encryption_iv` varchar(32) NOT NULL,
	`encryption_auth_tag` varchar(32) NOT NULL,
	`external_id_fingerprint` varchar(32) NOT NULL,
	`capabilities` json NOT NULL DEFAULT ('[]'),
	`status` enum('unverified','active','invalid','revoked') NOT NULL DEFAULT 'unverified',
	`verified_at` timestamp,
	`last_error_code` varchar(128),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_provider_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_provider_connections_project_provider_uq` UNIQUE(`project_id`,`provider`)
);
--> statement-breakpoint
CREATE TABLE `social_packages` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`knowledge_snapshot_id` varchar(36) NOT NULL,
	`operation_id` varchar(36),
	`ticket_id` varchar(36),
	`quota_period_id` varchar(36),
	`quota_state` enum('reserved','consumed','released'),
	`channel` enum('wechat','xiaohongshu') NOT NULL,
	`manifest` json,
	`manifest_hash` varchar(64),
	`archive_local_asset_id` varchar(36),
	`archive_hash` varchar(64),
	`preview_local_asset_ids` json NOT NULL DEFAULT ('[]'),
	`qa` json,
	`download_count` int unsigned NOT NULL DEFAULT 0,
	`status` enum('queued','building','ready','failed','attention_required','cancelled') NOT NULL DEFAULT 'queued',
	`error_code` varchar(128),
	`error_message` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `social_packages_id` PRIMARY KEY(`id`),
	CONSTRAINT `social_packages_operation_uq` UNIQUE(`operation_id`),
	CONSTRAINT `social_packages_quota_pair_ck` CHECK((
        (`social_packages`.`quota_period_id` IS NULL AND `social_packages`.`quota_state` IS NULL)
        OR
        (`social_packages`.`quota_period_id` IS NOT NULL AND `social_packages`.`quota_state` IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` MODIFY COLUMN `ticketId` varchar(36);--> statement-breakpoint
ALTER TABLE `website_style_samples` MODIFY COLUMN `attachmentId` varchar(36);--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD `sourceKind` enum('legacy_manual_three','siteops_21st') DEFAULT 'legacy_manual_three' NOT NULL;--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD `siteProjectId` varchar(36);--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD `selectionBundleLocalAssetId` varchar(36);--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD `selectionBundleHash` varchar(64);--> statement-breakpoint
ALTER TABLE `website_style_samples` ADD `previewLocalAssetId` varchar(36);--> statement-breakpoint
ALTER TABLE `website_style_samples` ADD `sourceMetadata` json;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `normalizedAsciiDomain` varchar(255);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `unicodeDisplayDomain` varchar(255);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `domainRevision` int unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `registrar` varchar(64);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `providerAccountUid` varchar(128);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `domainInstanceId` varchar(191);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `domainExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `domainRealNameStatus` varchar(64);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `domainEmailStatus` varchar(64);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `domainClientHold` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `domainOwnershipStatus` varchar(64);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `dnsStatus` varchar(64);--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `autoRenewDesired` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `autoRenewObserved` boolean;--> statement-breakpoint
ALTER TABLE `workspace_site_profiles` ADD `icpDomainRevision` int unsigned;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_knowledge_snapshot_id_knowledge_base_snapshots_id_fk` FOREIGN KEY (`knowledge_snapshot_id`) REFERENCES `knowledge_base_snapshots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_quota_period_fk` FOREIGN KEY (`quota_period_id`) REFERENCES `service_quota_periods`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_21st_credential_fk` FOREIGN KEY (`twenty_first_credential_id`) REFERENCES `presales_api_credentials`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_style_sample_id_website_style_samples_id_fk` FOREIGN KEY (`style_sample_id`) REFERENCES `website_style_samples`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_contract_local_asset_id_local_assets_id_fk` FOREIGN KEY (`contract_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_source_local_asset_id_local_assets_id_fk` FOREIGN KEY (`source_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_dist_local_asset_id_local_assets_id_fk` FOREIGN KEY (`dist_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_qa_local_asset_id_local_assets_id_fk` FOREIGN KEY (`qa_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_builds` ADD CONSTRAINT `site_builds_provenance_local_asset_id_local_assets_id_fk` FOREIGN KEY (`provenance_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_deployments` ADD CONSTRAINT `site_deployments_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_deployments` ADD CONSTRAINT `site_deployments_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_deployments` ADD CONSTRAINT `site_deployments_build_id_site_builds_id_fk` FOREIGN KEY (`build_id`) REFERENCES `site_builds`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_deployments` ADD CONSTRAINT `site_deployments_operation_id_site_operations_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `site_operations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_deployments` ADD CONSTRAINT `site_deployments_dist_local_asset_id_local_assets_id_fk` FOREIGN KEY (`dist_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_dns_records` ADD CONSTRAINT `site_dns_records_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_dns_records` ADD CONSTRAINT `site_dns_records_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_dns_records` ADD CONSTRAINT `site_dns_domain_operation_fk` FOREIGN KEY (`domain_operation_id`) REFERENCES `site_domain_operations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_domain_operations` ADD CONSTRAINT `site_domain_operations_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_domain_operations` ADD CONSTRAINT `site_domain_operations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_domain_operations` ADD CONSTRAINT `site_domain_connection_fk` FOREIGN KEY (`connection_id`) REFERENCES `site_provider_connections`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_domain_operations` ADD CONSTRAINT `site_domain_operations_operation_id_site_operations_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `site_operations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_operations` ADD CONSTRAINT `site_operations_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_operations` ADD CONSTRAINT `site_operations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_operations` ADD CONSTRAINT `site_operations_conversation_turn_id_conversation_turns_id_fk` FOREIGN KEY (`conversation_turn_id`) REFERENCES `conversation_turns`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_operations` ADD CONSTRAINT `site_operations_build_id_site_builds_id_fk` FOREIGN KEY (`build_id`) REFERENCES `site_builds`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_projects` ADD CONSTRAINT `site_projects_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_projects` ADD CONSTRAINT `site_projects_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_projects` ADD CONSTRAINT `site_projects_snapshot_fk` FOREIGN KEY (`current_knowledge_snapshot_id`) REFERENCES `knowledge_base_snapshots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_provider_connections` ADD CONSTRAINT `site_provider_connections_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `site_provider_connections` ADD CONSTRAINT `site_provider_connections_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_packages` ADD CONSTRAINT `social_packages_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_packages` ADD CONSTRAINT `social_packages_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_packages` ADD CONSTRAINT `social_packages_snapshot_fk` FOREIGN KEY (`knowledge_snapshot_id`) REFERENCES `knowledge_base_snapshots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_packages` ADD CONSTRAINT `social_packages_operation_id_site_operations_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `site_operations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_packages` ADD CONSTRAINT `social_packages_ticket_id_delivery_tickets_id_fk` FOREIGN KEY (`ticket_id`) REFERENCES `delivery_tickets`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_packages` ADD CONSTRAINT `social_packages_quota_period_fk` FOREIGN KEY (`quota_period_id`) REFERENCES `service_quota_periods`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `social_packages` ADD CONSTRAINT `social_packages_archive_local_asset_id_local_assets_id_fk` FOREIGN KEY (`archive_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `site_builds_project_status_idx` ON `site_builds` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `site_builds_parent_idx` ON `site_builds` (`parent_build_id`);--> statement-breakpoint
CREATE INDEX `site_builds_quota_period_state_idx` ON `site_builds` (`quota_period_id`,`quota_state`);--> statement-breakpoint
CREATE INDEX `site_deployments_project_target_status_idx` ON `site_deployments` (`project_id`,`target`,`status`);--> statement-breakpoint
CREATE INDEX `site_dns_records_status_idx` ON `site_dns_records` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `site_domain_operations_domain_status_idx` ON `site_domain_operations` (`domain_ascii`,`status`);--> statement-breakpoint
CREATE INDEX `site_operations_lease_idx` ON `site_operations` (`status`,`lease_expires_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `site_operations_build_idx` ON `site_operations` (`build_id`,`status`);--> statement-breakpoint
CREATE INDEX `site_projects_status_updated_idx` ON `site_projects` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `site_provider_connections_account_idx` ON `site_provider_connections` (`account_uid`);--> statement-breakpoint
CREATE INDEX `social_packages_project_channel_idx` ON `social_packages` (`project_id`,`channel`,`created_at`);--> statement-breakpoint
CREATE INDEX `social_packages_quota_period_state_idx` ON `social_packages` (`quota_period_id`,`quota_state`);--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD CONSTRAINT `website_style_batches_source_ck` CHECK ((
        (`website_style_sample_batches`.`sourceKind` = 'legacy_manual_three' AND `website_style_sample_batches`.`ticketId` IS NOT NULL AND `website_style_sample_batches`.`siteProjectId` IS NULL)
        OR
        (`website_style_sample_batches`.`sourceKind` = 'siteops_21st' AND `website_style_sample_batches`.`ticketId` IS NULL AND `website_style_sample_batches`.`siteProjectId` IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE `website_style_samples` ADD CONSTRAINT `website_style_samples_source_ck` CHECK ((
        (`website_style_samples`.`attachmentId` IS NOT NULL AND `website_style_samples`.`previewLocalAssetId` IS NULL)
        OR
        (`website_style_samples`.`attachmentId` IS NULL AND `website_style_samples`.`previewLocalAssetId` IS NOT NULL)
      ));--> statement-breakpoint
ALTER TABLE `website_style_sample_batches` ADD CONSTRAINT `website_style_batches_bundle_asset_fk` FOREIGN KEY (`selectionBundleLocalAssetId`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `website_style_samples` ADD CONSTRAINT `website_style_samples_previewLocalAssetId_local_assets_id_fk` FOREIGN KEY (`previewLocalAssetId`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `website_style_batches_site_project_status_idx` ON `website_style_sample_batches` (`siteProjectId`,`status`);--> statement-breakpoint
CREATE INDEX `workspace_site_profiles_ascii_domain_idx` ON `workspace_site_profiles` (`normalizedAsciiDomain`);
