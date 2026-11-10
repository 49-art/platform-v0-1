/**
 * Data model — spec section 4.
 *
 * Only the "Identity and auth" group was legible in the spec print. Every other
 * group is DERIVED from sections 1, 2, 6, 7, 8 and 9 and is listed for founder
 * sign-off in docs/spec/DERIVED.md.
 *
 * Conventions
 *  - ids are opaque text (prefix + random), timestamps are epoch milliseconds.
 *  - columns ending in `_enc` hold AES-256-GCM ciphertext written at application
 *    level (see crypto.ts). They are never filtered on in SQL.
 *  - columns ending in `_hash` hold keyed HMAC-SHA256 digests (blind indexes).
 *  - ID documents and liveness media are never stored: results only.
 */
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const ts = (name: string) => integer(name);
const created = () => integer("created_at").notNull();

/* ───────────────────────── Identity and auth (spec) ───────────────────────── */

export const users = sqliteTable(
  "users",
  {
    id: id(),
    email: text("email"), // unique, nullable for X-only until captured
    emailHash: text("email_hash"), // blind index used for ban-evasion matching
    emailVerifiedAt: ts("email_verified_at"),
    passwordHash: text("password_hash"),
    status: text("status", { enum: ["active", "suspended", "banned", "deleted"] })
      .notNull()
      .default("active"),
    // creator / fan are reserved for Phase 2-3 and are never assigned by MVP code.
    role: text("role", { enum: ["member", "creator", "fan", "mod", "admin"] })
      .notNull()
      .default("member"),
    restrictedUntil: ts("restricted_until"), // "restrict" = no messaging
    suspendedUntil: ts("suspended_until"),
    riskScore: integer("risk_score").notNull().default(0),
    deviceHash: text("device_hash"),
    createdAt: created(),
    deletedAt: ts("deleted_at"),
    eraseAfter: ts("erase_after"), // deletion requested: erase personal data at this time
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email), index("users_status_ix").on(t.status)],
);

export const oauthAccounts = sqliteTable(
  "oauth_accounts",
  {
    id: id(),
    userId: text("user_id").notNull(),
    provider: text("provider", { enum: ["x"] }).notNull(),
    providerUserId: text("provider_user_id").notNull(),
    handle: text("handle"),
    linkedAt: integer("linked_at").notNull(),
  },
  (t) => [
    uniqueIndex("oauth_provider_uq").on(t.provider, t.providerUserId),
    index("oauth_user_ix").on(t.userId),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: id(), // SHA-256 of the cookie token; the raw token is never stored
    userId: text("user_id").notNull(),
    createdAt: created(),
    lastSeenAt: integer("last_seen_at").notNull(),
    reauthAt: ts("reauth_at"), // last password / fresh-login confirmation
    ipHash: text("ip_hash"),
    uaHash: text("ua_hash"),
    uaLabel: text("ua_label"), // coarse "Chrome on Android" for the session list
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("sessions_user_ix").on(t.userId)],
);

export const authTokens = sqliteTable(
  "auth_tokens",
  {
    id: id(),
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: ["email_verify", "reset", "reauth"] }).notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: ts("used_at"),
  },
  (t) => [uniqueIndex("auth_tokens_hash_uq").on(t.tokenHash), index("auth_tokens_user_ix").on(t.userId)],
);

export const consents = sqliteTable(
  "consents",
  {
    id: id(),
    userId: text("user_id").notNull(),
    kind: text("kind", {
      enum: ["special_category", "marketing", "explicit_media", "x_link", "phone_swap"],
    }).notNull(),
    // phone_swap / x_link are per conversation; scope is the conversation id.
    scope: text("scope").notNull().default(""),
    grantedAt: integer("granted_at").notNull(),
    withdrawnAt: ts("withdrawn_at"),
    version: text("version").notNull(),
  },
  (t) => [index("consents_user_ix").on(t.userId, t.kind, t.scope)],
);

/* ───────────────────────── Verification (derived) ───────────────────────── */

