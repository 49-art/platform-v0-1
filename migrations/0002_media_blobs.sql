-- Free-plan media store (decision D-015). Unused when an R2 bucket is bound.
CREATE TABLE IF NOT EXISTS `media_blobs` (
  `key` text PRIMARY KEY NOT NULL,
  `content_type` text NOT NULL,
  `bytes` blob NOT NULL,
  `created_at` integer NOT NULL
);
