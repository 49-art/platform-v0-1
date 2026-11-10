/**
 * Trust and safety policy as data — spec sections 8 and 9.
 * "Every action has a reason code, is logged, and can be appealed" (spec 1).
 */

export const POLICY_VERSION = "2026-11-10.1";
export const CONSENT_VERSION = "2026-11-10.1";

export type EnforcementKind = "warn" | "restrict" | "suspend" | "ban";

export interface ReasonCode {
  code: string;
  label: string;
  /** Text sent to the user in the templated notice. Plain English, no jargon. */
  notice: string;
  /** Zero-tolerance offences skip the ladder: straight to ban and escalation (spec 9). */
  zeroTolerance: boolean;
  /** Must be escalated to the Trust and safety lead / admin (spec 2: CSAM, threat to life). */
  escalate: boolean;
}

export const REASON_CODES: Record<string, ReasonCode> = {
  UNDERAGE: { code: "UNDERAGE", label: "Suspected under 18", notice: "We have reason to believe this account belongs to someone under 18. This service is for adults only.", zeroTolerance: true, escalate: true },
  CSAM: { code: "CSAM", label: "Child sexual abuse material", notice: "Your account has been closed for a serious breach of the law and our rules.", zeroTolerance: true, escalate: true },
  TRAFFICKING: { code: "TRAFFICKING", label: "Trafficking or exploitation", notice: "Your account has been closed for a serious breach of the law and our rules.", zeroTolerance: true, escalate: true },
  THREAT: { code: "THREAT", label: "Threats of violence", notice: "Threatening another person is not allowed here.", zeroTolerance: true, escalate: true },
  SELLING_SEX: { code: "SELLING_SEX", label: "Selling or buying sex, escorting, sugar arrangements", notice: "Offering or seeking paid sexual services, escorting or sugar arrangements is not allowed.", zeroTolerance: true, escalate: false },
  BOT: { code: "BOT", label: "Automated or fake account", notice: "This account appears to be automated or fake. Only real people may use this service.", zeroTolerance: false, escalate: false },
  IMPERSONATION: { code: "IMPERSONATION", label: "Impersonation or AI-generated photos", notice: "Profiles must show the real account holder. Impersonation and AI-generated photos are not allowed.", zeroTolerance: false, escalate: false },
  SCAM: { code: "SCAM", label: "Scam or request for money", notice: "Asking other members for money, crypto, gift cards or investment is not allowed.", zeroTolerance: false, escalate: false },
  HARASSMENT: { code: "HARASSMENT", label: "Harassment or pressure", notice: "Harassment, pressure and unwanted sexual messages are not allowed.", zeroTolerance: false, escalate: false },
  EXPLICIT_UNSOLICITED: { code: "EXPLICIT_UNSOLICITED", label: "Unsolicited explicit image", notice: "Sending explicit images to someone who has not opted in is not allowed.", zeroTolerance: false, escalate: false },
  HATE: { code: "HATE", label: "Hate speech or abuse", notice: "Hate speech and abuse are not allowed.", zeroTolerance: false, escalate: false },
  DOXXING: { code: "DOXXING", label: "Doxxing, stalking or intimate image abuse", notice: "Sharing someone's private information or intimate images, or stalking, is not allowed.", zeroTolerance: false, escalate: true },
  PHOTO_NUDITY: { code: "PHOTO_NUDITY", label: "Photo: nudity or sexual content", notice: "Profile photos must not contain nudity or sexual acts.", zeroTolerance: false, escalate: false },
  PHOTO_NOT_HOLDER: { code: "PHOTO_NOT_HOLDER", label: "Photo: does not show the account holder", notice: "Profile photos must clearly show you.", zeroTolerance: false, escalate: false },
  PHOTO_CHILD: { code: "PHOTO_CHILD", label: "Photo: shows a child", notice: "Photos must not include children.", zeroTolerance: false, escalate: false },
  PHOTO_WEAPON_DRUGS: { code: "PHOTO_WEAPON_DRUGS", label: "Photo: weapons or drugs", notice: "Photos must not show weapons or drugs.", zeroTolerance: false, escalate: false },
  PROFILE_TEXT: { code: "PROFILE_TEXT", label: "Profile text breaks the guidelines", notice: "Part of your profile text breaks our community guidelines.", zeroTolerance: false, escalate: false },
  CONTACT_IN_PROFILE: { code: "CONTACT_IN_PROFILE", label: "Contact details in profile", notice: "Profiles must not contain phone numbers, usernames or links.", zeroTolerance: false, escalate: false },
  BAN_EVASION: { code: "BAN_EVASION", label: "Returning after a ban", notice: "This account is linked to one that was permanently banned.", zeroTolerance: false, escalate: false },
  SPAM: { code: "SPAM", label: "Spam or mass messaging", notice: "Sending the same message to many people, or promoting other services, is not allowed.", zeroTolerance: false, escalate: false },
  OTHER: { code: "OTHER", label: "Other breach of the guidelines", notice: "Your account broke our community guidelines.", zeroTolerance: false, escalate: false },
};

