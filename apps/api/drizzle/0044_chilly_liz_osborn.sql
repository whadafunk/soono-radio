CREATE TABLE `live_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`segment_id` integer,
	`plan_id` integer,
	FOREIGN KEY (`segment_id`) REFERENCES `clock_segments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `live_events_started_at_idx` ON `live_events` (`started_at`);--> statement-breakpoint
CREATE TABLE `plan_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` integer NOT NULL,
	`position` integer NOT NULL,
	`media_id` integer NOT NULL,
	`content_type` text NOT NULL,
	`campaign_id` integer,
	`music_campaign_id` integer,
	`planned_duration_seconds` real NOT NULL,
	`mandatory` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text NOT NULL,
	`play_history_id` integer,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`music_campaign_id`) REFERENCES `music_campaigns`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`play_history_id`) REFERENCES `play_history`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `plan_items_plan_idx` ON `plan_items` (`plan_id`);--> statement-breakpoint
CREATE INDEX `plan_items_position_idx` ON `plan_items` (`plan_id`,`position`);--> statement-breakpoint
CREATE INDEX `plan_items_status_idx` ON `plan_items` (`status`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`segment_id` integer NOT NULL,
	`clock_instance_started_at` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`finalized_at` integer,
	FOREIGN KEY (`segment_id`) REFERENCES `clock_segments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plans_segment_idx` ON `plans` (`segment_id`);--> statement-breakpoint
CREATE INDEX `plans_status_idx` ON `plans` (`status`);--> statement-breakpoint
CREATE TABLE `stop_set_estimates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` integer NOT NULL,
	`segment_id` integer NOT NULL,
	`computed_at` integer NOT NULL,
	`break_duration_seconds` real NOT NULL,
	`hard_claimed_seconds` real NOT NULL,
	`contested_seconds` real NOT NULL,
	`free_seconds` real NOT NULL,
	`occupation_ratio` real NOT NULL,
	`oversubscribed` integer NOT NULL,
	`candidate_count` integer NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`segment_id`) REFERENCES `clock_segments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stop_set_estimates_plan_id_unique` ON `stop_set_estimates` (`plan_id`);--> statement-breakpoint
CREATE INDEX `stop_set_estimates_segment_idx` ON `stop_set_estimates` (`segment_id`);--> statement-breakpoint
CREATE INDEX `stop_set_estimates_oversubscribed_idx` ON `stop_set_estimates` (`oversubscribed`);--> statement-breakpoint
CREATE TABLE `supervisor_state` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`current_segment_id` integer,
	`current_drift_seconds` real DEFAULT 0 NOT NULL,
	`last_heartbeat_at` integer,
	`active_plan_id` integer,
	FOREIGN KEY (`current_segment_id`) REFERENCES `clock_segments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`active_plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `play_history` ADD `plan_item_id` integer;--> statement-breakpoint
CREATE INDEX `play_history_plan_item_idx` ON `play_history` (`plan_item_id`);