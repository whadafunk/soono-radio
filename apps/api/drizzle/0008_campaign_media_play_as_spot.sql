ALTER TABLE `campaign_media` ADD COLUMN `play_as_spot` integer NOT NULL DEFAULT 1;
UPDATE `campaigns` SET `first_in_slot_mode` = 'at_least_one_shared' WHERE `first_in_slot_mode` = 'at_least_one_preferred';
