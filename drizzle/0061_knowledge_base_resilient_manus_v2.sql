ALTER TABLE `knowledge_base_builds` ADD `providerProtocol` varchar(32) NOT NULL DEFAULT 'legacy_v1';--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `canonicalTaskId` varchar(255);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `canonicalTaskGeneration` int unsigned;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `canonicalCredentialId` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `canonicalTaskState` varchar(32) NOT NULL DEFAULT 'unbound';--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `canonicalTaskUrl` varchar(1024);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `canonicalTaskCreatedAt` timestamp;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `handoffProvenance` json;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `skillArchiveSha256` varchar(64);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `skillArchiveBytes` int unsigned;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `skillArchiveStorageKey` varchar(1024);--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `contentCompletedAt` timestamp;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageStatus` varchar(32) NOT NULL DEFAULT 'not_started';--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageAttemptCount` int unsigned NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageNextRetryAt` timestamp;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `packageLastErrorCode` varchar(128);--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_base_builds_canonical_task_idx` ON `knowledge_base_builds` (`canonicalTaskId`);--> statement-breakpoint
CREATE INDEX `knowledge_base_builds_canonical_credential_idx` ON `knowledge_base_builds` (`canonicalCredentialId`);
