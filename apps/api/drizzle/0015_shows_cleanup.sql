ALTER TABLE `shows` ADD `jingle_playlist_id` integer REFERENCES `playlists`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `shows` ADD `bed_playlist_id` integer REFERENCES `playlists`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `show_playlists` ADD `weight` integer NOT NULL DEFAULT 1;
