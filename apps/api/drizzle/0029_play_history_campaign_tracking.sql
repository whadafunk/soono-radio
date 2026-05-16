ALTER TABLE `play_history` ADD `campaign_id` integer REFERENCES campaigns(id);--> statement-breakpoint
ALTER TABLE `play_history` ADD `promo_id` integer REFERENCES promos(id);--> statement-breakpoint
ALTER TABLE `play_history` ADD `clock_segment_id` integer REFERENCES clock_segments(id);--> statement-breakpoint
ALTER TABLE `play_history` ADD `stop_set_position` integer;
