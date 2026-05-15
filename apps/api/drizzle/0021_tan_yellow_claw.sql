CREATE TABLE `broadcast_intervals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#818cf8' NOT NULL,
	`day_of_week` integer NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `interval_id` integer REFERENCES broadcast_intervals(id);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `interval_plays_per_week` integer;