CREATE TABLE `website_project_attributions` (
	`project_id` varchar(80) NOT NULL,
	`business_owner_name` varchar(40) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `website_project_attributions_project_id` PRIMARY KEY(`project_id`)
);
