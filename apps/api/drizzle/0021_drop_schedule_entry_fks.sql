-- Remove FK constraints from template_entries and calendar_entries show_id/clock_id.
-- Schedule slots intentionally keep stale IDs when a show or clock is deleted so
-- the UI can display them as orphaned rather than silently clearing them.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_template_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_of_week` integer NOT NULL,
	`time_start` text NOT NULL,
	`time_end` text NOT NULL,
	`show_id` integer,
	`clock_id` integer
);
--> statement-breakpoint
INSERT INTO `__new_template_entries` SELECT `id`,`day_of_week`,`time_start`,`time_end`,`show_id`,`clock_id` FROM `template_entries`;
--> statement-breakpoint
DROP TABLE `template_entries`;
--> statement-breakpoint
ALTER TABLE `__new_template_entries` RENAME TO `template_entries`;
--> statement-breakpoint
CREATE INDEX `template_entries_dow_idx` ON `template_entries` (`day_of_week`);
--> statement-breakpoint
CREATE TABLE `__new_calendar_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`time_start` text NOT NULL,
	`time_end` text NOT NULL,
	`show_id` integer,
	`clock_id` integer,
	`is_override` integer NOT NULL DEFAULT false
);
--> statement-breakpoint
INSERT INTO `__new_calendar_entries` SELECT `id`,`date`,`time_start`,`time_end`,`show_id`,`clock_id`,`is_override` FROM `calendar_entries`;
--> statement-breakpoint
DROP TABLE `calendar_entries`;
--> statement-breakpoint
ALTER TABLE `__new_calendar_entries` RENAME TO `calendar_entries`;
--> statement-breakpoint
CREATE INDEX `calendar_entries_date_idx` ON `calendar_entries` (`date`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
