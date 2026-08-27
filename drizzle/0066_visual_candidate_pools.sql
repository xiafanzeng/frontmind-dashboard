CREATE TABLE `visual_candidate_pools` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`knowledge_snapshot_id` varchar(36) NOT NULL,
	`credential_id` varchar(36) NOT NULL,
	`credential_version` int unsigned NOT NULL,
	`initial_operation_id` varchar(36) NOT NULL,
	`generation_key` varchar(64) NOT NULL,
	`task_started_at` timestamp NOT NULL,
	`project_revision` int unsigned NOT NULL,
	`seed` varchar(64) NOT NULL,
	`catalog_fingerprint` varchar(64) NOT NULL,
	`query_plan_hash` varchar(64) NOT NULL,
	`manifest_local_asset_id` varchar(36) NOT NULL,
	`manifest_hash` varchar(64) NOT NULL,
	`page_count` int unsigned NOT NULL,
	`candidate_count` int unsigned NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `visual_candidate_pools_id` PRIMARY KEY(`id`),
	CONSTRAINT `visual_candidate_pools_generation_uq` UNIQUE(`generation_key`),
	CONSTRAINT `visual_candidate_pools_status_ck` CHECK(`visual_candidate_pools`.`status` IN ('active', 'selected', 'superseded')),
	CONSTRAINT `visual_candidate_pools_capacity_ck` CHECK((`visual_candidate_pools`.`page_count` BETWEEN 1 AND 3 AND `visual_candidate_pools`.`candidate_count` = `visual_candidate_pools`.`page_count` * 9)),
	CONSTRAINT `visual_candidate_pools_project_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `visual_candidate_pools_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `visual_candidate_pools_snapshot_fk` FOREIGN KEY (`knowledge_snapshot_id`) REFERENCES `knowledge_base_snapshots`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `visual_candidate_pools_credential_fk` FOREIGN KEY (`credential_id`) REFERENCES `presales_api_credentials`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `visual_candidate_pools_operation_fk` FOREIGN KEY (`initial_operation_id`) REFERENCES `site_operations`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `visual_candidate_pools_manifest_fk` FOREIGN KEY (`manifest_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE `visual_candidate_pool_pages` (
	`id` varchar(36) NOT NULL,
	`pool_id` varchar(36) NOT NULL,
	`page_number` int unsigned NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'reserved',
	`selection_bundle_local_asset_id` varchar(36) NOT NULL,
	`selection_bundle_hash` varchar(64) NOT NULL,
	`candidate_count` int unsigned NOT NULL,
	`bundle_size_bytes` int unsigned NOT NULL,
	`batch_id` varchar(36),
	`published_operation_id` varchar(36),
	`published_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `visual_candidate_pool_pages_id` PRIMARY KEY(`id`),
	CONSTRAINT `visual_candidate_pool_pages_pool_page_uq` UNIQUE(`pool_id`,`page_number`),
	CONSTRAINT `visual_candidate_pool_pages_batch_uq` UNIQUE(`batch_id`),
	CONSTRAINT `visual_candidate_pool_pages_status_ck` CHECK(`visual_candidate_pool_pages`.`status` IN ('reserved', 'published', 'selected', 'superseded')),
	CONSTRAINT `visual_candidate_pool_pages_capacity_ck` CHECK((`visual_candidate_pool_pages`.`page_number` BETWEEN 1 AND 3 AND `visual_candidate_pool_pages`.`candidate_count` = 9 AND `visual_candidate_pool_pages`.`bundle_size_bytes` > 0 AND `visual_candidate_pool_pages`.`bundle_size_bytes` <= 104857600)),
	CONSTRAINT `visual_candidate_pool_pages_publish_ck` CHECK((
        (`visual_candidate_pool_pages`.`status` = 'reserved' AND `visual_candidate_pool_pages`.`batch_id` IS NULL AND `visual_candidate_pool_pages`.`published_operation_id` IS NULL AND `visual_candidate_pool_pages`.`published_at` IS NULL)
        OR
        (`visual_candidate_pool_pages`.`status` IN ('published', 'selected') AND `visual_candidate_pool_pages`.`batch_id` IS NOT NULL AND `visual_candidate_pool_pages`.`published_operation_id` IS NOT NULL AND `visual_candidate_pool_pages`.`published_at` IS NOT NULL)
        OR
        `visual_candidate_pool_pages`.`status` = 'superseded'
      )),
	CONSTRAINT `visual_candidate_pool_pages_pool_fk` FOREIGN KEY (`pool_id`) REFERENCES `visual_candidate_pools`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `visual_candidate_pool_pages_bundle_fk` FOREIGN KEY (`selection_bundle_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `visual_candidate_pool_pages_batch_fk` FOREIGN KEY (`batch_id`) REFERENCES `website_style_sample_batches`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `visual_candidate_pool_pages_operation_fk` FOREIGN KEY (`published_operation_id`) REFERENCES `site_operations`(`id`) ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE `visual_candidate_pool_items` (
	`id` varchar(36) NOT NULL,
	`pool_page_id` varchar(36) NOT NULL,
	`sample_id` varchar(36) NOT NULL,
	`position` int unsigned NOT NULL,
	`preview_local_asset_id` varchar(36) NOT NULL,
	`preview_sha256` varchar(64) NOT NULL,
	`source_tree_sha256` varchar(64) NOT NULL,
	`provider_template_id` varchar(191) NOT NULL,
	`provider_slug` varchar(191) NOT NULL,
	`provider_version` varchar(191),
	`provider_item_key` varchar(512) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `visual_candidate_pool_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `visual_candidate_pool_items_page_sample_uq` UNIQUE(`pool_page_id`,`sample_id`),
	CONSTRAINT `visual_candidate_pool_items_page_position_uq` UNIQUE(`pool_page_id`,`position`),
	CONSTRAINT `visual_candidate_pool_items_preview_uq` UNIQUE(`preview_local_asset_id`),
	CONSTRAINT `visual_candidate_pool_items_page_provider_uq` UNIQUE(`pool_page_id`,`provider_item_key`),
	CONSTRAINT `visual_candidate_pool_items_position_ck` CHECK(`visual_candidate_pool_items`.`position` BETWEEN 0 AND 8),
	CONSTRAINT `visual_candidate_pool_items_page_fk` FOREIGN KEY (`pool_page_id`) REFERENCES `visual_candidate_pool_pages`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `visual_candidate_pool_items_preview_fk` FOREIGN KEY (`preview_local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `visual_candidate_pool_items_source_tree_idx` ON `visual_candidate_pool_items` (`source_tree_sha256`);
--> statement-breakpoint
CREATE INDEX `visual_candidate_pool_pages_status_idx` ON `visual_candidate_pool_pages` (`pool_id`,`status`,`page_number`);
--> statement-breakpoint
CREATE INDEX `visual_candidate_pools_project_task_idx` ON `visual_candidate_pools` (`project_id`,`task_started_at`,`status`);
--> statement-breakpoint
CREATE INDEX `visual_candidate_pools_snapshot_credential_idx` ON `visual_candidate_pools` (`knowledge_snapshot_id`,`credential_id`,`credential_version`);
