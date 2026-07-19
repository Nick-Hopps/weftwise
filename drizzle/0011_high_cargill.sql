ALTER TABLE `llm_usage` ADD `subject_id` text REFERENCES subjects(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_llm_usage_created_at` ON `llm_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_llm_usage_subject_created_at` ON `llm_usage` (`subject_id`,`created_at`);
