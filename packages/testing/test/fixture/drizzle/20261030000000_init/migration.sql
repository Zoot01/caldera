CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`title` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `posts_title` ON `posts` (`title`);
