ALTER TABLE `campaigns` ADD `show_id` integer REFERENCES shows(id);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `plays_per_show` integer;--> statement-breakpoint
CREATE INDEX `campaigns_show_idx` ON `campaigns` (`show_id`);