ALTER TABLE `campaign_media` ADD `weight` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `total_plays` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `min_gap_minutes` integer;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `pacing_mode` text DEFAULT 'even' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `catch_up_factor` real;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `allowed_interval_ids` text;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `interval_plays_per_day` integer;--> statement-breakpoint
ALTER TABLE `station_settings` ADD `default_allowed_interval_ids` text;--> statement-breakpoint
ALTER TABLE `station_settings` ADD `default_catch_up_factor` real DEFAULT 2 NOT NULL;