ALTER TABLE `website_manual_service_orders` ADD `marketEdition` enum('domestic','overseas') NOT NULL DEFAULT 'domestic';--> statement-breakpoint
ALTER TABLE `website_user_provisions` ADD `marketEdition` enum('domestic','overseas') NOT NULL DEFAULT 'domestic';
