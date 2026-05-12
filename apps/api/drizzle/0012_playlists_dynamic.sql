-- Add static/dynamic kind + rules to playlists, and media_tags table

ALTER TABLE `playlists` ADD COLUMN `kind` text NOT NULL DEFAULT 'static';
--> statement-breakpoint
ALTER TABLE `playlists` ADD COLUMN `rules` text;
--> statement-breakpoint
CREATE INDEX `playlists_kind_idx` ON `playlists` (`kind`);
--> statement-breakpoint
CREATE TABLE `media_tags` (
  `media_id` integer NOT NULL,
  `tag` text NOT NULL,
  PRIMARY KEY (`media_id`, `tag`),
  FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_tags_tag_idx` ON `media_tags` (`tag`);
