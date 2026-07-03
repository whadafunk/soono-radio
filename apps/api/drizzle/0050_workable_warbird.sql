PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_shows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`host` text,
	`producer` text,
	`default_clock_id` integer,
	`jingle_playlist_id` integer,
	`bed_playlist_id` integer,
	`show_start_playlist_id` integer,
	`show_end_playlist_id` integer,
	`duration_minutes` integer DEFAULT 60 NOT NULL,
	`extension_policy` text,
	`color` text DEFAULT 'indigo' NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`default_clock_id`) REFERENCES `clocks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`jingle_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`bed_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`show_start_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`show_end_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_shows`("id", "name", "host", "producer", "default_clock_id", "jingle_playlist_id", "bed_playlist_id", "show_start_playlist_id", "show_end_playlist_id", "duration_minutes", "extension_policy", "color", "notes", "created_at", "updated_at") SELECT "id", "name", "host", "producer", "default_clock_id", "jingle_playlist_id", "bed_playlist_id", "show_start_playlist_id", "show_end_playlist_id", "duration_minutes", "extension_policy", "color", "notes", "created_at", "updated_at" FROM `shows`;--> statement-breakpoint
DROP TABLE `shows`;--> statement-breakpoint
ALTER TABLE `__new_shows` RENAME TO `shows`;--> statement-breakpoint
PRAGMA foreign_keys=ON;