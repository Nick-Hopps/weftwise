CREATE TABLE `research_approval_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`approval_id` text NOT NULL,
	`approval_json` text NOT NULL,
	`deliveries_json` text NOT NULL,
	`archived_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_approval_attempts_run_approval_unique` ON `research_approval_attempts` (`run_id`,`approval_id`);--> statement-breakpoint
CREATE INDEX `research_approval_attempts_run_archived_idx` ON `research_approval_attempts` (`run_id`,`archived_at`);