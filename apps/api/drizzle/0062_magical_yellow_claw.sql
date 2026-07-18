ALTER TABLE `clock_segments` ADD `start_clip_media_id` integer;--> statement-breakpoint
ALTER TABLE `clock_segments` ADD `end_clip_media_id` integer;--> statement-breakpoint
ALTER TABLE `shows` ADD `show_start_media_id` integer;--> statement-breakpoint
ALTER TABLE `shows` ADD `show_end_media_id` integer;