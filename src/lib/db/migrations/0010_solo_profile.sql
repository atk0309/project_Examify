CREATE TABLE `solo_profiles` (
  `id` integer PRIMARY KEY NOT NULL,
  `user_id` integer NOT NULL REFERENCES `users`(`id`),
  `household_id` integer NOT NULL REFERENCES `households`(`id`),
  `launch_key_hash` text NOT NULL,
  CONSTRAINT `solo_profiles_singleton` CHECK (`id` = 1)
);
--> statement-breakpoint
CREATE TABLE `solo_launch_tokens` (
  `token_hash` text PRIMARY KEY NOT NULL
);
