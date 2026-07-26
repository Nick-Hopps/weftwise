CREATE TABLE `page_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`slug` text NOT NULL,
	`kind` text NOT NULL,
	`polarity` text NOT NULL,
	`strength` text NOT NULL,
	`anchor` text,
	`detail_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `page_evidence_page_idx` ON `page_evidence` (`user_id`,`subject_id`,`slug`,`created_at`);--> statement-breakpoint
CREATE INDEX `page_evidence_scope_idx` ON `page_evidence` (`user_id`,`subject_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `user_profiles` ADD `style_prefs_updated_at` text;