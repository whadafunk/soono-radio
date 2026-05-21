CREATE TABLE `rundown_playback_cursors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`time_start` text NOT NULL,
	`clock_id` integer NOT NULL,
	`segment_type` text NOT NULL,
	`next_track_index` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`clock_id`) REFERENCES `clocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rundown_playback_cursors_slot_uniq` ON `rundown_playback_cursors` (`date`,`time_start`,`clock_id`,`segment_type`);--> statement-breakpoint
CREATE TABLE `rundown_show_content` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`time_start` text NOT NULL,
	`clock_id` integer NOT NULL,
	`segment_type` text NOT NULL,
	`playlist_id` integer,
	`assigned_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`clock_id`) REFERENCES `clocks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `rundown_show_content_date_idx` ON `rundown_show_content` (`date`,`clock_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `rundown_show_content_slot_uniq` ON `rundown_show_content` (`date`,`time_start`,`clock_id`,`segment_type`);