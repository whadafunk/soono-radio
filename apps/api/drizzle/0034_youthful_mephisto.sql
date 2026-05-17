CREATE TABLE `music_campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` integer NOT NULL,
	`name` text NOT NULL,
	`playlist_id` integer NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`plays_per_day` integer NOT NULL,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `music_campaigns_customer_idx` ON `music_campaigns` (`customer_id`);--> statement-breakpoint
CREATE INDEX `music_campaigns_active_idx` ON `music_campaigns` (`active`);--> statement-breakpoint
ALTER TABLE `play_history` ADD `music_campaign_id` integer REFERENCES music_campaigns(id);--> statement-breakpoint
CREATE INDEX `play_history_music_campaign_idx` ON `play_history` (`music_campaign_id`);--> statement-breakpoint
ALTER TABLE `rotations` ADD `heavy_rotation_enabled` integer DEFAULT false NOT NULL;