-- clock_segments v3:
-- - Types: stop_set (was ad_block), voice_track (was short_news), added bulletin
-- - sources JSON array replaces source_type/source_playlist_id/source_rotation_id/source_tier
-- - trailing_time JSON array replaces end_policy (gap management strategies)

PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `clock_segments_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `clock_id` integer NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `name` text NOT NULL,
  `type` text NOT NULL,
  `duration_seconds` integer NOT NULL,
  `sources` text DEFAULT '[]' NOT NULL,
  `filler_playlist_id` integer,
  `start_clip_playlist_id` integer,
  `end_clip_playlist_id` integer,
  `bed_playlist_id` integer,
  `start_policy` text DEFAULT '{"type":"soft","plus_seconds":30,"minus_seconds":0}' NOT NULL,
  `trailing_time` text DEFAULT '[]' NOT NULL,
  `recovery_tactics` text DEFAULT '[]' NOT NULL,
  `accept_live` integer DEFAULT true NOT NULL,
  `accept_sweepers` text DEFAULT '[]' NOT NULL,
  `silence_detection_action` text,
  FOREIGN KEY (`clock_id`) REFERENCES `clocks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`filler_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`start_clip_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`end_clip_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`bed_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
DROP TABLE `clock_segments`;
--> statement-breakpoint
ALTER TABLE `clock_segments_new` RENAME TO `clock_segments`;
--> statement-breakpoint
CREATE INDEX `clock_segments_clock_idx` ON `clock_segments` (`clock_id`);
--> statement-breakpoint
CREATE INDEX `clock_segments_sort_idx` ON `clock_segments` (`clock_id`,`sort_order`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
