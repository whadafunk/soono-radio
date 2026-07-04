-- Migrations 0029/0034/0044 added campaign_id, promo_id, clock_segment_id, and
-- music_campaign_id to play_history via `ALTER TABLE ... ADD COLUMN ... REFERENCES`.
-- SQLite's ADD COLUMN form doesn't carry an ON DELETE clause, so despite
-- schema.ts always declaring `onDelete: 'set null'` for these, the live FKs
-- silently defaulted to NO ACTION. That blocks deleting any clock_segments
-- row (and cascading from campaigns/promos/music_campaigns) once a play has
-- ever been logged against it — exactly the segment-edit 500 this fixes.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_play_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_id` integer,
	`source` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`ended_at` integer,
	`aborted` integer DEFAULT false NOT NULL,
	`live_listener_count` integer,
	`pick_reason` text,
	`campaign_id` integer,
	`promo_id` integer,
	`clock_segment_id` integer,
	`stop_set_position` integer,
	`music_campaign_id` integer,
	`plan_item_id` integer,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`promo_id`) REFERENCES `promos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`clock_segment_id`) REFERENCES `clock_segments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`music_campaign_id`) REFERENCES `music_campaigns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_play_history`("id", "media_id", "source", "started_at", "ended_at", "aborted", "live_listener_count", "pick_reason", "campaign_id", "promo_id", "clock_segment_id", "stop_set_position", "music_campaign_id", "plan_item_id")
SELECT "id", "media_id", "source", "started_at", "ended_at", "aborted", "live_listener_count", "pick_reason", "campaign_id", "promo_id", "clock_segment_id", "stop_set_position", "music_campaign_id", "plan_item_id" FROM `play_history`;
--> statement-breakpoint
DROP TABLE `play_history`;--> statement-breakpoint
ALTER TABLE `__new_play_history` RENAME TO `play_history`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `play_history_started_at_idx` ON `play_history` (`started_at`);--> statement-breakpoint
CREATE INDEX `play_history_media_id_idx` ON `play_history` (`media_id`);--> statement-breakpoint
CREATE INDEX `play_history_source_idx` ON `play_history` (`source`);--> statement-breakpoint
CREATE INDEX `play_history_campaign_idx` ON `play_history` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `play_history_music_campaign_idx` ON `play_history` (`music_campaign_id`);--> statement-breakpoint
CREATE INDEX `play_history_plan_item_idx` ON `play_history` (`plan_item_id`);
