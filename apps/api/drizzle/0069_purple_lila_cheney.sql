CREATE TABLE `recording_holds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_ms` integer NOT NULL,
	`to_ms` integer NOT NULL,
	`note` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `station_air_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at_ms` integer NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `station_air_events_at_idx` ON `station_air_events` (`at_ms`);