export const ageChecks = sqliteTable(
  "age_checks",
  {
    id: id(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref").notNull(),
    method: text("method"), // face_estimation | id_document — as reported by the provider
    status: text("status", { enum: ["pending", "passed", "failed"] }).notNull(),
    createdAt: created(),
    decidedAt: ts("decided_at"),
  },
  (t) => [index("age_checks_user_ix").on(t.userId), uniqueIndex("age_checks_ref_uq").on(t.provider, t.providerRef)],
);

export const idVerifications = sqliteTable(
  "id_verifications",
  {
    id: id(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref").notNull(),
    status: text("status", { enum: ["pending", "passed", "failed", "review"] }).notNull(),
    faceMatch: integer("face_match", { mode: "boolean" }), // face matches profile photos
    duplicateSignalHash: text("duplicate_signal_hash"), // provider's "seen this person before" token, HMACed
    reviewNote: text("review_note"),
    createdAt: created(),
    decidedAt: ts("decided_at"),
  },
  (t) => [index("idv_user_ix").on(t.userId), uniqueIndex("idv_ref_uq").on(t.provider, t.providerRef)],
);

/* ───────────────────────── Profiles and discovery (derived) ───────────────────────── */

export const profiles = sqliteTable(
  "profiles",
  {
    userId: text("user_id").primaryKey(),
    displayName: text("display_name").notNull().default(""),
    birthYear: integer("birth_year"), // year only: enough for an age filter, no full DOB stored
    bio: text("bio").notNull().default(""),
    lookingFor: text("looking_for").notNull().default(""), // taxonomy slug
    countryOfOrigin: text("country_of_origin").notNull().default(""),
    // Special category data (UK GDPR Art. 9). Encrypted JSON: { gender, orientation, pronouns, show: [] }.
    // Written only while a `special_category` consent is active; wiped on withdrawal.
    identityEnc: text("identity_enc"),
    areaLabel: text("area_label").notNull().default(""), // user-facing, e.g. "Harrow"
    geoCell: text("geo_cell").notNull().default(""), // geohash-5 (~5 km); precise coordinates are discarded
    // Centre of that cell in milli-degrees, so radius search is an indexed bounding box. Not the member's position.
    cellLat: integer("cell_lat"),
    cellLon: integer("cell_lon"),
    status: text("status", { enum: ["draft", "pending", "approved", "rejected", "hidden"] })
      .notNull()
      .default("draft"),
    rejectionReason: text("rejection_reason"),
    submittedAt: ts("submitted_at"),
    approvedAt: ts("approved_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("profiles_discover_ix").on(t.status, t.cellLat, t.cellLon), index("profiles_status_ix").on(t.status, t.submittedAt)],
);

export const photos = sqliteTable(
  "photos",
  {
    id: id(),
    userId: text("user_id").notNull(),
    r2Key: text("r2_key").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    position: integer("position").notNull().default(0),
    purpose: text("purpose", { enum: ["profile", "chat"] }).notNull().default("profile"),
    conversationId: text("conversation_id"), // chat images only
    status: text("status", { enum: ["pending", "approved", "rejected", "quarantined"] })
      .notNull()
      .default("pending"),
    scores: text("scores"), // JSON auto-scores: nudity, faces, weapons, minor, hashMatch
    contentHash: text("content_hash"), // SHA-256 of bytes: exact-duplicate + ban-evasion signal
    explicit: integer("explicit", { mode: "boolean" }).notNull().default(false),
    createdAt: created(),
  },
  (t) => [index("photos_user_ix").on(t.userId, t.purpose, t.position), index("photos_hash_ix").on(t.contentHash)],
);

export const likes = sqliteTable(
  "likes",
  {
    fromUser: text("from_user").notNull(),
    toUser: text("to_user").notNull(),
    kind: text("kind", { enum: ["like", "pass"] }).notNull(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.fromUser, t.toUser] }), index("likes_to_ix").on(t.toUser, t.kind)],
);

export const matches = sqliteTable(
  "matches",
  {
    id: id(),
    userA: text("user_a").notNull(), // userA < userB lexicographically
    userB: text("user_b").notNull(),
    conversationId: text("conversation_id").notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("matches_pair_uq").on(t.userA, t.userB)],
);

export const blocks = sqliteTable(
  "blocks",
  {
    blocker: text("blocker").notNull(),
    blocked: text("blocked").notNull(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.blocker, t.blocked] }), index("blocks_blocked_ix").on(t.blocked)],
);

