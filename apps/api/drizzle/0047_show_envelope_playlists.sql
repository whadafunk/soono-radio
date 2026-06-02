ALTER TABLE `shows` ADD `show_start_playlist_id` integer REFERENCES playlists(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `shows` ADD `show_end_playlist_id` integer REFERENCES playlists(id) ON DELETE SET NULL;
