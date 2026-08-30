CREATE TABLE `site_build_input_assets` (
	`id` varchar(36) NOT NULL,
	`build_id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`user_id` int NOT NULL,
	`source_asset_id` varchar(191) NOT NULL,
	`local_asset_id` varchar(36) NOT NULL,
	`ordinal` int unsigned NOT NULL,
	`filename` varchar(512) NOT NULL,
	`mime_type` varchar(255) NOT NULL,
	`size_bytes` int unsigned NOT NULL,
	`content_sha256` varchar(64) NOT NULL,
	`width` int unsigned NOT NULL,
	`height` int unsigned NOT NULL,
	`public_path` varchar(512) NOT NULL,
	`task_started_at` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `site_build_input_assets_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_build_input_assets_build_ordinal_uq` UNIQUE(`build_id`,`ordinal`),
	CONSTRAINT `site_build_input_assets_build_source_uq` UNIQUE(`build_id`,`source_asset_id`),
	CONSTRAINT `site_build_input_assets_build_public_path_uq` UNIQUE(`build_id`,`public_path`),
	CONSTRAINT `site_build_input_assets_build_id_site_builds_id_fk` FOREIGN KEY (`build_id`) REFERENCES `site_builds`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `site_build_input_assets_project_id_site_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `site_projects`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `site_build_input_assets_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `site_build_input_assets_local_asset_id_local_assets_id_fk` FOREIGN KEY (`local_asset_id`) REFERENCES `local_assets`(`id`) ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE `site_builds` ADD `content_plan_local_asset_id` varchar(36);--> statement-breakpoint
ALTER TABLE `site_builds` ADD `content_plan_sha256` varchar(64);--> statement-breakpoint
CREATE INDEX `site_build_input_assets_local_asset_idx` ON `site_build_input_assets` (`local_asset_id`);--> statement-breakpoint
CREATE INDEX `site_build_input_assets_project_task_idx` ON `site_build_input_assets` (`project_id`,`task_started_at`);
