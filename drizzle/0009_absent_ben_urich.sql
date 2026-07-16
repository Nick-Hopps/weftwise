CREATE TABLE `page_rendition_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`slug` text NOT NULL,
	`media_type` text NOT NULL,
	`data_base64` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `page_rendition_assets_page_idx` ON `page_rendition_assets` (`subject_id`,`slug`);