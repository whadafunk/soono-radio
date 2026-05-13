-- Add audio analysis columns to media table

ALTER TABLE `media` ADD COLUMN `bpm` real;
--> statement-breakpoint
ALTER TABLE `media` ADD COLUMN `musical_key` text;
--> statement-breakpoint
ALTER TABLE `media` ADD COLUMN `key_scale` text;
--> statement-breakpoint
ALTER TABLE `media` ADD COLUMN `mood_tags` text;
--> statement-breakpoint
ALTER TABLE `media` ADD COLUMN `energy` real;
--> statement-breakpoint
ALTER TABLE `media` ADD COLUMN `danceability` real;
--> statement-breakpoint
ALTER TABLE `media` ADD COLUMN `analysis_status` text;
--> statement-breakpoint
ALTER TABLE `media` ADD COLUMN `analysis_error` text;
