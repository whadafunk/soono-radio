ALTER TABLE `media` ADD `source_sha256` text;--> statement-breakpoint
CREATE UNIQUE INDEX `media_source_sha256_unique` ON `media` (`source_sha256`);