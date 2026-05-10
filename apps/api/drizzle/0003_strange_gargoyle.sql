CREATE TABLE `calendar_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`time_start` text NOT NULL,
	`time_end` text NOT NULL,
	`show_id` integer,
	`clock_id` integer,
	`is_override` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`clock_id`) REFERENCES `clocks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `calendar_entries_date_idx` ON `calendar_entries` (`date`);--> statement-breakpoint
CREATE TABLE `campaign_media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`media_id` integer NOT NULL,
	`play_as_sweep` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `campaign_media_campaign_idx` ON `campaign_media` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` integer NOT NULL,
	`name` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`plays_per_month` integer NOT NULL,
	`max_plays_per_day` integer,
	`sweeps_per_month` integer,
	`max_sweeps_per_day` integer,
	`time_window_start` text,
	`time_window_end` text,
	`days_of_week` text,
	`advertiser_separation_spots` integer DEFAULT 1 NOT NULL,
	`competing_exclusions` text DEFAULT '[]' NOT NULL,
	`priority` text DEFAULT 'best_effort' NOT NULL,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `campaigns_customer_idx` ON `campaigns` (`customer_id`);--> statement-breakpoint
CREATE INDEX `campaigns_active_idx` ON `campaigns` (`active`);--> statement-breakpoint
CREATE TABLE `clock_segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`clock_id` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`duration_seconds` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_playlist_id` integer,
	`source_rotation_id` integer,
	`source_tier` text,
	`filler_sources` text DEFAULT '[]' NOT NULL,
	`mix_ratio` text,
	`fallback_source` text,
	`start_clip_playlist_id` integer,
	`end_clip_playlist_id` integer,
	`bed_playlist_id` integer,
	`blocks_live_override` integer DEFAULT false NOT NULL,
	`delay_policy` text DEFAULT '{"type":"soft","plus_seconds":30,"minus_seconds":0}' NOT NULL,
	`recovery_tactics` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`clock_id`) REFERENCES `clocks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_rotation_id`) REFERENCES `rotations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`start_clip_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`end_clip_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`bed_playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `clock_segments_clock_idx` ON `clock_segments` (`clock_id`);--> statement-breakpoint
CREATE INDEX `clock_segments_sort_idx` ON `clock_segments` (`clock_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `clocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`sweep_config` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` integer,
	`name` text NOT NULL,
	`email` text,
	`phone` text,
	`role` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `customer_contacts` (
	`customer_id` integer NOT NULL,
	`contact_id` integer NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`customer_id`, `contact_id`),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`phone` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `customers_active_idx` ON `customers` (`active`);--> statement-breakpoint
CREATE TABLE `playlist_media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer NOT NULL,
	`media_id` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`weight` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playlist_media_playlist_idx` ON `playlist_media` (`playlist_id`);--> statement-breakpoint
CREATE INDEX `playlist_media_media_idx` ON `playlist_media` (`media_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `playlist_media_unique` ON `playlist_media` (`playlist_id`,`media_id`);--> statement-breakpoint
CREATE TABLE `playlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `playlists_type_idx` ON `playlists` (`type`);--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`show_id` integer NOT NULL,
	`broadcast_date` text NOT NULL,
	`media_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `recordings_show_date_idx` ON `recordings` (`show_id`,`broadcast_date`);--> statement-breakpoint
CREATE TABLE `rotations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `show_playlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`show_id` integer NOT NULL,
	`playlist_id` integer NOT NULL,
	`rotation_tier` text,
	`rotation_id` integer,
	`fallback_tier` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rotation_id`) REFERENCES `rotations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `show_playlists_show_idx` ON `show_playlists` (`show_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `show_playlists_unique` ON `show_playlists` (`show_id`,`playlist_id`);--> statement-breakpoint
CREATE TABLE `shows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`host` text,
	`producer` text,
	`type` text DEFAULT 'automated' NOT NULL,
	`default_clock_id` integer,
	`intro_media_id` integer,
	`outro_media_id` integer,
	`duration_minutes` integer DEFAULT 60 NOT NULL,
	`color` text DEFAULT 'indigo' NOT NULL,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`default_clock_id`) REFERENCES `clocks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`intro_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`outro_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `shows_active_idx` ON `shows` (`active`);--> statement-breakpoint
CREATE TABLE `template_clock_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_of_week` integer NOT NULL,
	`hour` integer NOT NULL,
	`clock_id` integer NOT NULL,
	FOREIGN KEY (`clock_id`) REFERENCES `clocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `template_clock_entries_dow_hour` ON `template_clock_entries` (`day_of_week`,`hour`);--> statement-breakpoint
CREATE TABLE `template_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_of_week` integer NOT NULL,
	`time_start` text NOT NULL,
	`time_end` text NOT NULL,
	`show_id` integer,
	`clock_id` integer,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`clock_id`) REFERENCES `clocks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `template_entries_dow_idx` ON `template_entries` (`day_of_week`);