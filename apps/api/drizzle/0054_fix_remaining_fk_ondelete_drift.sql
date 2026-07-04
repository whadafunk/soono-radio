-- Same class of bug fixed in 0053 for play_history: columns added later via
-- `ALTER TABLE ... ADD COLUMN ... REFERENCES` never got the ON DELETE clause
-- schema.ts declares, because SQLite's ADD COLUMN form doesn't carry it and
-- drizzle-kit's snapshot already (incorrectly) believed it was applied.
-- Full schema sweep (2026-07-04) found three more: campaigns.show_id,
-- campaigns.interval_id, rotations.hot_play_playlist_id, and
-- supervisor_state.next_plan_id. All four should be ON DELETE set null.
PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE `__new_campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` integer NOT NULL,
	`name` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`plays_per_month` integer NOT NULL,
	`max_plays_per_day` integer,
	`sweeps_per_month` integer,
	`max_sweeps_per_day` integer,
	`time_window_start` text,
	`time_window_end` text,
	`days_of_week` text,
	`advertiser_separation_spots` integer DEFAULT 1 NOT NULL,
	`competing_exclusions` text DEFAULT '[]' NOT NULL,
	`priority` text DEFAULT 'best_effort' NOT NULL,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`first_in_slot` integer DEFAULT 0 NOT NULL,
	`first_in_slot_mode` text,
	`show_id` integer,
	`plays_per_show` integer,
	`interval_id` integer,
	`interval_plays_per_week` integer,
	`duration_bracket` integer DEFAULT 30 NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`interval_id`) REFERENCES `broadcast_intervals`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_campaigns`("id", "customer_id", "name", "starts_on", "ends_on", "plays_per_month", "max_plays_per_day", "sweeps_per_month", "max_sweeps_per_day", "time_window_start", "time_window_end", "days_of_week", "advertiser_separation_spots", "competing_exclusions", "priority", "notes", "active", "created_at", "updated_at", "first_in_slot", "first_in_slot_mode", "show_id", "plays_per_show", "interval_id", "interval_plays_per_week", "duration_bracket")
SELECT "id", "customer_id", "name", "starts_on", "ends_on", "plays_per_month", "max_plays_per_day", "sweeps_per_month", "max_sweeps_per_day", "time_window_start", "time_window_end", "days_of_week", "advertiser_separation_spots", "competing_exclusions", "priority", "notes", "active", "created_at", "updated_at", "first_in_slot", "first_in_slot_mode", "show_id", "plays_per_show", "interval_id", "interval_plays_per_week", "duration_bracket" FROM `campaigns`;
--> statement-breakpoint
DROP TABLE `campaigns`;--> statement-breakpoint
ALTER TABLE `__new_campaigns` RENAME TO `campaigns`;--> statement-breakpoint
CREATE INDEX `campaigns_customer_idx` ON `campaigns` (`customer_id`);--> statement-breakpoint
CREATE INDEX `campaigns_active_idx` ON `campaigns` (`active`);--> statement-breakpoint
CREATE INDEX `campaigns_show_idx` ON `campaigns` (`show_id`);--> statement-breakpoint

CREATE TABLE `__new_rotations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`kind` text DEFAULT 'music' NOT NULL,
	`song_position` text,
	`is_default` integer DEFAULT 0 NOT NULL,
	`hot_play_playlist_id` integer,
	`hot_play_every_n_tracks` integer,
	`heavy_rotation_enabled` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`hot_play_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_rotations`("id", "name", "type", "params", "created_at", "updated_at", "kind", "song_position", "is_default", "hot_play_playlist_id", "hot_play_every_n_tracks", "heavy_rotation_enabled")
SELECT "id", "name", "type", "params", "created_at", "updated_at", "kind", "song_position", "is_default", "hot_play_playlist_id", "hot_play_every_n_tracks", "heavy_rotation_enabled" FROM `rotations`;
--> statement-breakpoint
DROP TABLE `rotations`;--> statement-breakpoint
ALTER TABLE `__new_rotations` RENAME TO `rotations`;--> statement-breakpoint

CREATE TABLE `__new_supervisor_state` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`current_segment_id` integer,
	`current_drift_seconds` real DEFAULT 0 NOT NULL,
	`last_heartbeat_at` integer,
	`active_plan_id` integer,
	`paused` integer DEFAULT false NOT NULL,
	`next_plan_id` integer,
	`next_plan_draft_drift_seconds` real,
	`next_plan_drift_delta_seconds` real,
	`intentional_offset_seconds` real DEFAULT 0 NOT NULL,
	`planned_overshoot_seconds` real DEFAULT 0 NOT NULL,
	`boundary_drift_seconds` real,
	FOREIGN KEY (`current_segment_id`) REFERENCES `clock_segments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`active_plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`next_plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_supervisor_state`("id", "current_segment_id", "current_drift_seconds", "last_heartbeat_at", "active_plan_id", "paused", "next_plan_id", "next_plan_draft_drift_seconds", "next_plan_drift_delta_seconds", "intentional_offset_seconds", "planned_overshoot_seconds", "boundary_drift_seconds")
SELECT "id", "current_segment_id", "current_drift_seconds", "last_heartbeat_at", "active_plan_id", "paused", "next_plan_id", "next_plan_draft_drift_seconds", "next_plan_drift_delta_seconds", "intentional_offset_seconds", "planned_overshoot_seconds", "boundary_drift_seconds" FROM `supervisor_state`;
--> statement-breakpoint
DROP TABLE `supervisor_state`;--> statement-breakpoint
ALTER TABLE `__new_supervisor_state` RENAME TO `supervisor_state`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
