CREATE TABLE `users` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `first_name` text NOT NULL,
  `last_name` text NOT NULL,
  `account_name` text,
  `email` text,
  `title` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch()),
  `updated_at` integer NOT NULL DEFAULT (unixepoch())
);
