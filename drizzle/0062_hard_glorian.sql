CREATE TABLE `agent_events` (
	`id` varchar(36) NOT NULL,
	`task_id` varchar(36) NOT NULL,
	`provider_event_id` varchar(512) NOT NULL,
	`event_type` varchar(64) NOT NULL,
	`provider_timestamp_ms` bigint unsigned NOT NULL,
	`normalized_payload` json NOT NULL,
	`received_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_events_task_provider_event_uq` UNIQUE(`task_id`,`provider_event_id`)
);
--> statement-breakpoint
CREATE TABLE `agent_operations` (
	`id` varchar(36) NOT NULL,
	`scope` enum('managed_user','website_frontend') NOT NULL,
	`account_user_id` int,
	`presales_project_id` varchar(80),
	`operation_type` varchar(96) NOT NULL,
	`idempotency_key_hash` varchar(64) NOT NULL,
	`request_hash` varchar(64) NOT NULL,
	`contract_name` varchar(128) NOT NULL,
	`contract_revision` int unsigned NOT NULL,
	`schema_hash` varchar(64) NOT NULL,
	`api_credential_id` varchar(36) NOT NULL,
	`credential_version` int unsigned NOT NULL,
	`public_profile` varchar(32) NOT NULL,
	`upstream_model` varchar(64) NOT NULL,
	`status` enum('queued','running','result_pending','succeeded','failed','cancelled','attention_required') NOT NULL DEFAULT 'queued',
	`error_code` varchar(128),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_operations_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_operations_scope_idempotency_uq` UNIQUE(`scope`,`idempotency_key_hash`),
	CONSTRAINT `agent_operations_owner_ck` CHECK((
        (`agent_operations`.`scope` = 'managed_user' AND `agent_operations`.`account_user_id` IS NOT NULL AND `agent_operations`.`presales_project_id` IS NULL)
        OR
        (`agent_operations`.`scope` = 'website_frontend' AND `agent_operations`.`account_user_id` IS NULL AND `agent_operations`.`presales_project_id` IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE `agent_tasks` (
	`id` varchar(36) NOT NULL,
	`operation_id` varchar(36) NOT NULL,
	`provider_task_id` varchar(255),
	`provider_request_id` varchar(512),
	`create_marker` varchar(128) NOT NULL,
	`title` varchar(255) NOT NULL,
	`provider_state` varchar(32) NOT NULL,
	`last_message_sync_at` timestamp,
	`result_deadline_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_tasks_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_tasks_provider_task_uq` UNIQUE(`provider_task_id`),
	CONSTRAINT `agent_tasks_operation_marker_uq` UNIQUE(`operation_id`,`create_marker`)
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` varchar(96) NOT NULL,
	`operation_id` varchar(36),
	`task_id` varchar(36),
	`source_event_id` varchar(512) NOT NULL,
	`attachment_index` int unsigned NOT NULL,
	`filename` varchar(512) NOT NULL,
	`mime_type` varchar(255) NOT NULL,
	`size_bytes` int unsigned NOT NULL,
	`content_sha256` varchar(64) NOT NULL,
	`storage_key` varchar(1024) NOT NULL,
	`validation_state` enum('staged','valid','invalid') NOT NULL DEFAULT 'staged',
	`ref_count` int unsigned NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `artifacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `artifacts_task_event_attachment_uq` UNIQUE(`task_id`,`source_event_id`,`attachment_index`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_base_executions` (
	`id` varchar(36) NOT NULL,
	`build_id` varchar(36) NOT NULL,
	`generation` int unsigned NOT NULL,
	`operation_type` enum('initial','revision') NOT NULL,
	`target_leaf_id` varchar(191),
	`base_working_set_id` varchar(36),
	`operation_id` varchar(128) NOT NULL,
	`provider_task_id` varchar(255),
	`api_credential_id` varchar(36) NOT NULL,
	`credential_version` int unsigned NOT NULL,
	`public_profile` varchar(32) NOT NULL,
	`upstream_model` varchar(64) NOT NULL,
	`request_hash` varchar(64) NOT NULL,
	`status` enum('reserved','submitted','result_pending','succeeded','failed','attention_required') NOT NULL DEFAULT 'reserved',
	`error_code` varchar(128),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completed_at` timestamp,
	CONSTRAINT `knowledge_base_executions_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_base_executions_operation_uq` UNIQUE(`build_id`,`generation`,`operation_id`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_base_working_sets` (
	`id` varchar(36) NOT NULL,
	`build_id` varchar(36) NOT NULL,
	`generation` int unsigned NOT NULL,
	`content_version` int unsigned NOT NULL,
	`source_execution_id` varchar(36),
	`storage_key` varchar(1024) NOT NULL,
	`size_bytes` int unsigned NOT NULL,
	`package_sha256` varchar(64) NOT NULL,
	`manifest_sha256` varchar(64) NOT NULL,
	`manifest` json NOT NULL,
	`status` enum('staged','active','superseded','invalid') NOT NULL DEFAULT 'staged',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`activated_at` timestamp,
	CONSTRAINT `knowledge_base_working_sets_id` PRIMARY KEY(`id`),
	CONSTRAINT `knowledge_base_working_sets_version_uq` UNIQUE(`build_id`,`generation`,`content_version`),
	CONSTRAINT `knowledge_base_working_sets_package_uq` UNIQUE(`build_id`,`generation`,`package_sha256`)
);
--> statement-breakpoint
CREATE TABLE `local_assets` (
	`id` varchar(36) NOT NULL,
	`scope` enum('managed_user','website_frontend') NOT NULL,
	`account_user_id` int,
	`presales_project_id` varchar(80),
	`filename` varchar(512) NOT NULL,
	`mime_type` varchar(255) NOT NULL,
	`size_bytes` int unsigned NOT NULL,
	`content_sha256` varchar(64) NOT NULL,
	`storage_key` varchar(1024) NOT NULL,
	`storage_key_hash` varchar(64) NOT NULL,
	`ref_count` int unsigned NOT NULL DEFAULT 1,
	`retain_until` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `local_assets_id` PRIMARY KEY(`id`),
	CONSTRAINT `local_assets_scope_storage_uq` UNIQUE(`scope`,`storage_key_hash`)
);
--> statement-breakpoint
CREATE TABLE `provider_file_leases` (
	`id` varchar(36) NOT NULL,
	`local_asset_id` varchar(36) NOT NULL,
	`api_credential_id` varchar(36) NOT NULL,
	`credential_version` int unsigned NOT NULL,
	`provider_file_id` varchar(512),
	`provider_request_id` varchar(512),
	`upload_state` enum('reserved','uploading','uploaded','expired','failed','outcome_unknown') NOT NULL DEFAULT 'reserved',
	`uploaded_bytes` int unsigned NOT NULL DEFAULT 0,
	`expires_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `provider_file_leases_id` PRIMARY KEY(`id`),
	CONSTRAINT `provider_file_leases_provider_file_uq` UNIQUE(`provider_file_id`)
);
--> statement-breakpoint
ALTER TABLE `api_credentials` ADD `agent_profile` varchar(32);--> statement-breakpoint
ALTER TABLE `knowledge_base_build_nodes` ADD `content_version` int unsigned;--> statement-breakpoint
ALTER TABLE `knowledge_base_build_nodes` ADD `asset_refs` json;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `execution_mode` varchar(32);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `active_working_set_id` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `content_version` int unsigned;--> statement-breakpoint
CREATE INDEX `agent_events_task_time_idx` ON `agent_events` (`task_id`,`provider_timestamp_ms`);--> statement-breakpoint
CREATE INDEX `agent_operations_account_status_idx` ON `agent_operations` (`account_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_operations_project_status_idx` ON `agent_operations` (`presales_project_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_tasks_operation_state_idx` ON `agent_tasks` (`operation_id`,`provider_state`);--> statement-breakpoint
CREATE INDEX `artifacts_operation_validation_idx` ON `artifacts` (`operation_id`,`validation_state`);--> statement-breakpoint
CREATE INDEX `knowledge_base_executions_status_idx` ON `knowledge_base_executions` (`build_id`,`status`);--> statement-breakpoint
CREATE INDEX `knowledge_base_working_sets_status_idx` ON `knowledge_base_working_sets` (`build_id`,`status`);--> statement-breakpoint
CREATE INDEX `local_assets_account_hash_idx` ON `local_assets` (`account_user_id`,`content_sha256`);--> statement-breakpoint
CREATE INDEX `local_assets_project_hash_idx` ON `local_assets` (`presales_project_id`,`content_sha256`);--> statement-breakpoint
CREATE INDEX `provider_file_leases_asset_credential_idx` ON `provider_file_leases` (`local_asset_id`,`api_credential_id`,`upload_state`);
