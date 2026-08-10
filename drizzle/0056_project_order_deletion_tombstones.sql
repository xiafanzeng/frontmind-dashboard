CREATE TABLE `website_project_deletion_tombstones` (
	`projectId` varchar(80) NOT NULL,
	`schemaVersion` int unsigned NOT NULL DEFAULT 1,
	`status` enum('active','deleting','deleted') NOT NULL DEFAULT 'active',
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deletionRequestedAt` timestamp(3),
	`completedAt` timestamp(3),
	CONSTRAINT `website_project_deletion_tombstones_projectId` PRIMARY KEY(`projectId`),
	CONSTRAINT `website_project_deletion_tombstones_schema_version_ck` CHECK(`website_project_deletion_tombstones`.`schemaVersion` = 1)
);
--> statement-breakpoint
ALTER TABLE `presales_monitor_runs` ADD `projectId` varchar(80);--> statement-breakpoint
ALTER TABLE `presales_upstream_resources` ADD `projectId` varchar(80);--> statement-breakpoint
CREATE INDEX `presales_monitor_project_idx` ON `presales_monitor_runs` (`projectId`);--> statement-breakpoint
CREATE INDEX `presales_upstream_resources_project_idx` ON `presales_upstream_resources` (`projectId`);