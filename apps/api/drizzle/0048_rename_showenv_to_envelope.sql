-- Rename category value: showenv → envelope in all tables that carry it.
-- SQLite enums are plain text; no structural change needed, only data.
UPDATE `media` SET `category` = 'envelope' WHERE `category` = 'showenv';
--> statement-breakpoint
UPDATE `ingest_jobs` SET `category` = 'envelope' WHERE `category` = 'showenv';
