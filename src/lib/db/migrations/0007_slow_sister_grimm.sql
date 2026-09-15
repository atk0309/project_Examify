ALTER TABLE `households` ADD `setup_wizard_completed_at` integer;--> statement-breakpoint
ALTER TABLE `households` ADD `setup_wizard_state` text;--> statement-breakpoint
UPDATE `households` SET `setup_wizard_completed_at` = `created_at` WHERE `setup_wizard_completed_at` IS NULL;