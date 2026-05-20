CREATE TABLE `rundown_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`time_start` text NOT NULL,
	`clock_id` integer NOT NULL,
	`segment_index` integer NOT NULL,
	`media_id` integer,
	`notes` text,
	`assigned_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`clock_id`) REFERENCES `clocks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `rundown_assignments_date_idx` ON `rundown_assignments` (`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `rundown_assignments_slot_uniq` ON `rundown_assignments` (`date`,`time_start`,`clock_id`,`segment_index`);--> statement-breakpoint
CREATE TABLE `rundown_duration_overrides` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`time_start` text NOT NULL,
	`clock_id` integer NOT NULL,
	`segment_index` integer NOT NULL,
	`duration_seconds` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`clock_id`) REFERENCES `clocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rundown_duration_overrides_slot_uniq` ON `rundown_duration_overrides` (`date`,`time_start`,`clock_id`,`segment_index`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_clock_segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`clock_id` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`duration_seconds` integer NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`start_clip_playlist_id` integer,
	`end_clip_playlist_id` integer,
	`bed_playlist_id` integer,
	`interstitial_jingles_enabled` integer DEFAULT false NOT NULL,
	`jingle_every_n_tracks` integer,
	`interstitial_station_id_enabled` integer DEFAULT false NOT NULL,
	`station_id_every_n_tracks` integer,
	`start_policy` text DEFAULT '{"type":"flexible","late_seconds":null,"early_seconds":0}' NOT NULL,
	`trailing_time` text DEFAULT '[]' NOT NULL,
	`recovery_tactics` text DEFAULT '[]' NOT NULL,
	`can_skip` integer DEFAULT false NOT NULL,
	`can_fill` integer DEFAULT false NOT NULL,
	`can_reschedule` integer DEFAULT false NOT NULL,
	`catching_up_order` text DEFAULT '[]' NOT NULL,
	`coasting_order` text DEFAULT '[]' NOT NULL,
	`accept_live` integer DEFAULT true NOT NULL,
	`accept_sweepers` text DEFAULT '[]' NOT NULL,
	`sweeper_config` text,
	`silence_detection_action` text,
	`silence_threshold_seconds` integer,
	`rotation_type` text,
	`fallback_playlist_id` integer,
	FOREIGN KEY (`clock_id`) REFERENCES `clocks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`start_clip_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`end_clip_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`bed_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`fallback_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_clock_segments`("id", "clock_id", "sort_order", "name", "type", "duration_seconds", "sources", "start_clip_playlist_id", "end_clip_playlist_id", "bed_playlist_id", "interstitial_jingles_enabled", "jingle_every_n_tracks", "interstitial_station_id_enabled", "station_id_every_n_tracks", "start_policy", "trailing_time", "recovery_tactics", "can_skip", "can_fill", "can_reschedule", "catching_up_order", "coasting_order", "accept_live", "accept_sweepers", "sweeper_config", "silence_detection_action", "silence_threshold_seconds", "rotation_type", "fallback_playlist_id") SELECT "id", "clock_id", "sort_order", "name", "type", "duration_seconds", "sources", "start_clip_playlist_id", "end_clip_playlist_id", "bed_playlist_id", "interstitial_jingles_enabled", "jingle_every_n_tracks", "interstitial_station_id_enabled", "station_id_every_n_tracks", "start_policy", "trailing_time", "recovery_tactics", "can_skip", "can_fill", "can_reschedule", "catching_up_order", "coasting_order", "accept_live", "accept_sweepers", "sweeper_config", "silence_detection_action", "silence_threshold_seconds", "rotation_type", "fallback_playlist_id" FROM `clock_segments`;--> statement-breakpoint
DROP TABLE `clock_segments`;--> statement-breakpoint
ALTER TABLE `__new_clock_segments` RENAME TO `clock_segments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `clock_segments_clock_idx` ON `clock_segments` (`clock_id`);--> statement-breakpoint
CREATE INDEX `clock_segments_sort_idx` ON `clock_segments` (`clock_id`,`sort_order`);