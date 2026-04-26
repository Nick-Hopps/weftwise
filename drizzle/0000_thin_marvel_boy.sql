CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`data_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`subject_id` text,
	`params_json` text DEFAULT '{}',
	`result_json` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`lease_expires_at` text,
	`heartbeat_at` text,
	`attempt_count` integer DEFAULT 0,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`subject_id` text,
	`pre_head` text NOT NULL,
	`post_head` text,
	`changeset_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `page_aliases` (
	`subject_id` text NOT NULL,
	`old_slug` text NOT NULL,
	`new_slug` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`subject_id`, `old_slug`, `new_slug`),
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `page_sources` (
	`subject_id` text NOT NULL,
	`page_slug` text NOT NULL,
	`source_id` text NOT NULL,
	PRIMARY KEY(`subject_id`, `page_slug`, `source_id`),
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pages` (
	`subject_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`path` text NOT NULL,
	`summary` text DEFAULT '',
	`content_hash` text NOT NULL,
	`tags` text DEFAULT '[]',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`subject_id`, `slug`),
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pages_path_unique` ON `pages` (`path`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_hash` text NOT NULL,
	`parsed_at` text,
	`metadata_json` text DEFAULT '{}',
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subjects_slug_unique` ON `subjects` (`slug`);--> statement-breakpoint
CREATE TABLE `wiki_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_id` text NOT NULL,
	`source_slug` text NOT NULL,
	`target_subject_id` text NOT NULL,
	`target_slug` text NOT NULL,
	`context` text DEFAULT '',
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE restrict
);
