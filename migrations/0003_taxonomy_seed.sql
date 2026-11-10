-- Starting categories (DERIVED: the spec names the categories but not their values; Admin manages them, spec 8).
INSERT OR IGNORE INTO `taxonomy` (`id`, `kind`, `slug`, `label`, `position`, `active`) VALUES
  ('tax_lf_relationship', 'looking_for', 'relationship', 'A relationship', 0, 1),
  ('tax_lf_dating', 'looking_for', 'dating', 'Dating, see where it goes', 1, 1),
  ('tax_lf_dinner', 'looking_for', 'dinner', 'Dinner dates', 2, 1),
  ('tax_lf_friends', 'looking_for', 'friendship', 'New friends', 3, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO `taxonomy` (`id`, `kind`, `slug`, `label`, `position`, `active`) VALUES
  ('tax_g_woman', 'gender', 'woman', 'Woman', 0, 1),
  ('tax_g_man', 'gender', 'man', 'Man', 1, 1),
  ('tax_g_nonbinary', 'gender', 'non_binary', 'Non-binary', 2, 1),
  ('tax_g_genderqueer', 'gender', 'genderqueer', 'Genderqueer', 3, 1),
  ('tax_g_another', 'gender', 'another', 'Another identity', 4, 1);
--> statement-breakpoint
INSERT OR IGNORE INTO `taxonomy` (`id`, `kind`, `slug`, `label`, `position`, `active`) VALUES
  ('tax_o_straight', 'orientation', 'straight', 'Straight', 0, 1),
  ('tax_o_gay', 'orientation', 'gay', 'Gay', 1, 1),
  ('tax_o_lesbian', 'orientation', 'lesbian', 'Lesbian', 2, 1),
  ('tax_o_bisexual', 'orientation', 'bisexual', 'Bisexual', 3, 1),
  ('tax_o_pansexual', 'orientation', 'pansexual', 'Pansexual', 4, 1),
  ('tax_o_queer', 'orientation', 'queer', 'Queer', 5, 1),
  ('tax_o_asexual', 'orientation', 'asexual', 'Asexual', 6, 1),
  ('tax_o_another', 'orientation', 'another', 'Another orientation', 7, 1);
--> statement-breakpoint
-- Free-plan runtime configuration: secrets generated on first boot when none are set in Cloudflare (decision D-021).
CREATE TABLE IF NOT EXISTS `app_config` (
  `key` text PRIMARY KEY NOT NULL,
  `value` text NOT NULL,
  `created_at` integer NOT NULL
);
