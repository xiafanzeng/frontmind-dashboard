ALTER TABLE `delivery_tickets` ADD `parentTicketId` varchar(36);--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `rootTicketId` varchar(36);--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `workflowStageKey` varchar(255);--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `isWorkflowContainer` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `credentialTargetUserId` int;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD `credentialRequestKind` enum('managed_api','jenova_brand_tracking');--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_parent_stage_uq` UNIQUE(`parentTicketId`,`workflowStageKey`);--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_credentialTargetUserId_users_id_fk` FOREIGN KEY (`credentialTargetUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_parent_ticket_fk` FOREIGN KEY (`parentTicketId`) REFERENCES `delivery_tickets`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_tickets` ADD CONSTRAINT `delivery_tickets_root_ticket_fk` FOREIGN KEY (`rootTicketId`) REFERENCES `delivery_tickets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `delivery_tickets_parent_operation_idx` ON `delivery_tickets` (`parentTicketId`,`operation`);--> statement-breakpoint
CREATE INDEX `delivery_tickets_root_status_idx` ON `delivery_tickets` (`rootTicketId`,`status`);--> statement-breakpoint
CREATE INDEX `delivery_tickets_user_container_updated_idx` ON `delivery_tickets` (`userId`,`isWorkflowContainer`,`updatedAt`,`id`);--> statement-breakpoint
CREATE INDEX `delivery_tickets_credential_target_status_idx` ON `delivery_tickets` (`credentialRequestKind`,`credentialTargetUserId`,`status`);