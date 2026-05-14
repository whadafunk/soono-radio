DROP INDEX IF EXISTS `shows_active_idx`;
--> statement-breakpoint
ALTER TABLE `shows` DROP COLUMN `type`;
--> statement-breakpoint
ALTER TABLE `shows` DROP COLUMN `active`;
--> statement-breakpoint
ALTER TABLE `shows` ADD `jingle_playlist_id` integer REFERENCES `playlists`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `shows` ADD `bed_playlist_id` integer REFERENCES `playlists`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `show_playlists` ADD `weight` integer NOT NULL DEFAULT 1;
