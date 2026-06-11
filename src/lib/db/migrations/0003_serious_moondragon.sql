CREATE TABLE `exam_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`subject` text NOT NULL,
	`difficulty` text NOT NULL,
	`question_ids` text NOT NULL,
	`answers` text NOT NULL,
	`current_index` integer DEFAULT 0 NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exam_sessions_user_subject_diff_unique` ON `exam_sessions` (`user_id`,`subject`,`difficulty`);