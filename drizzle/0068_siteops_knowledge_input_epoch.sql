ALTER TABLE `knowledge_base_builds` ADD `site_ops_knowledge_input_epoch_id` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_base_snapshots` ADD `siteOpsKnowledgeInputEpochId` varchar(36);--> statement-breakpoint
ALTER TABLE `knowledge_import_receipts` ADD `siteOpsKnowledgeInputEpochId` varchar(36);--> statement-breakpoint
ALTER TABLE `local_assets` ADD `site_ops_knowledge_input_epoch_id` varchar(36);--> statement-breakpoint
ALTER TABLE `site_build_input_assets` ADD `site_ops_knowledge_input_epoch_id` varchar(36);--> statement-breakpoint
ALTER TABLE `site_projects` ADD `knowledge_input_epoch_id` varchar(36);--> statement-breakpoint
CREATE INDEX `local_assets_siteops_epoch_idx` ON `local_assets` (`account_user_id`,`site_ops_knowledge_input_epoch_id`);--> statement-breakpoint
CREATE INDEX `site_build_input_assets_project_epoch_idx` ON `site_build_input_assets` (`project_id`,`site_ops_knowledge_input_epoch_id`);