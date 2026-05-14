ALTER TABLE `clocks` ADD `station_id_playlist_id` integer;
--> statement-breakpoint
ALTER TABLE `clocks` ADD `jingle_playlist_id` integer;
--> statement-breakpoint
ALTER TABLE `clock_segments` ADD `sweeper_config` text;