/** Report reasons offered to members, mapped to queue priority (spec 8: underage, threat, CSAM, scam at top). */
export const REPORT_REASONS = {
  underage: { label: "They seem under 18", priority: 0, reasonCode: "UNDERAGE" },
  csam: { label: "Sexual content involving a child", priority: 0, reasonCode: "CSAM" },
  threat: { label: "Threat or danger to someone", priority: 0, reasonCode: "THREAT" },
  scam: { label: "Scam or asking for money", priority: 1, reasonCode: "SCAM" },
  bot: { label: "Bot or fake profile", priority: 2, reasonCode: "BOT" },
  selling_sex: { label: "Selling sex, escorting or sugar arrangement", priority: 2, reasonCode: "SELLING_SEX" },
  harassment: { label: "Harassment or pressure", priority: 2, reasonCode: "HARASSMENT" },
  explicit: { label: "Unwanted explicit image", priority: 2, reasonCode: "EXPLICIT_UNSOLICITED" },
  hate: { label: "Hate or abuse", priority: 3, reasonCode: "HATE" },
  impersonation: { label: "Pretending to be someone else", priority: 3, reasonCode: "IMPERSONATION" },
  other: { label: "Something else", priority: 4, reasonCode: "OTHER" },
} as const;
export type ReportReason = keyof typeof REPORT_REASONS;

/** Warning → restriction → suspension → ban (spec 9). */
const LADDER: EnforcementKind[] = ["warn", "restrict", "suspend", "ban"];

export function nextOnLadder(reasonCode: string, priorActionKinds: EnforcementKind[]): EnforcementKind {
  if (REASON_CODES[reasonCode]?.zeroTolerance) return "ban";
  const highest = priorActionKinds.reduce((m, k) => Math.max(m, LADDER.indexOf(k)), -1);
  return LADDER[Math.min(highest + 1, LADDER.length - 1)]!;
}

export type StaffRole = "moderator" | "senior_moderator" | "ts_lead" | "admin" | "agency_staff";

const RANK: Record<StaffRole, number> = { agency_staff: 0, moderator: 1, senior_moderator: 2, ts_lead: 3, admin: 4 };

export type Capability =
  | "queue.premod" | "queue.reports" | "user.view" | "enforce.warn" | "enforce.restrict" | "enforce.suspend_7d"
  | "enforce.suspend_long" | "enforce.ban" | "appeals.decide" | "ban_evasion.review" | "escalation.handle"
  | "policy.publish" | "le.desk" | "staff.manage" | "taxonomy.manage" | "audit.read" | "audit.export" | "dashboards.view" | "chat.open_on_report";

/** Spec 8 "Roles". Agency staff see Phase 2 portfolios only, so they hold no dating-side capability. */
const MIN_ROLE: Record<Capability, StaffRole> = {
  "queue.premod": "moderator",
  "queue.reports": "moderator",
  "user.view": "moderator",
  "chat.open_on_report": "moderator",
  "enforce.warn": "moderator",
  "enforce.restrict": "moderator",
  "enforce.suspend_7d": "moderator",
  "dashboards.view": "moderator",
  "enforce.suspend_long": "senior_moderator",
  "enforce.ban": "senior_moderator",
  "appeals.decide": "senior_moderator",
  "ban_evasion.review": "senior_moderator",
  "audit.read": "senior_moderator",
  "escalation.handle": "ts_lead",
  "policy.publish": "ts_lead",
  "le.desk": "ts_lead",
  "audit.export": "ts_lead",
  "staff.manage": "admin",
  "taxonomy.manage": "admin",
};

export function can(role: StaffRole, capability: Capability): boolean {
  if (role === "agency_staff") return false;
  return RANK[role] >= RANK[MIN_ROLE[capability]];
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const MODERATOR_MAX_SUSPENSION_MS = 7 * DAY;

/** Pre-moderation SLA. Spec: "typically within hours (target to set)" — configurable, default 4h. */
export const DEFAULT_PREMOD_SLA_MS = 4 * HOUR;
/** Report SLA by priority band. */
export const REPORT_SLA_MS: Record<number, number> = { 0: HOUR, 1: 4 * HOUR, 2: 12 * HOUR, 3: 24 * HOUR, 4: 48 * HOUR };

export const ERASE_AFTER_MS = 30 * DAY; // spec: personal data erased within 30 days
export const SESSION_TTL_MS = 30 * DAY;
export const REAUTH_WINDOW_MS = 10 * 60_000;
export const RESET_TOKEN_TTL_MS = 30 * 60_000; // spec: 30-minute token
export const EMAIL_VERIFY_TTL_MS = 24 * HOUR;

/** Auto-scan thresholds for pre-moderation. A score at or above `reject` never reaches a human as "fine". */
export const SCAN_THRESHOLDS = { nudity: { review: 0.3, reject: 0.85 }, minor: { review: 0.2 }, weapon: { review: 0.5 }, drugs: { review: 0.5 } };

export const RISK = { reviewAt: 40, autoRestrictAt: 80 };

export const MIN_AGE = 18;
export const MAX_PHOTOS = 6;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
