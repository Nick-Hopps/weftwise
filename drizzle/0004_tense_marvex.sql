CREATE TABLE `research_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`selected_candidate_ids_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`coordinator_job_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_approvals_run_unique` ON `research_approvals` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `research_approvals_id_run_unique` ON `research_approvals` (`id`,`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `research_approvals_run_idempotency_unique` ON `research_approvals` (`run_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `research_candidate_ingests` (
	`approval_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`run_id` text NOT NULL,
	`normalized_url` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source_id` text,
	`ingest_job_id` text,
	`operation_ids_json` text DEFAULT '[]' NOT NULL,
	`touched_pages_json` text DEFAULT '[]' NOT NULL,
	`commit_sha` text,
	`claim_token` text,
	`lease_expires_at` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`error_json` text,
	PRIMARY KEY(`approval_id`, `candidate_id`),
	FOREIGN KEY (`approval_id`,`run_id`) REFERENCES `research_approvals`(`id`,`run_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_id`,`run_id`) REFERENCES `research_candidates`(`id`,`run_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "research_candidate_ingests_status_check" CHECK("research_candidate_ingests"."status" IN ('pending','fetching','queued','running','completed','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_candidate_ingests_ingest_job_unique` ON `research_candidate_ingests` (`ingest_job_id`);--> statement-breakpoint
CREATE INDEX `research_candidate_ingests_status_lease_idx` ON `research_candidate_ingests` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `research_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`normalized_url` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`rank` integer NOT NULL,
	`decision` text DEFAULT 'pending' NOT NULL,
	`approval_id` text,
	`decided_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approval_id`,`run_id`) REFERENCES `research_approvals`(`id`,`run_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "research_candidates_decision_check" CHECK("research_candidates"."decision" IN ('pending','approved','rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_candidates_run_url_unique` ON `research_candidates` (`run_id`,`normalized_url`);--> statement-breakpoint
CREATE UNIQUE INDEX `research_candidates_id_run_unique` ON `research_candidates` (`id`,`run_id`);--> statement-breakpoint
CREATE INDEX `research_candidates_run_rank_idx` ON `research_candidates` (`run_id`,`rank`);--> statement-breakpoint
CREATE TABLE `research_run_findings` (
	`run_id` text NOT NULL,
	`finding_id` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`verified_at` text,
	`verification_snapshot_json` text,
	PRIMARY KEY(`run_id`, `finding_id`),
	FOREIGN KEY (`run_id`) REFERENCES `research_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "research_run_findings_verification_status_check" CHECK("research_run_findings"."verification_status" IN ('pending','fixed','residual','unverifiable'))
);
--> statement-breakpoint
CREATE TABLE `research_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`research_job_id` text NOT NULL,
	`origin` text NOT NULL,
	`lint_job_id` text,
	`topic` text,
	`topics_json` text DEFAULT '[]' NOT NULL,
	`queries_json` text DEFAULT '[]' NOT NULL,
	`candidate_set_hash` text NOT NULL,
	`status` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`verification_lint_job_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`error_json` text,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "research_runs_origin_check" CHECK("research_runs"."origin" IN ('findings','topic')),
	CONSTRAINT "research_runs_status_check" CHECK("research_runs"."status" IN ('awaiting-approval','importing','verifying','completed','partial','failed','dismissed','empty'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_runs_research_job_id_unique` ON `research_runs` (`research_job_id`);--> statement-breakpoint
CREATE INDEX `research_runs_subject_status_updated_idx` ON `research_runs` (`subject_id`,`status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `subjects` ADD `maintenance_state` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `subjects` ADD `mutation_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE `source_dedup_cleanup` (
	`loser_id` text PRIMARY KEY NOT NULL,
	`winner_id` text NOT NULL,
	`subject_slug` text NOT NULL,
	`filename` text NOT NULL
);--> statement-breakpoint
INSERT INTO `source_dedup_cleanup` (`loser_id`, `winner_id`, `subject_slug`, `filename`)
SELECT loser.id, winner.id, subject.slug, loser.filename
FROM sources loser
JOIN sources winner
  ON winner.subject_id = loser.subject_id
 AND winner.content_hash = loser.content_hash
 AND winner.filename = loser.filename
 AND winner.id = (
   SELECT MIN(candidate.id)
   FROM sources candidate
   WHERE candidate.subject_id = loser.subject_id
     AND candidate.content_hash = loser.content_hash
     AND candidate.filename = loser.filename
 )
JOIN subjects subject ON subject.id = loser.subject_id
WHERE loser.id != winner.id;--> statement-breakpoint
INSERT OR IGNORE INTO page_sources (subject_id, page_slug, source_id)
SELECT page_sources.subject_id, page_sources.page_slug, cleanup.winner_id
FROM page_sources
JOIN source_dedup_cleanup cleanup ON cleanup.loser_id = page_sources.source_id;--> statement-breakpoint
DELETE FROM page_sources
WHERE source_id IN (SELECT loser_id FROM source_dedup_cleanup);--> statement-breakpoint
UPDATE jobs
SET params_json = json_set(
  params_json,
  '$.sourceId',
  (SELECT winner_id FROM source_dedup_cleanup WHERE loser_id = json_extract(jobs.params_json, '$.sourceId'))
)
WHERE json_valid(params_json)
  AND json_extract(params_json, '$.sourceId') IN (SELECT loser_id FROM source_dedup_cleanup);--> statement-breakpoint
DELETE FROM sources
WHERE id IN (SELECT loser_id FROM source_dedup_cleanup);--> statement-breakpoint
CREATE UNIQUE INDEX `sources_subject_hash_filename_unique` ON `sources` (`subject_id`,`content_hash`,`filename`);
