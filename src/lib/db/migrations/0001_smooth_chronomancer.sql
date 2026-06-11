ALTER TABLE `magic_tokens` ADD `role` text DEFAULT 'student' NOT NULL;--> statement-breakpoint
-- Security: when this runs over the pre-Examify (blog) database, any
-- outstanding magic-link rows predate role-gating and would be backfilled as
-- `student` by the column default above. Since /signin/verify trusts the
-- token's role and does not re-check the allowlist, those legacy links could
-- mint a student session for a never-allowlisted address. Consume every
-- outstanding token so none survive the cutover. No-op on a fresh database.
UPDATE `magic_tokens` SET `consumed_at` = (unixepoch() * 1000) WHERE `consumed_at` IS NULL;