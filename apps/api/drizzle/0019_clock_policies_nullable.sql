PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_clocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`show_id` integer,
	`sweep_config` text,
	`station_id_playlist_id` integer,
	`jingle_playlist_id` integer,
	`finish_policy` text,
	`join_policy` text,
	`overrun_policy` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_clocks`
SELECT `id`, `name`, `description`, `show_id`, `sweep_config`,
       `station_id_playlist_id`, `jingle_playlist_id`,
       NULL, NULL, NULL,
       `created_at`, `updated_at`
FROM `clocks`;
--> statement-breakpoint
DROP TABLE `clocks`;
--> statement-breakpoint
ALTER TABLE `__new_clocks` RENAME TO `clocks`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
