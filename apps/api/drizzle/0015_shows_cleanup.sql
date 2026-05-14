DROP INDEX IF EXISTS `shows_active_idx`;
ALTER TABLE `shows` DROP COLUMN `type`;
ALTER TABLE `shows` DROP COLUMN `active`;
ALTER TABLE `shows` ADD `jingle_playlist_id` integer REFERENCES `playlists`(`id`) ON DELETE SET NULL;
ALTER TABLE `shows` ADD `bed_playlist_id` integer REFERENCES `playlists`(`id`) ON DELETE SET NULL;
ALTER TABLE `show_playlists` ADD `weight` integer NOT NULL DEFAULT 1;
