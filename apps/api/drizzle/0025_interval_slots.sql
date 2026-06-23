CREATE TABLE `broadcast_intervals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#818cf8' NOT NULL,
	`default_start_time` text DEFAULT '06:00' NOT NULL,
	`default_end_time` text DEFAULT '09:00' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `broadcast_interval_slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`interval_id` integer NOT NULL,
	`day_of_week` integer NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`interval_id`) REFERENCES `broadcast_intervals`(`id`) ON DELETE cascade,
	CONSTRAINT `interval_slot_day_uniq` UNIQUE(`interval_id`, `day_of_week`)
);
