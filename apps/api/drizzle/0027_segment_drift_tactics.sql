ALTER TABLE `clock_segments` ADD `can_skip` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `clock_segments` ADD `can_fill` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `clock_segments` ADD `can_reschedule` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `clock_segments` ADD `catching_up_order` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `clock_segments` ADD `coasting_order` text NOT NULL DEFAULT '[]';
