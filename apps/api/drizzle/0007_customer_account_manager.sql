ALTER TABLE `customers` ADD COLUMN `account_manager_id` integer REFERENCES `users`(`id`) ON DELETE SET NULL;
