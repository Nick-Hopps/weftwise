CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ingest_checkpoints` (
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`data_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`job_id`, `kind`, `key`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`citations_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `page_embeddings` (
	`subject_id` text NOT NULL,
	`slug` text NOT NULL,
	`model` text NOT NULL,
	`content_hash` text NOT NULL,
	`dim` integer NOT NULL,
	`vector` blob NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`subject_id`, `slug`),
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `page_maturity` (
	`subject_id` text NOT NULL,
	`slug` text NOT NULL,
	`passes` integer DEFAULT 0 NOT NULL,
	`last_enriched_at` text,
	`interval_days` integer DEFAULT 1 NOT NULL,
	`next_due_at` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`subject_id`, `slug`),
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `page_renditions` (
	`subject_id` text NOT NULL,
	`slug` text NOT NULL,
	`canonical_hash` text NOT NULL,
	`profile_version` integer NOT NULL,
	`rendered_md` text NOT NULL,
	`model` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`subject_id`, `slug`)
);
--> statement-breakpoint
CREATE TABLE `profile_signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`subject_id` text,
	`slug` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`background_summary` text DEFAULT '' NOT NULL,
	`style_prefs` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`onboarded_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `subjects` ADD `augmentation_level` text DEFAULT 'standard' NOT NULL;