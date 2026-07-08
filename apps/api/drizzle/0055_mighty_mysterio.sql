-- Same class of bug fixed in 0053/0054: `ALTER TABLE ... ADD COLUMN ...
-- REFERENCES` never carries an ON DELETE clause. station_settings.default_clock_id
-- (Decision 53) needs ON DELETE set null so deleting the configured default
-- clock clears the setting instead of blocking the delete.
PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE `__new_station_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`promo_margin` real DEFAULT 0.1 NOT NULL,
	`default_clock_id` integer,
	FOREIGN KEY (`default_clock_id`) REFERENCES `clocks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_station_settings`("id", "promo_margin")
SELECT "id", "promo_margin" FROM `station_settings`;
--> statement-breakpoint
DROP TABLE `station_settings`;--> statement-breakpoint
ALTER TABLE `__new_station_settings` RENAME TO `station_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
