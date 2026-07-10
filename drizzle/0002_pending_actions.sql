CREATE TABLE IF NOT EXISTS `llm_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pending_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`operation` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`preview_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`approved_at` text,
	`applied_at` text,
	`operation_id` text,
	`job_id` text,
	`error_json` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pending_actions_operation_check" CHECK("pending_actions"."operation" IN ('create','update','patch','delete','reenrich')),
	CONSTRAINT "pending_actions_status_check" CHECK("pending_actions"."status" IN ('pending','approved','executing','applied','rejected','expired','failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pending_actions_conversation_status_idx` ON `pending_actions` (`conversation_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pending_actions_subject_status_expiry_idx` ON `pending_actions` (`subject_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pending_actions_status_expiry_idx` ON `pending_actions` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `research_backlog` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`question` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`research_job_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
