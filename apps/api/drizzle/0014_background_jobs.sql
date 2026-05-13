CREATE TABLE `background_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `type` text NOT NULL,
  `label` text NOT NULL,
  `status` text NOT NULL DEFAULT 'running',
  `total` integer NOT NULL DEFAULT 0,
  `succeeded` integer NOT NULL DEFAULT 0,
  `failed` integer NOT NULL DEFAULT 0,
  `review_pending` integer NOT NULL DEFAULT 0,
  `results_json` text,
  `created_at` integer NOT NULL,
  `completed_at` integer
);
