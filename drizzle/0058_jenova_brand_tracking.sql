CREATE TABLE `jenova_brand_tracking_credentials` (
	`id` varchar(36) NOT NULL,
	`encryptionVersion` int NOT NULL DEFAULT 1,
	`encryptedKey` text NOT NULL,
	`encryptionIv` varchar(32) NOT NULL,
	`encryptionAuthTag` varchar(32) NOT NULL,
	`fingerprint` varchar(32) NOT NULL,
	`status` enum('active','revoked') NOT NULL DEFAULT 'active',
	`validationStatus` enum('unverified','verified','invalid') NOT NULL DEFAULT 'unverified',
	`lastBalance` decimal(20,8),
	`validatedAt` timestamp,
	`balanceSyncedAt` timestamp,
	`revokedAt` timestamp,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jenova_brand_tracking_credentials_id` PRIMARY KEY(`id`),
	CONSTRAINT `jenova_bt_credentials_fingerprint_uq` UNIQUE(`fingerprint`),
	CONSTRAINT `jenova_brand_tracking_credentials_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `jenova_bt_credentials_status_idx` ON `jenova_brand_tracking_credentials` (`status`);
--> statement-breakpoint
CREATE TABLE `jenova_brand_tracking_assignments` (
	`userId` int NOT NULL,
	`credentialId` varchar(36) NOT NULL,
	`assignedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jenova_brand_tracking_assignments_userId` PRIMARY KEY(`userId`),
	CONSTRAINT `jenova_brand_tracking_assignments_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade,
	CONSTRAINT `jenova_brand_tracking_assignments_assignedByUserId_users_id_fk` FOREIGN KEY (`assignedByUserId`) REFERENCES `users`(`id`) ON DELETE set null,
	CONSTRAINT `jenova_bt_assignments_credential_fk` FOREIGN KEY (`credentialId`) REFERENCES `jenova_brand_tracking_credentials`(`id`) ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `jenova_bt_assignments_credential_idx` ON `jenova_brand_tracking_assignments` (`credentialId`);
--> statement-breakpoint
CREATE TABLE `jenova_brand_tracking_policies` (
	`userId` int NOT NULL,
	`rolling30DayLimit` decimal(20,8) NOT NULL DEFAULT '10.00000000',
	`updatedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jenova_brand_tracking_policies_userId` PRIMARY KEY(`userId`),
	CONSTRAINT `jenova_brand_tracking_policies_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade,
	CONSTRAINT `jenova_brand_tracking_policies_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `jenova_brand_tracking_sessions` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`credentialId` varchar(36) NOT NULL,
	`clientRequestId` varchar(36) NOT NULL,
	`upstreamSessionId` varchar(255),
	`title` varchar(255) NOT NULL DEFAULT '品牌追踪会话',
	`status` enum('active','archived') NOT NULL DEFAULT 'active',
	`archivedReason` varchar(64),
	`archivedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jenova_brand_tracking_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `jenova_bt_sessions_user_request_uq` UNIQUE(`userId`,`clientRequestId`),
	CONSTRAINT `jenova_brand_tracking_sessions_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade,
	CONSTRAINT `jenova_bt_sessions_credential_fk` FOREIGN KEY (`credentialId`) REFERENCES `jenova_brand_tracking_credentials`(`id`) ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `jenova_bt_sessions_user_status_updated_idx` ON `jenova_brand_tracking_sessions` (`userId`,`status`,`updatedAt`);
--> statement-breakpoint
CREATE INDEX `jenova_bt_sessions_upstream_idx` ON `jenova_brand_tracking_sessions` (`upstreamSessionId`);
--> statement-breakpoint
CREATE TABLE `jenova_brand_tracking_turns` (
	`id` varchar(36) NOT NULL,
	`sessionId` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`credentialId` varchar(36) NOT NULL,
	`clientRequestId` varchar(36) NOT NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`upstreamRunId` varchar(255),
	`hiddenKickoff` boolean NOT NULL DEFAULT false,
	`userContent` longtext NOT NULL,
	`assistantContent` longtext NOT NULL,
	`status` enum('pending','streaming','completed','failed','recovering') NOT NULL DEFAULT 'pending',
	`costState` enum('pending','confirmed','unknown') NOT NULL DEFAULT 'pending',
	`usageCost` decimal(20,8),
	`sessionFee` decimal(20,8) NOT NULL DEFAULT '0.00000000',
	`progress` json,
	`warnings` json,
	`stopReason` varchar(255),
	`errorCode` varchar(128),
	`errorMessage` text,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jenova_brand_tracking_turns_id` PRIMARY KEY(`id`),
	CONSTRAINT `jenova_bt_turns_user_request_uq` UNIQUE(`userId`,`clientRequestId`),
	CONSTRAINT `jenova_bt_turns_idempotency_uq` UNIQUE(`idempotencyKey`),
	CONSTRAINT `jenova_brand_tracking_turns_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade,
	CONSTRAINT `jenova_bt_turns_session_fk` FOREIGN KEY (`sessionId`) REFERENCES `jenova_brand_tracking_sessions`(`id`) ON DELETE cascade,
	CONSTRAINT `jenova_bt_turns_credential_fk` FOREIGN KEY (`credentialId`) REFERENCES `jenova_brand_tracking_credentials`(`id`) ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `jenova_bt_turns_session_created_idx` ON `jenova_brand_tracking_turns` (`sessionId`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `jenova_bt_turns_user_cost_created_idx` ON `jenova_brand_tracking_turns` (`userId`,`costState`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `jenova_bt_turns_credential_cost_idx` ON `jenova_brand_tracking_turns` (`credentialId`,`costState`);
--> statement-breakpoint
CREATE INDEX `jenova_bt_turns_status_updated_idx` ON `jenova_brand_tracking_turns` (`status`,`updatedAt`);
