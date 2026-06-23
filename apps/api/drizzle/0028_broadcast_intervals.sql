ALTER TABLE `campaigns` ADD `interval_id` integer REFERENCES broadcast_intervals(id);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `interval_plays_per_week` integer;
