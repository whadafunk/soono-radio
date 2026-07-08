-- Same class of bug fixed in 0053/0054/0055: `ALTER TABLE ... ADD COLUMN ...
-- REFERENCES` never carries an ON DELETE clause. supervisor_state.current_play_history_id
-- (Decision 59) needs ON DELETE set null so deleting the pointed-to play_history
-- row clears the pointer instead of blocking the delete.
PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE `__new_supervisor_state` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`current_segment_id` integer,
	`current_drift_seconds` real DEFAULT 0 NOT NULL,
	`last_heartbeat_at` integer,
	`active_plan_id` integer,
	`paused` integer DEFAULT false NOT NULL,
	`next_plan_id` integer,
	`next_plan_draft_drift_seconds` real,
	`next_plan_drift_delta_seconds` real,
	`intentional_offset_seconds` real DEFAULT 0 NOT NULL,
	`planned_overshoot_seconds` real DEFAULT 0 NOT NULL,
	`boundary_drift_seconds` real,
	`current_play_history_id` integer,
	FOREIGN KEY (`current_segment_id`) REFERENCES `clock_segments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`active_plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`next_plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`current_play_history_id`) REFERENCES `play_history`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_supervisor_state`("id", "current_segment_id", "current_drift_seconds", "last_heartbeat_at", "active_plan_id", "paused", "next_plan_id", "next_plan_draft_drift_seconds", "next_plan_drift_delta_seconds", "intentional_offset_seconds", "planned_overshoot_seconds", "boundary_drift_seconds")
SELECT "id", "current_segment_id", "current_drift_seconds", "last_heartbeat_at", "active_plan_id", "paused", "next_plan_id", "next_plan_draft_drift_seconds", "next_plan_drift_delta_seconds", "intentional_offset_seconds", "planned_overshoot_seconds", "boundary_drift_seconds" FROM `supervisor_state`;
--> statement-breakpoint
DROP TABLE `supervisor_state`;--> statement-breakpoint
ALTER TABLE `__new_supervisor_state` RENAME TO `supervisor_state`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
