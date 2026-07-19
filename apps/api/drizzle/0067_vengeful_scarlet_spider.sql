PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` integer NOT NULL,
	`name` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`total_plays` integer DEFAULT 0 NOT NULL,
	`duration_bracket` integer,
	`max_plays_per_day` integer,
	`min_gap_minutes` integer,
	`pacing_mode` text DEFAULT 'even' NOT NULL,
	`catch_up_factor` real,
	`allowed_interval_ids` text,
	`sweeps_per_month` integer,
	`max_sweeps_per_day` integer,
	`advertiser_separation_spots` integer DEFAULT 1 NOT NULL,
	`competing_exclusions` text DEFAULT '[]' NOT NULL,
	`show_id` integer,
	`plays_per_show` integer,
	`interval_id` integer,
	`interval_plays_per_day` integer,
	`first_in_slot` integer DEFAULT false NOT NULL,
	`first_in_slot_mode` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`interval_id`) REFERENCES `broadcast_intervals`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_campaigns`("id", "customer_id", "name", "starts_on", "ends_on", "total_plays", "duration_bracket", "max_plays_per_day", "min_gap_minutes", "pacing_mode", "catch_up_factor", "allowed_interval_ids", "sweeps_per_month", "max_sweeps_per_day", "advertiser_separation_spots", "competing_exclusions", "show_id", "plays_per_show", "interval_id", "interval_plays_per_day", "first_in_slot", "first_in_slot_mode", "notes", "active", "created_at", "updated_at") SELECT "id", "customer_id", "name", "starts_on", "ends_on", "total_plays", "duration_bracket", "max_plays_per_day", "min_gap_minutes", "pacing_mode", "catch_up_factor", "allowed_interval_ids", "sweeps_per_month", "max_sweeps_per_day", "advertiser_separation_spots", "competing_exclusions", "show_id", "plays_per_show", "interval_id", "interval_plays_per_day", "first_in_slot", "first_in_slot_mode", "notes", "active", "created_at", "updated_at" FROM `campaigns`;--> statement-breakpoint
DROP TABLE `campaigns`;--> statement-breakpoint
ALTER TABLE `__new_campaigns` RENAME TO `campaigns`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `campaigns_customer_idx` ON `campaigns` (`customer_id`);--> statement-breakpoint
CREATE INDEX `campaigns_active_idx` ON `campaigns` (`active`);--> statement-breakpoint
CREATE INDEX `campaigns_show_idx` ON `campaigns` (`show_id`);