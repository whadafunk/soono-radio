CREATE TABLE `supervisor_config` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`overserve_factor` real DEFAULT 2 NOT NULL,
	`second_pass_drift_delta_threshold_s` real DEFAULT 30 NOT NULL,
	`second_pass_lead_time_s` real DEFAULT 30 NOT NULL,
	`drift_correction_threshold_s` real DEFAULT 10 NOT NULL,
	`coasting_correction_threshold_s` real DEFAULT 30 NOT NULL,
	`silence_gap_tolerance_s` real DEFAULT 5 NOT NULL,
	`queue_advance_s` real DEFAULT 8 NOT NULL,
	`fire_early_min_window_s` real DEFAULT 30 NOT NULL,
	`prefer_early_start_over_fill` integer DEFAULT true NOT NULL,
	`prefer_late_start_over_skip` integer DEFAULT true NOT NULL,
	`cut_allowed_music` integer DEFAULT true NOT NULL,
	`cut_allowed_campaign` integer DEFAULT false NOT NULL,
	`cut_allowed_promo` integer DEFAULT false NOT NULL,
	`cut_allowed_jingle` integer DEFAULT false NOT NULL,
	`cut_allowed_station_id` integer DEFAULT false NOT NULL,
	`cut_allowed_branding` integer DEFAULT false NOT NULL,
	`cut_allowed_rundown` integer DEFAULT false NOT NULL,
	`cut_allowed_voice_track` integer DEFAULT false NOT NULL,
	`skip_allowed_music` integer DEFAULT true NOT NULL,
	`skip_allowed_campaign` integer DEFAULT false NOT NULL,
	`skip_allowed_promo` integer DEFAULT true NOT NULL,
	`skip_allowed_jingle` integer DEFAULT true NOT NULL,
	`skip_allowed_station_id` integer DEFAULT true NOT NULL,
	`skip_allowed_branding` integer DEFAULT true NOT NULL,
	`skip_allowed_rundown` integer DEFAULT false NOT NULL,
	`skip_allowed_voice_track` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE `plan_items` ADD `cut_allowed` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `plan_items` ADD `skip_allowed` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `supervisor_state` ADD `next_plan_id` integer REFERENCES plans(id);--> statement-breakpoint
ALTER TABLE `supervisor_state` ADD `next_plan_draft_drift_seconds` real;--> statement-breakpoint
ALTER TABLE `supervisor_state` ADD `next_plan_drift_delta_seconds` real;--> statement-breakpoint
ALTER TABLE `supervisor_state` ADD `intentional_offset_seconds` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `supervisor_state` ADD `planned_overshoot_seconds` real DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT INTO `supervisor_config` (`id`) VALUES (1);