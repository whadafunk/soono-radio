-- Recreate clock_segments with new schema:
--   - New segment types: music, live, live_audience, ad_block, news, short_news
--   - delay_policy → start_policy + end_policy
--   - blocks_live_override → accept_live (inverted)
--   - filler_sources/mix_ratio/fallback_source → filler_playlist_id
--   - Added: accept_sweepers, silence_detection_action

PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `clock_segments_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `clock_id` integer NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `name` text NOT NULL,
  `type` text NOT NULL,
  `duration_seconds` integer NOT NULL,
  `source_type` text NOT NULL,
  `source_playlist_id` integer,
  `source_rotation_id` integer,
  `source_tier` text,
  `filler_playlist_id` integer,
  `start_clip_playlist_id` integer,
  `end_clip_playlist_id` integer,
  `bed_playlist_id` integer,
  `start_policy` text DEFAULT '{"type":"soft","plus_seconds":30,"minus_seconds":0}' NOT NULL,
  `end_policy` text DEFAULT 'flexible' NOT NULL,
  `recovery_tactics` text DEFAULT '[]' NOT NULL,
  `accept_live` integer DEFAULT true NOT NULL,
  `accept_sweepers` text DEFAULT '[]' NOT NULL,
  `silence_detection_action` text,
  FOREIGN KEY (`clock_id`) REFERENCES `clocks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`source_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`source_rotation_id`) REFERENCES `rotations`(`id`) ON UPDATE no action ON DELETE set null,
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
