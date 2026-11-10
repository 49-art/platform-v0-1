CREATE TABLE `age_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_ref` text NOT NULL,
	`method` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `age_checks_user_ix` ON `age_checks` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `age_checks_ref_uq` ON `age_checks` (`provider`,`provider_ref`);--> statement-breakpoint
CREATE TABLE `appeals` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`user_id` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`decided_by` text,
	`decision_note` text,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `appeals_action_uq` ON `appeals` (`action_id`);--> statement-breakpoint
CREATE INDEX `appeals_status_ix` ON `appeals` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`actor_role` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_target_ix` ON `audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `audit_actor_ix` ON `audit_log` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_time_ix` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `auth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_tokens_hash_uq` ON `auth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_tokens_user_ix` ON `auth_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `ban_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`hash` text NOT NULL,
	`source_user_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ban_signals_uq` ON `ban_signals` (`kind`,`hash`);--> statement-breakpoint
CREATE TABLE `blocks` (
	`blocker` text NOT NULL,
	`blocked` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`blocker`, `blocked`)
);
--> statement-breakpoint
CREATE INDEX `blocks_blocked_ix` ON `blocks` (`blocked`);--> statement-breakpoint
CREATE TABLE `bot_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ip_hash` text,
	`user_id` text,
	`route` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bot_events_ix` ON `bot_events` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `consents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`granted_at` integer NOT NULL,
	`withdrawn_at` integer,
	`version` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `consents_user_ix` ON `consents` (`user_id`,`kind`,`scope`);--> statement-breakpoint
CREATE TABLE `contact_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`topic` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_a` text NOT NULL,
	`user_b` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`frozen_reason` text,
	`last_message_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conv_a_ix` ON `conversations` (`user_a`);--> statement-breakpoint
CREATE INDEX `conv_b_ix` ON `conversations` (`user_b`);--> statement-breakpoint
CREATE TABLE `date_safety` (
	`date_id` text NOT NULL,
	`user_id` text NOT NULL,
	`trusted_contact_id` text,
	`shared_at` integer,
	`checkin_due_at` integer,
	`reminded_at` integer,
	`checked_in_at` integer,
	`alerted_at` integer,
	`sos_at` integer,
	PRIMARY KEY(`date_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `date_safety_due_ix` ON `date_safety` (`checkin_due_at`);--> statement-breakpoint
