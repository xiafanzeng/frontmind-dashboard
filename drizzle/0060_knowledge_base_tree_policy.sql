ALTER TABLE `knowledge_base_builds` ADD `treePolicyVersion` int unsigned NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE `knowledge_base_builds` ADD `initialResearchCoverage` json;
