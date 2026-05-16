CREATE TABLE `promo_media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`promo_id` integer NOT NULL,
	`media_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`promo_id`) REFERENCES `promos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `promo_media_promo_idx` ON `promo_media` (`promo_id`);--> statement-breakpoint
CREATE TABLE `promos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`show_id` integer,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`min_plays_per_day` integer DEFAULT 1 NOT NULL,
	`max_plays_per_day` integer DEFAULT 3 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `promos_show_idx` ON `promos` (`show_id`);--> statement-breakpoint
CREATE INDEX `promos_active_idx` ON `promos` (`active`);--> statement-breakpoint
CREATE UNIQUE INDEX `interval_slot_day_uniq` ON `broadcast_interval_slots` (`interval_id`,`day_of_week`);