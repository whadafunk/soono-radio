ALTER TABLE `rotations` ADD `kind` text NOT NULL DEFAULT 'music';
--> statement-breakpoint
ALTER TABLE `rotations` ADD `song_position` text;
--> statement-breakpoint
ALTER TABLE `clocks` ADD `show_id` integer;
--> statement-breakpoint
ALTER TABLE `clocks` ADD `finish_policy` text NOT NULL DEFAULT 'finish_segment';
--> statement-breakpoint
ALTER TABLE `clocks` ADD `join_policy` text NOT NULL DEFAULT 'join_top';
--> statement-breakpoint
ALTER TABLE `clocks` ADD `overrun_policy` text NOT NULL DEFAULT 'loop_top';
