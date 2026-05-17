ALTER TABLE `rotations` ADD `hot_play_playlist_id` integer REFERENCES playlists(id);--> statement-breakpoint
ALTER TABLE `rotations` ADD `hot_play_every_n_tracks` integer;