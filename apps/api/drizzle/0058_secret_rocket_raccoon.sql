ALTER TABLE `plans` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `station_settings` ADD `reality_check_interval_seconds` real DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `supervisor_state` ADD `ls_pid` integer;