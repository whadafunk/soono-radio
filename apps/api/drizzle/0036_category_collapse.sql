-- Collapse intro/outro/stationid media categories → jingle
-- (subcategory on the playlist side carries the semantic distinction)
UPDATE `media` SET `category` = 'jingle' WHERE `category` IN ('intro', 'outro', 'stationid');

-- Same collapse on ingest_jobs (historical pipeline records)
UPDATE `ingest_jobs` SET `category` = 'jingle' WHERE `category` IN ('intro', 'outro', 'stationid');

-- Rename jingle playlist subcategories: intro → opener, outro → closer
UPDATE `playlists` SET `subcategory` = 'opener' WHERE `subcategory` = 'intro';
UPDATE `playlists` SET `subcategory` = 'closer' WHERE `subcategory` = 'outro';

-- Rename showid → showenv
UPDATE `media` SET `category` = 'showenv' WHERE `category` = 'showid';
UPDATE `ingest_jobs` SET `category` = 'showenv' WHERE `category` = 'showid';
