-- Rename removed categories to their nearest valid replacement.
-- jingle_sweep / promo_sweep → jingle / promo (sweep is now a scheduling flag, not a category)
-- spot_sweep → spot (same reason)
-- voice → jingle (closest match for vocal station IDs)
-- ad → spot (renamed to industry-standard term)
UPDATE media SET category = 'jingle' WHERE category IN ('jingle_sweep', 'voice');
--> statement-breakpoint
UPDATE media SET category = 'promo'  WHERE category = 'promo_sweep';
--> statement-breakpoint
UPDATE media SET category = 'spot'   WHERE category IN ('spot_sweep', 'ad');
--> statement-breakpoint
UPDATE ingest_jobs SET category = 'jingle' WHERE category IN ('jingle_sweep', 'voice');
--> statement-breakpoint
UPDATE ingest_jobs SET category = 'promo'  WHERE category = 'promo_sweep';
--> statement-breakpoint
UPDATE ingest_jobs SET category = 'spot'   WHERE category IN ('spot_sweep', 'ad');
