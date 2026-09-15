ALTER TABLE `households` ADD `onboarding_complete` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `households` ADD `onboarding_state` text;--> statement-breakpoint
UPDATE `households` SET `onboarding_complete` = 1;
