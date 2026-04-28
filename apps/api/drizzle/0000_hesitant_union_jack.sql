CREATE TABLE `ingest_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`uploaded_filename` text NOT NULL,
	`uploaded_size_bytes` integer NOT NULL,
	`staging_path` text NOT NULL,
	`category` text NOT NULL,
	`detected_format` text,
	`detected_bitrate` integer,
	`needs_transcode` integer,
	`measured_lufs` real,
	`measured_lra` real,
	`measured_peak` real,
	`media_id` integer,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ingest_jobs_status_idx` ON `ingest_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `ingest_jobs_created_at_idx` ON `ingest_jobs` (`created_at`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sha256` text NOT NULL,
	`category` text NOT NULL,
	`title` text,
	`artist` text,
	`album` text,
	`genre` text,
	`year` integer,
	`notes` text,
	`original_filename` text NOT NULL,
	`duration_seconds` real NOT NULL,
	`bitrate_kbps` integer NOT NULL,
	`samplerate_hz` integer NOT NULL,
	`channels` integer NOT NULL,
	`filesize_bytes` integer NOT NULL,
	`was_transcoded` integer NOT NULL,
	`loudness_lufs` real,
	`loudness_lra` real,
	`loudness_peak` real,
	`loudness_gain_db` real,
	`loudness_warning` text,
	`cue_in_seconds` real,
	`cue_out_seconds` real,
	`intro_seconds` real,
	`outro_seconds` real,
	`play_count` integer DEFAULT 0 NOT NULL,
	`last_played_at` integer,
	`favorite` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_sha256_unique` ON `media` (`sha256`);--> statement-breakpoint
CREATE INDEX `media_category_idx` ON `media` (`category`);--> statement-breakpoint
CREATE INDEX `media_title_idx` ON `media` (`title`);--> statement-breakpoint
CREATE INDEX `media_artist_idx` ON `media` (`artist`);--> statement-breakpoint
CREATE INDEX `media_last_played_idx` ON `media` (`last_played_at`);--> statement-breakpoint
CREATE INDEX `media_play_count_idx` ON `media` (`play_count`);