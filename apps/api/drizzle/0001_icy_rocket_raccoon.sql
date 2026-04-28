CREATE TABLE `play_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_id` integer,
	`source` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`ended_at` integer,
	`aborted` integer DEFAULT false NOT NULL,
	`live_listener_count` integer,
	`pick_reason` text,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `play_history_started_at_idx` ON `play_history` (`started_at`);--> statement-breakpoint
CREATE INDEX `play_history_media_id_idx` ON `play_history` (`media_id`);--> statement-breakpoint
CREATE INDEX `play_history_source_idx` ON `play_history` (`source`);