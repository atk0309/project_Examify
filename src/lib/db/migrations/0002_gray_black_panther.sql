CREATE TABLE `exam_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`subject` text NOT NULL,
	`difficulty` text NOT NULL,
	`total` integer NOT NULL,
	`correct` integer NOT NULL,
	`score_pct` integer NOT NULL,
	`items` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `exam_attempts_user_created_idx` ON `exam_attempts` (`user_id`,`created_at`);