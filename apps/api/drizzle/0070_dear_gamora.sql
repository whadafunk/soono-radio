CREATE TABLE `recording_flags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`flag` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recording_flags_name_flag` ON `recording_flags` (`name`,`flag`);--> statement-breakpoint
DROP TABLE `recording_holds`;