CREATE TABLE `dates` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`proposer_id` text NOT NULL,
	`invitee_id` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`starts_at` integer NOT NULL,
	`venue_enc` text NOT NULL,
	`created_at` integer NOT NULL,
	`responded_at` integer
);
--> statement-breakpoint
CREATE INDEX `dates_conv_ix` ON `dates` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `dates_status_ix` ON `dates` (`status`,`starts_at`);--> statement-breakpoint
CREATE TABLE `enforcement_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`reason_code` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`report_id` text,
	`actor_id` text NOT NULL,
	`expires_at` integer,
	`lifted_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `enforcement_user_ix` ON `enforcement_actions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `flagged_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`flags` text NOT NULL,
	`excerpt_enc` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `flagged_sender_ix` ON `flagged_messages` (`sender_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `id_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_ref` text NOT NULL,
	`status` text NOT NULL,
	`face_match` integer,
	`duplicate_signal_hash` text,
	`review_note` text,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `idv_user_ix` ON `id_verifications` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idv_ref_uq` ON `id_verifications` (`provider`,`provider_ref`);--> statement-breakpoint
CREATE TABLE `le_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`agency` text NOT NULL,
	`reference` text DEFAULT '' NOT NULL,
	`contact` text DEFAULT '' NOT NULL,
	`subject_user_id` text,
	`legal_basis` text DEFAULT '' NOT NULL,
	`legal_basis_checked` integer DEFAULT false NOT NULL,
	`emergency` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`preservation_until` integer,
	`disclosure_note` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `le_status_ix` ON `le_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `legal_holds` (
	`user_id` text NOT NULL,
	`le_request_id` text NOT NULL,
	`until` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `le_request_id`)
);
--> statement-breakpoint
CREATE TABLE `likes` (
	`from_user` text NOT NULL,
	`to_user` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`from_user`, `to_user`)
);
--> statement-breakpoint
CREATE INDEX `likes_to_ix` ON `likes` (`to_user`,`kind`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_a` text NOT NULL,
	`user_b` text NOT NULL,
	`conversation_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `matches_pair_uq` ON `matches` (`user_a`,`user_b`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`kind` text DEFAULT 'text' NOT NULL,
	`body_enc` text NOT NULL,
	`photo_id` text,
	`flags` text DEFAULT '[]' NOT NULL,
	`fp_hash` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_fp_ix` ON `messages` (`sender_id`,`fp_hash`);--> statement-breakpoint
CREATE INDEX `messages_conv_ix` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_sender_ix` ON `messages` (`sender_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mod_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scores` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason_code` text,
	`decided_by` text,
	`sla_due_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `mod_queue_ix` ON `mod_queue` (`status`,`sla_due_at`);--> statement-breakpoint
CREATE INDEX `mod_queue_user_ix` ON `mod_queue` (`user_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`href` text DEFAULT '' NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_user_ix` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `oauth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_user_id` text NOT NULL,
	`handle` text,
	`linked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_provider_uq` ON `oauth_accounts` (`provider`,`provider_user_id`);--> statement-breakpoint
CREATE INDEX `oauth_user_ix` ON `oauth_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`to_address` text NOT NULL,
	`template` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`transport` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_time_ix` ON `outbox` (`created_at`);--> statement-breakpoint
CREATE TABLE `photos` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`purpose` text DEFAULT 'profile' NOT NULL,
	`conversation_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`scores` text,
	`content_hash` text,
	`explicit` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `photos_user_ix` ON `photos` (`user_id`,`purpose`,`position`);--> statement-breakpoint
CREATE INDEX `photos_hash_ix` ON `photos` (`content_hash`);--> statement-breakpoint
CREATE TABLE `policy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`version` text NOT NULL,
	`published_at` integer NOT NULL,
	`published_by` text NOT NULL,
	`note` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_kind_version_uq` ON `policy_versions` (`kind`,`version`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`birth_year` integer,
	`bio` text DEFAULT '' NOT NULL,
	`looking_for` text DEFAULT '' NOT NULL,
	`country_of_origin` text DEFAULT '' NOT NULL,
	`identity_enc` text,
	`area_label` text DEFAULT '' NOT NULL,
	`geo_cell` text DEFAULT '' NOT NULL,
	`cell_lat` integer,
	`cell_lon` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`rejection_reason` text,
	`submitted_at` integer,
	`approved_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `profiles_discover_ix` ON `profiles` (`status`,`cell_lat`,`cell_lon`);--> statement-breakpoint
CREATE INDEX `profiles_status_ix` ON `profiles` (`status`,`submitted_at`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `push_user_ix` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_id` text NOT NULL,
	`subject_user_id` text NOT NULL,
	`conversation_id` text,
	`reason` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`priority` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assigned_to` text,
	`merged_into` text,
	`outcome` text,
	`outcome_note` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `reports_queue_ix` ON `reports` (`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `reports_subject_ix` ON `reports` (`subject_user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`reauth_at` integer,
	`ip_hash` text,
	`ua_hash` text,
	`ua_label` text,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `sessions_user_ix` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `staff` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_email_uq` ON `staff` (`email`);--> statement-breakpoint
CREATE TABLE `taxonomy` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`label` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_uq` ON `taxonomy` (`kind`,`slug`);--> statement-breakpoint
CREATE TABLE `trusted_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name_enc` text NOT NULL,
	`channel` text NOT NULL,
	`address_enc` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trusted_user_ix` ON `trusted_contacts` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_contacts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`phone_enc` text,
	`phone_hash` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`email_hash` text,
	`email_verified_at` integer,
	`password_hash` text,
	`status` text DEFAULT 'active' NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`restricted_until` integer,
	`suspended_until` integer,
	`risk_score` integer DEFAULT 0 NOT NULL,
	`device_hash` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`erase_after` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_status_ix` ON `users` (`status`);