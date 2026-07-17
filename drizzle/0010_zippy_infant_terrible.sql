PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pending_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
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
	CONSTRAINT "pending_actions_operation_check" CHECK("__new_pending_actions"."operation" IN ('create','update','patch','delete','reenrich','metadata-patch','link-ensure','history-revert','workflow-reenrich-start','workflow-research-start','workflow-image-insert-start','workflow-cancel','move','tag-batch')),
	CONSTRAINT "pending_actions_status_check" CHECK("__new_pending_actions"."status" IN ('pending','approved','executing','applied','rejected','expired','failed'))
);
--> statement-breakpoint
INSERT INTO `__new_pending_actions`("id", "conversation_id", "subject_id", "operation", "payload_json", "payload_hash", "preview_json", "status", "created_at", "updated_at", "expires_at", "approved_at", "applied_at", "operation_id", "job_id", "error_json") SELECT "id", "conversation_id", "subject_id", "operation", "payload_json", "payload_hash", "preview_json", "status", "created_at", "updated_at", "expires_at", "approved_at", "applied_at", "operation_id", "job_id", "error_json" FROM `pending_actions`;--> statement-breakpoint
DROP TABLE `pending_actions`;--> statement-breakpoint
ALTER TABLE `__new_pending_actions` RENAME TO `pending_actions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `pending_actions_conversation_status_idx` ON `pending_actions` (`conversation_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `pending_actions_subject_status_expiry_idx` ON `pending_actions` (`subject_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `pending_actions_status_expiry_idx` ON `pending_actions` (`status`,`expires_at`);