/* ───────────────────────── Chat and dates (derived) ───────────────────────── */

export const conversations = sqliteTable(
  "conversations",
  {
    id: id(),
    userA: text("user_a").notNull(),
    userB: text("user_b").notNull(),
    status: text("status", { enum: ["open", "frozen", "closed"] }).notNull().default("open"),
    frozenReason: text("frozen_reason"),
    lastMessageAt: ts("last_message_at"),
    createdAt: created(),
  },
  (t) => [index("conv_a_ix").on(t.userA), index("conv_b_ix").on(t.userB)],
);

/** Archive copy written from the queue (spec 6: "copy queued to the archive table and scan queue"). */
export const messages = sqliteTable(
  "messages",
  {
    id: id(),
    conversationId: text("conversation_id").notNull(),
    senderId: text("sender_id").notNull(),
    kind: text("kind", { enum: ["text", "image", "system"] }).notNull().default("text"),
    bodyEnc: text("body_enc").notNull(),
    photoId: text("photo_id"),
    flags: text("flags").notNull().default("[]"), // JSON array of shield / keyword flag codes
    fpHash: text("fp_hash"), // keyed hash of the normalised text: copy-paste detection without reading content
    createdAt: created(),
  },
  (t) => [index("messages_fp_ix").on(t.senderId, t.fpHash), index("messages_conv_ix").on(t.conversationId, t.createdAt), index("messages_sender_ix").on(t.senderId, t.createdAt)],
);

export const userContacts = sqliteTable("user_contacts", {
  userId: text("user_id").primaryKey(),
  phoneEnc: text("phone_enc"),
  phoneHash: text("phone_hash"),
  updatedAt: integer("updated_at").notNull(),
});

export const trustedContacts = sqliteTable(
  "trusted_contacts",
  {
    id: id(),
    userId: text("user_id").notNull(),
    nameEnc: text("name_enc").notNull(),
    channel: text("channel", { enum: ["email", "sms"] }).notNull(),
    addressEnc: text("address_enc").notNull(),
    createdAt: created(),
  },
  (t) => [index("trusted_user_ix").on(t.userId)],
);

export const dates = sqliteTable(
  "dates",
  {
    id: id(),
    conversationId: text("conversation_id").notNull(),
    proposerId: text("proposer_id").notNull(),
    inviteeId: text("invitee_id").notNull(),
    status: text("status", { enum: ["proposed", "accepted", "declined", "cancelled", "completed"] })
      .notNull()
      .default("proposed"),
    startsAt: integer("starts_at").notNull(),
    venueEnc: text("venue_enc").notNull(), // venue name + area, visible to the two people only
    createdAt: created(),
    respondedAt: ts("responded_at"),
  },
  (t) => [index("dates_conv_ix").on(t.conversationId), index("dates_status_ix").on(t.status, t.startsAt)],
);

/** One row per person per date: their own safety set-up. */
export const dateSafety = sqliteTable(
  "date_safety",
  {
    dateId: text("date_id").notNull(),
    userId: text("user_id").notNull(),
    trustedContactId: text("trusted_contact_id"),
    sharedAt: ts("shared_at"), // plan shared with the trusted contact
    checkinDueAt: ts("checkin_due_at"),
    remindedAt: ts("reminded_at"),
    checkedInAt: ts("checked_in_at"),
    alertedAt: ts("alerted_at"), // missed check-in alert sent
    sosAt: ts("sos_at"),
  },
  (t) => [primaryKey({ columns: [t.dateId, t.userId] }), index("date_safety_due_ix").on(t.checkinDueAt)],
);

/* ───────────────────────── Trust and safety (derived) ───────────────────────── */

