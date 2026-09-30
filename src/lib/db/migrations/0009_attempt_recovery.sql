ALTER TABLE `exam_attempts` ADD `submission_id` text;--> statement-breakpoint
ALTER TABLE `exam_attempts` ADD `submission_hash` text;--> statement-breakpoint
ALTER TABLE `exam_attempts` ADD `grading_tasks` text;--> statement-breakpoint
ALTER TABLE `exam_attempts` ADD `grading_lease` text;--> statement-breakpoint
ALTER TABLE `exam_attempts` ADD `grading_lease_until` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `exam_attempts_user_submission_unique` ON `exam_attempts` (`user_id`,`submission_id`);--> statement-breakpoint
ALTER TABLE `exam_sessions` ADD `submission_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `session_version` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `exam_sessions` SET `submission_id` = lower(hex(randomblob(16))) WHERE `submission_id` = '';
