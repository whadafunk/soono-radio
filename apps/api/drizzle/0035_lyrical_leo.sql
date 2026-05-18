ALTER TABLE `playlists` ADD `subcategory` text;

-- Backfill subcategories for existing rows
UPDATE `playlists` SET `subcategory` = 'standard' WHERE `type` = 'music';
UPDATE `playlists` SET `subcategory` = 'show'     WHERE `type` = 'jingle';
