ALTER TABLE `plans` ADD `nominal_duration_seconds` real;--> statement-breakpoint
ALTER TABLE `plans` ADD `target_duration_seconds` real;--> statement-breakpoint
ALTER TABLE `plans` ADD `predicted_drift_seconds` real;--> statement-breakpoint
ALTER TABLE `plans` ADD `applied_correction_seconds` real;--> statement-breakpoint
ALTER TABLE `plans` ADD `boundary_drift_seconds` real;--> statement-breakpoint
ALTER TABLE `plans` ADD `activated_at` integer;--> statement-breakpoint
ALTER TABLE `station_settings` ADD `drift_full_authority_threshold_s` real DEFAULT 100 NOT NULL;