export const reports = sqliteTable(
  "reports",
  {
    id: id(),
    reporterId: text("reporter_id").notNull(),
    subjectUserId: text("subject_user_id").notNull(),
    conversationId: text("conversation_id"),
    reason: text("reason").notNull(), // see REPORT_REASONS
    detail: text("detail").notNull().default(""),
    priority: integer("priority").notNull(), // lower = more urgent
    status: text("status", { enum: ["open", "assigned", "escalated", "resolved", "merged"] })
      .notNull()
      .default("open"),
    assignedTo: text("assigned_to"),
    mergedInto: text("merged_into"),
    outcome: text("outcome"), // action_taken | no_action | escalated
    outcomeNote: text("outcome_note"),
    createdAt: created(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [index("reports_queue_ix").on(t.status, t.priority, t.createdAt), index("reports_subject_ix").on(t.subjectUserId)],
);

export const modQueue = sqliteTable(
  "mod_queue",
  {
    id: id(),
    kind: text("kind", { enum: ["profile", "photo", "ban_evasion", "idv_review"] }).notNull(),
    refId: text("ref_id").notNull(),
    userId: text("user_id").notNull(),
    scores: text("scores").notNull().default("{}"),
    status: text("status", { enum: ["pending", "approved", "rejected", "escalated"] }).notNull().default("pending"),
    reasonCode: text("reason_code"),
    decidedBy: text("decided_by"),
    slaDueAt: integer("sla_due_at").notNull(),
    createdAt: created(),
    decidedAt: ts("decided_at"),
  },
  (t) => [index("mod_queue_ix").on(t.status, t.slaDueAt), index("mod_queue_user_ix").on(t.userId)],
);

export const enforcementActions = sqliteTable(
  "enforcement_actions",
  {
    id: id(),
    userId: text("user_id").notNull(),
    kind: text("kind", { enum: ["warn", "restrict", "suspend", "ban"] }).notNull(),
    reasonCode: text("reason_code").notNull(),
    note: text("note").notNull().default(""),
    reportId: text("report_id"),
    actorId: text("actor_id").notNull(), // staff id or "system"
    expiresAt: ts("expires_at"),
    liftedAt: ts("lifted_at"),
    createdAt: created(),
  },
  (t) => [index("enforcement_user_ix").on(t.userId, t.createdAt)],
);

export const appeals = sqliteTable(
  "appeals",
  {
    id: id(),
    actionId: text("action_id").notNull(),
    userId: text("user_id").notNull(),
    body: text("body").notNull(),
    status: text("status", { enum: ["open", "upheld", "overturned"] }).notNull().default("open"),
    decidedBy: text("decided_by"),
    decisionNote: text("decision_note"),
    createdAt: created(),
    decidedAt: ts("decided_at"),
  },
  (t) => [uniqueIndex("appeals_action_uq").on(t.actionId), index("appeals_status_ix").on(t.status, t.createdAt)],
);

/** Hashed identifiers of banned accounts. Kept after account erasure (spec: deletion exceptions). */
export const banSignals = sqliteTable(
  "ban_signals",
  {
    id: id(),
    kind: text("kind", { enum: ["email", "phone", "device", "photo", "id_duplicate", "x_account"] }).notNull(),
    hash: text("hash").notNull(),
    sourceUserId: text("source_user_id").notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("ban_signals_uq").on(t.kind, t.hash)],
);

/** Messages the pipeline flagged. Moderators see these without opening the whole chat. */
export const flaggedMessages = sqliteTable(
  "flagged_messages",
  {
    id: id(),
    messageId: text("message_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    senderId: text("sender_id").notNull(),
    flags: text("flags").notNull(),
    excerptEnc: text("excerpt_enc").notNull(),
    createdAt: created(),
  },
  (t) => [index("flagged_sender_ix").on(t.senderId, t.createdAt)],
);

/** Append-only. UPDATE and DELETE are rejected by triggers in the migration. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: id(),
    actorId: text("actor_id").notNull(),
    actorRole: text("actor_role").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    detail: text("detail").notNull().default("{}"),
    createdAt: created(),
  },
  (t) => [index("audit_target_ix").on(t.targetType, t.targetId), index("audit_actor_ix").on(t.actorId, t.createdAt), index("audit_time_ix").on(t.createdAt)],
);

export const staff = sqliteTable(
  "staff",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    role: text("role", { enum: ["moderator", "senior_moderator", "ts_lead", "admin", "agency_staff"] }).notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: created(),
  },
  (t) => [uniqueIndex("staff_email_uq").on(t.email)],
);

export const leRequests = sqliteTable(
  "le_requests",
  {
    id: id(),
    agency: text("agency").notNull(),
    reference: text("reference").notNull().default(""),
    contact: text("contact").notNull().default(""),
    subjectUserId: text("subject_user_id"),
    legalBasis: text("legal_basis").notNull().default(""),
    legalBasisChecked: integer("legal_basis_checked", { mode: "boolean" }).notNull().default(false),
    emergency: integer("emergency", { mode: "boolean" }).notNull().default(false), // threat to life
    status: text("status", { enum: ["received", "preserved", "disclosed", "refused", "closed"] }).notNull().default("received"),
    preservationUntil: ts("preservation_until"),
    disclosureNote: text("disclosure_note"),
    createdBy: text("created_by").notNull(),
    createdAt: created(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("le_status_ix").on(t.status, t.createdAt)],
);

export const legalHolds = sqliteTable(
  "legal_holds",
  {
    userId: text("user_id").notNull(),
    leRequestId: text("le_request_id").notNull(),
    until: integer("until").notNull(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.leRequestId] })],
);

export const policyVersions = sqliteTable(
  "policy_versions",
  {
    id: id(),
    kind: text("kind", { enum: ["terms", "privacy", "guidelines", "special_category_consent"] }).notNull(),
    version: text("version").notNull(),
    publishedAt: integer("published_at").notNull(),
    publishedBy: text("published_by").notNull(),
    note: text("note").notNull().default(""),
  },
  (t) => [uniqueIndex("policy_kind_version_uq").on(t.kind, t.version)],
);

export const taxonomy = sqliteTable(
  "taxonomy",
  {
    id: id(),
    kind: text("kind", { enum: ["looking_for", "gender", "orientation"] }).notNull(),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    position: integer("position").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("taxonomy_uq").on(t.kind, t.slug)],
);

/* ───────────────────────── Notifications and site (derived) ───────────────────────── */

export const notifications = sqliteTable(
  "notifications",
  {
    id: id(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(), // match | message | moderation | report_ack | report_outcome | date | safety | verification
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    href: text("href").notNull().default(""),
    readAt: ts("read_at"),
    createdAt: created(),
  },
  (t) => [index("notifications_user_ix").on(t.userId, t.createdAt)],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: id(), // SHA-256 of endpoint
    userId: text("user_id").notNull(),
    endpoint: text("endpoint").notNull(),
    createdAt: created(),
  },
  (t) => [index("push_user_ix").on(t.userId)],
);

export const contactMessages = sqliteTable("contact_messages", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  topic: text("topic").notNull(),
  body: text("body").notNull(),
  status: text("status", { enum: ["new", "handled"] }).notNull().default("new"),
  createdAt: created(),
});

/** Every outbound email / SMS. In development the "log" transport stops here so links can be followed locally. */
export const outbox = sqliteTable(
  "outbox",
  {
    id: id(),
    channel: text("channel", { enum: ["email", "sms", "push"] }).notNull(),
    toAddress: text("to_address").notNull(),
    template: text("template").notNull(),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull(),
    transport: text("transport").notNull(),
    status: text("status", { enum: ["sent", "failed", "logged"] }).notNull(),
    error: text("error"),
    createdAt: created(),
  },
  (t) => [index("outbox_time_ix").on(t.createdAt)],
);

export const botEvents = sqliteTable(
  "bot_events",
  {
    id: id(),
    kind: text("kind").notNull(), // turnstile_fail | rate_limit | ban_evasion_block | velocity
    ipHash: text("ip_hash"),
    userId: text("user_id"),
    route: text("route").notNull().default(""),
    createdAt: created(),
  },
  (t) => [index("bot_events_ix").on(t.kind, t.createdAt)],
);

