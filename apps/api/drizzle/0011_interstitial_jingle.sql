-- Add interstitial jingle support to clock_segments:
-- - interstitial_jingle_playlist_id: playlist of short jingles to insert between tracks
-- - jingle_every_n_tracks: how often to insert one (null = disabled, music segments only)

ALTER TABLE `clock_segments` ADD COLUMN `interstitial_jingle_playlist_id` integer REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `clock_segments` ADD COLUMN `jingle_every_n_tracks` integer;
