ALTER TABLE `rotations` ADD `is_default` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `playlists` ADD `is_default` integer NOT NULL DEFAULT 0;
