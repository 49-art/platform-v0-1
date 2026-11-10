/**
 * Domain services shared by the member app and the admin console.
 * Anything that changes a member's standing lives here so both Workers apply identical rules.
 */
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { hmacHex, newId } from "./crypto";
import {
  DEFAULT_PREMOD_SLA_MS, type EnforcementKind, ERASE_AFTER_MS, MODERATOR_MAX_SUSPENSION_MS, REASON_CODES, REPORT_REASONS,
  type ReportReason, RISK, type StaffRole, can,
} from "./policy";
import { type OutboundMessage, type ProviderEnv, sendMessage } from "./providers";
import * as s from "./schema";

export function makeDb(d1: D1Database) {
  return drizzle(d1, { schema: s });
}
export type DB = ReturnType<typeof makeDb>;

export interface CoreEnv extends ProviderEnv {
  DB: D1Database;
}

export interface Actor {
  id: string; // staff id, user id, or "system"
  role: StaffRole | "system" | "member";
}
export const SYSTEM: Actor = { id: "system", role: "system" };

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

/* ── Audit (spec 8: append-only, every sensitive view and every action) ── */

export async function audit(db: DB, actor: Actor, action: string, targetType: string, targetId: string, detail: Record<string, unknown> = {}, now = Date.now()) {
  await db.insert(s.auditLog).values({ id: newId("aud"), actorId: actor.id, actorRole: actor.role, action, targetType, targetId, detail: JSON.stringify(detail), createdAt: now });
}

/* ── Notifications and outbound messages ── */

export async function notify(db: DB, userId: string, n: { kind: string; title: string; body?: string; href?: string }, now = Date.now()) {
  const id = newId("ntf");
  await db.insert(s.notifications).values({ id, userId, kind: n.kind, title: n.title, body: n.body ?? "", href: n.href ?? "", createdAt: now });
  return id;
}

export async function deliver(env: CoreEnv, db: DB, msg: OutboundMessage, now = Date.now()) {
  const result = await sendMessage(env, msg);
  await db.insert(s.outbox).values({
    id: newId("out"), channel: msg.channel, toAddress: msg.to, template: msg.template, subject: msg.subject, body: msg.body,
    transport: result.transport, status: result.status, error: result.error ?? null, createdAt: now,
  });
  return result;
}

export const blindIndex = (env: { APP_SECRET: string }, kind: string, value: string) => hmacHex(env.APP_SECRET, `blind/${kind}`, value.trim().toLowerCase());

/* ── Risk score (spec 8: scam and spam flags feed a per-account score) ── */

export async function addRisk(db: DB, userId: string, delta: number, why: string, now = Date.now()) {
  const [row] = await db.update(s.users).set({ riskScore: sql`min(100, ${s.users.riskScore} + ${delta})` }).where(eq(s.users.id, userId)).returning({ riskScore: s.users.riskScore, restrictedUntil: s.users.restrictedUntil });
  if (!row) return 0;
  await audit(db, SYSTEM, "risk.add", "user", userId, { delta, why, score: row.riskScore }, now);
  if (row.riskScore >= RISK.autoRestrictAt && !(row.restrictedUntil && row.restrictedUntil > now)) {
    // Hold messaging and put a human in the loop; a moderator confirms or lifts it.
    await db.update(s.users).set({ restrictedUntil: now + 24 * 3_600_000 }).where(eq(s.users.id, userId));
    await db.insert(s.enforcementActions).values({ id: newId("enf"), userId, kind: "restrict", reasonCode: "SCAM", note: `Automatic 24h hold: risk score ${row.riskScore} (${why})`, actorId: "system", expiresAt: now + 24 * 3_600_000, createdAt: now });
    await db.insert(s.reports).values({ id: newId("rep"), reporterId: "system", subjectUserId: userId, reason: "scam", detail: `System: risk score reached ${row.riskScore} (${why}). Messaging held for 24h pending review.`, priority: 1, createdAt: now });
    await notify(db, userId, { kind: "moderation", title: "Messaging is paused on your account", body: "Our safety checks paused your messaging while a moderator takes a look. You can appeal from Settings.", href: "/app/settings" }, now);
  }
  return row.riskScore;
}

/* ── Pre-moderation queue ── */

export async function enqueueModeration(db: DB, item: { kind: "profile" | "photo" | "ban_evasion" | "idv_review"; refId: string; userId: string; scores?: unknown; slaMs?: number }, now = Date.now()) {
  const id = newId("mq");
  await db.insert(s.modQueue).values({ id, kind: item.kind, refId: item.refId, userId: item.userId, scores: JSON.stringify(item.scores ?? {}), slaDueAt: now + (item.slaMs ?? DEFAULT_PREMOD_SLA_MS), createdAt: now });
  return id;
}

/* ── Ban-evasion detection (spec 8) ── */

export type SignalKind = "email" | "phone" | "device" | "photo" | "id_duplicate" | "x_account";

export async function matchBanSignals(db: DB, signals: { kind: SignalKind; hash: string | null | undefined }[]) {
  const live = signals.filter((x): x is { kind: SignalKind; hash: string } => !!x.hash);
  if (live.length === 0) return [];
  const rows = await db.select().from(s.banSignals).where(or(...live.map((x) => and(eq(s.banSignals.kind, x.kind), eq(s.banSignals.hash, x.hash)))));
  return rows;
}

/**
 * Strong identifiers (same verified email, same government ID, same X account) block outright.
 * Weak ones (device, photo) can collide innocently, so they queue for a senior moderator.
 */
export function banEvasionVerdict(matches: { kind: SignalKind }[]): "clear" | "review" | "block" {
  if (matches.some((m) => m.kind === "email" || m.kind === "id_duplicate" || m.kind === "x_account" || m.kind === "phone")) return "block";
  return matches.length > 0 ? "review" : "clear";
}

async function recordBanSignals(env: CoreEnv, db: DB, userId: string, now: number) {
  const [u] = await db.select().from(s.users).where(eq(s.users.id, userId));
  if (!u) return;
  const rows: { kind: SignalKind; hash: string }[] = [];
  if (u.emailHash) rows.push({ kind: "email", hash: u.emailHash });
  if (u.deviceHash) rows.push({ kind: "device", hash: u.deviceHash });
  const [contact] = await db.select().from(s.userContacts).where(eq(s.userContacts.userId, userId));
  if (contact?.phoneHash) rows.push({ kind: "phone", hash: contact.phoneHash });
  for (const o of await db.select().from(s.oauthAccounts).where(eq(s.oauthAccounts.userId, userId))) rows.push({ kind: "x_account", hash: await blindIndex(env, "x", o.providerUserId) });
  for (const p of await db.select().from(s.photos).where(and(eq(s.photos.userId, userId), eq(s.photos.purpose, "profile")))) if (p.contentHash) rows.push({ kind: "photo", hash: p.contentHash });
  for (const v of await db.select().from(s.idVerifications).where(eq(s.idVerifications.userId, userId))) if (v.duplicateSignalHash) rows.push({ kind: "id_duplicate", hash: v.duplicateSignalHash });
  for (const r of rows) await db.insert(s.banSignals).values({ id: newId("bs"), kind: r.kind, hash: r.hash, sourceUserId: userId, createdAt: now }).onConflictDoNothing();
}

/* ── Enforcement (spec 8: warn, restrict, suspend, ban with reason codes and templated notices) ── */

export interface EnforcementInput {
  userId: string;
  kind: EnforcementKind;
  reasonCode: string;
  note?: string;
  reportId?: string;
  durationMs?: number; // restrict / suspend
}

export async function applyEnforcement(env: CoreEnv, db: DB, actor: Actor, input: EnforcementInput, now = Date.now()) {
  const reason = REASON_CODES[input.reasonCode];
  if (!reason) throw new DomainError("bad_reason", "Unknown reason code");
  const [user] = await db.select().from(s.users).where(eq(s.users.id, input.userId));
  if (!user) throw new DomainError("not_found", "No such member", 404);

  if (actor.role !== "system") {
    const role = actor.role as StaffRole;
    const cap = input.kind === "warn" ? "enforce.warn" : input.kind === "restrict" ? "enforce.restrict" : input.kind === "ban" ? "enforce.ban"
      : (input.durationMs ?? 0) > MODERATOR_MAX_SUSPENSION_MS ? "enforce.suspend_long" : "enforce.suspend_7d";
    if (!can(role, cap)) throw new DomainError("forbidden", "Your role cannot take this action", 403);
  }
  if ((input.kind === "restrict" || input.kind === "suspend") && !(input.durationMs && input.durationMs > 0)) throw new DomainError("bad_duration", "A duration is required");

  const expiresAt = input.kind === "restrict" || input.kind === "suspend" ? now + input.durationMs! : null;
  const id = newId("enf");
  await db.insert(s.enforcementActions).values({ id, userId: input.userId, kind: input.kind, reasonCode: input.reasonCode, note: input.note ?? "", reportId: input.reportId ?? null, actorId: actor.id, expiresAt, createdAt: now });

  if (input.kind === "restrict") await db.update(s.users).set({ restrictedUntil: expiresAt }).where(eq(s.users.id, input.userId));
  if (input.kind === "suspend") await db.update(s.users).set({ status: "suspended", suspendedUntil: expiresAt }).where(eq(s.users.id, input.userId));
  if (input.kind === "ban") {
    await db.update(s.users).set({ status: "banned", suspendedUntil: null }).where(eq(s.users.id, input.userId));
    await recordBanSignals(env, db, input.userId, now);
  }
  if (input.kind === "suspend" || input.kind === "ban") {
    // Out of sight and out of the conversation at once (spec 6: "freezes the conversation").
    await db.update(s.sessions).set({ revokedAt: now }).where(and(eq(s.sessions.userId, input.userId), isNull(s.sessions.revokedAt)));
    await db.update(s.profiles).set({ status: "hidden", updatedAt: now }).where(and(eq(s.profiles.userId, input.userId), inArray(s.profiles.status, ["approved", "pending"])));
    await db.update(s.conversations).set({ status: "frozen", frozenReason: input.kind === "ban" ? "member_banned" : "member_suspended" })
      .where(and(or(eq(s.conversations.userA, input.userId), eq(s.conversations.userB, input.userId)), eq(s.conversations.status, "open")));
  }

  const until = expiresAt ? ` until ${new Date(expiresAt).toUTCString()}` : "";
  const headline = { warn: "A warning about your account", restrict: `Messaging is paused on your account${until}`, suspend: `Your account is suspended${until}`, ban: "Your account has been permanently closed" }[input.kind];
  const body = `${reason.notice}\n\nReference: ${id}\nReason code: ${reason.code}\n\nIf you think this is a mistake you can appeal: ${env.APP_ORIGIN}/appeal?ref=${id}`;
  await notify(db, input.userId, { kind: "moderation", title: headline, body: reason.notice, href: `/appeal?ref=${id}` }, now);
  if (user.email) await deliver(env, db, { channel: "email", to: user.email, template: `enforcement_${input.kind}`, subject: headline, body }, now);
  await audit(db, actor, `enforce.${input.kind}`, "user", input.userId, { actionId: id, reasonCode: input.reasonCode, expiresAt, reportId: input.reportId }, now);

  if (reason.escalate) {
    await db.insert(s.reports).values({ id: newId("rep"), reporterId: "system", subjectUserId: input.userId, reason: "other", detail: `Escalation required: ${reason.label} (action ${id}).`, priority: 0, status: "escalated", createdAt: now });
  }
  return { id, expiresAt };
}

/** Undo an action (appeal overturned, or a senior moderator lifting it). Ban signals written for it are removed. */
export async function liftEnforcement(env: CoreEnv, db: DB, actor: Actor, actionId: string, note: string, now = Date.now()) {
  const [action] = await db.select().from(s.enforcementActions).where(eq(s.enforcementActions.id, actionId));
  if (!action) throw new DomainError("not_found", "No such action", 404);
  if (action.liftedAt) return action;
  await db.update(s.enforcementActions).set({ liftedAt: now }).where(eq(s.enforcementActions.id, actionId));
  const userId = action.userId;
  // Re-derive standing from whatever other actions are still in force.
  const live = await db.select().from(s.enforcementActions).where(and(eq(s.enforcementActions.userId, userId), isNull(s.enforcementActions.liftedAt)));
  const active = (k: EnforcementKind) => live.filter((a) => a.kind === k && (a.kind === "ban" || (a.expiresAt ?? 0) > now));
  const banned = active("ban").length > 0;
  const suspendedUntil = Math.max(0, ...active("suspend").map((a) => a.expiresAt ?? 0));
  const restrictedUntil = Math.max(0, ...active("restrict").map((a) => a.expiresAt ?? 0));
  const [u] = await db.select().from(s.users).where(eq(s.users.id, userId));
  if (u && u.status !== "deleted") {
    await db.update(s.users).set({ status: banned ? "banned" : suspendedUntil ? "suspended" : "active", suspendedUntil: suspendedUntil || null, restrictedUntil: restrictedUntil || null }).where(eq(s.users.id, userId));
    if (!banned && !suspendedUntil) {
      await db.update(s.profiles).set({ status: "approved", updatedAt: now }).where(and(eq(s.profiles.userId, userId), eq(s.profiles.status, "hidden"), sql`${s.profiles.approvedAt} is not null`));
      await db.update(s.conversations).set({ status: "open", frozenReason: null })
        .where(and(or(eq(s.conversations.userA, userId), eq(s.conversations.userB, userId)), eq(s.conversations.status, "frozen"), inArray(s.conversations.frozenReason, ["member_banned", "member_suspended"])));
    }
  }
  if (action.kind === "ban" && !banned) await db.delete(s.banSignals).where(eq(s.banSignals.sourceUserId, userId));
  await notify(db, userId, { kind: "moderation", title: "An action on your account was lifted", body: note, href: "/app/settings" }, now);
  if (u?.email) await deliver(env, db, { channel: "email", to: u.email, template: "enforcement_lifted", subject: "An action on your account was lifted", body: `${note}\n\nReference: ${actionId}` }, now);
  await audit(db, actor, "enforce.lift", "user", userId, { actionId, note }, now);
  return action;
}

/** Timed restrictions and suspensions end on their own. Called on read so no cron is needed for correctness. */
export async function expireStanding(db: DB, user: typeof s.users.$inferSelect, now = Date.now()) {
  let changed = false;
  if (user.status === "suspended" && user.suspendedUntil && user.suspendedUntil <= now) {
    await db.update(s.users).set({ status: "active", suspendedUntil: null }).where(eq(s.users.id, user.id));
    await db.update(s.profiles).set({ status: "approved", updatedAt: now }).where(and(eq(s.profiles.userId, user.id), eq(s.profiles.status, "hidden"), sql`${s.profiles.approvedAt} is not null`));
    await db.update(s.conversations).set({ status: "open", frozenReason: null }).where(and(or(eq(s.conversations.userA, user.id), eq(s.conversations.userB, user.id)), eq(s.conversations.frozenReason, "member_suspended")));
    user.status = "active";
    user.suspendedUntil = null;
    changed = true;
  }
  if (user.restrictedUntil && user.restrictedUntil <= now) {
    await db.update(s.users).set({ restrictedUntil: null }).where(eq(s.users.id, user.id));
    user.restrictedUntil = null;
    changed = true;
  }
  return changed;
}

/* ── Reports (spec 2 "Reporter": acknowledgement, then an outcome notice) ── */

export async function createReport(db: DB, input: { reporterId: string; subjectUserId: string; reason: ReportReason; detail?: string; conversationId?: string }, now = Date.now()) {
  const def = REPORT_REASONS[input.reason];
  if (!def) throw new DomainError("bad_reason", "Unknown report reason");
  if (input.reporterId === input.subjectUserId) throw new DomainError("self_report", "You cannot report yourself");
  // Same reporter, same subject, same reason, still open: fold into the existing report rather than flooding the queue.
  const [dupe] = await db.select().from(s.reports).where(and(eq(s.reports.reporterId, input.reporterId), eq(s.reports.subjectUserId, input.subjectUserId), eq(s.reports.reason, input.reason), inArray(s.reports.status, ["open", "assigned", "escalated"])));
  if (dupe) return { id: dupe.id, duplicate: true };

  // Reporter trust (spec 8): people whose past reports led to action are heard sooner; serial false reporters are not.
  const past = await db.select({ outcome: s.reports.outcome }).from(s.reports).where(and(eq(s.reports.reporterId, input.reporterId), eq(s.reports.status, "resolved")));
  const good = past.filter((p) => p.outcome === "action_taken").length;
  const bad = past.filter((p) => p.outcome === "no_action").length;
  let priority: number = def.priority;
  if (priority > 0 && good >= 2 && good > bad) priority -= 1;
  if (priority > 0 && priority < 4 && bad >= 5 && bad > good * 3) priority += 1;

  const id = newId("rep");
  await db.insert(s.reports).values({ id, reporterId: input.reporterId, subjectUserId: input.subjectUserId, conversationId: input.conversationId ?? null, reason: input.reason, detail: (input.detail ?? "").slice(0, 2000), priority, status: priority === 0 ? "escalated" : "open", createdAt: now });
  await notify(db, input.reporterId, { kind: "report_ack", title: "We have your report", body: `Thank you. A moderator will review it. Reference ${id}.`, href: "/app/settings" }, now);
  await audit(db, { id: input.reporterId, role: "member" }, "report.create", "user", input.subjectUserId, { reportId: id, reason: input.reason, priority }, now);

  // An underage report suspends first and reviews second (spec 9: "immediate suspension and review").
  if (input.reason === "underage") {
    await db.update(s.users).set({ status: "suspended", suspendedUntil: now + 7 * 86_400_000 }).where(and(eq(s.users.id, input.subjectUserId), eq(s.users.status, "active")));
    await db.update(s.profiles).set({ status: "hidden", updatedAt: now }).where(and(eq(s.profiles.userId, input.subjectUserId), eq(s.profiles.status, "approved")));
    await db.insert(s.enforcementActions).values({ id: newId("enf"), userId: input.subjectUserId, kind: "suspend", reasonCode: "UNDERAGE", note: `Precautionary suspension pending review of report ${id}`, reportId: id, actorId: "system", expiresAt: now + 7 * 86_400_000, createdAt: now });
    await db.update(s.sessions).set({ revokedAt: now }).where(and(eq(s.sessions.userId, input.subjectUserId), isNull(s.sessions.revokedAt)));
    await db.update(s.conversations).set({ status: "frozen", frozenReason: "member_suspended" }).where(and(or(eq(s.conversations.userA, input.subjectUserId), eq(s.conversations.userB, input.subjectUserId)), eq(s.conversations.status, "open")));
  }
  return { id, duplicate: false };
}

export async function resolveReport(db: DB, actor: Actor, reportId: string, outcome: "action_taken" | "no_action" | "escalated", note: string, now = Date.now()) {
  const [report] = await db.select().from(s.reports).where(eq(s.reports.id, reportId));
  if (!report) throw new DomainError("not_found", "No such report", 404);
  if (outcome === "escalated") {
    await db.update(s.reports).set({ status: "escalated", priority: 0, outcomeNote: note }).where(eq(s.reports.id, reportId));
  } else {
    await db.update(s.reports).set({ status: "resolved", outcome, outcomeNote: note, resolvedAt: now }).where(or(eq(s.reports.id, reportId), eq(s.reports.mergedInto, reportId)));
    const reporters = new Set([report.reporterId, ...(await db.select({ r: s.reports.reporterId }).from(s.reports).where(eq(s.reports.mergedInto, reportId))).map((x) => x.r)]);
    for (const r of reporters) {
      if (r === "system") continue;
      // The reporter learns that we acted, never what the action was or anything about the other person.
      await notify(db, r, { kind: "report_outcome", title: "Update on your report", body: outcome === "action_taken" ? "We reviewed your report and took action under our community guidelines. Thank you for helping keep people safe." : "We reviewed your report and did not find a breach of our guidelines this time. You can block this person at any point.", href: "/app/settings" }, now);
    }
  }
  await audit(db, actor, `report.${outcome}`, "report", reportId, { note }, now);
}

/* ── Account deletion (spec 3): hidden at once, erased on schedule, some records retained ── */

export async function requestDeletion(env: CoreEnv, db: DB, userId: string, now = Date.now()) {
  const [u] = await db.select().from(s.users).where(eq(s.users.id, userId));
  if (!u) throw new DomainError("not_found", "No such member", 404);
  await db.update(s.users).set({ status: u.status === "banned" ? "banned" : "deleted", deletedAt: now, eraseAfter: now + ERASE_AFTER_MS }).where(eq(s.users.id, userId));
  await db.update(s.profiles).set({ status: "hidden", updatedAt: now }).where(eq(s.profiles.userId, userId));
  await db.update(s.sessions).set({ revokedAt: now }).where(and(eq(s.sessions.userId, userId), isNull(s.sessions.revokedAt)));
  await db.update(s.conversations).set({ status: "closed", frozenReason: "member_left" }).where(or(eq(s.conversations.userA, userId), eq(s.conversations.userB, userId)));
  await db.delete(s.pushSubscriptions).where(eq(s.pushSubscriptions.userId, userId));
  if (u.email) await deliver(env, db, { channel: "email", to: u.email, template: "account_deleted", subject: "Your account has been deleted", body: `Your profile is hidden now and your personal data will be erased within 30 days.\n\nWe keep a small set of records where the law or safety requires it: moderation and ban records, anything under a legal hold, and financial records.\n\nIf you did not ask for this, contact us straight away: ${env.APP_ORIGIN}/contact` }, now);
  await audit(db, { id: userId, role: "member" }, "account.delete_requested", "user", userId, { eraseAfter: now + ERASE_AFTER_MS }, now);
}

/**
 * Scheduled erasure. Removes personal data for accounts past their erase date, unless a legal hold applies.
 * Kept by design: enforcement actions, reports, audit log, ban-signal hashes (all keyed by an opaque id only).
 * Returns the R2 keys the caller must delete from the bucket.
 */
export async function eraseDueAccounts(db: DB, now = Date.now(), limit = 50): Promise<{ erased: string[]; r2Keys: string[]; held: string[] }> {
  const due = await db.select().from(s.users).where(and(sql`${s.users.eraseAfter} is not null`, sql`${s.users.eraseAfter} <= ${now}`)).limit(limit);
  const erased: string[] = [], r2Keys: string[] = [], held: string[] = [];
  for (const u of due) {
    const [hold] = await db.select().from(s.legalHolds).where(and(eq(s.legalHolds.userId, u.id), gt(s.legalHolds.until, now)));
    if (hold) { held.push(u.id); continue; }
    const ph = await db.select({ key: s.photos.r2Key }).from(s.photos).where(eq(s.photos.userId, u.id));
    r2Keys.push(...ph.map((p) => p.key));
    const convs = await db.select({ id: s.conversations.id }).from(s.conversations).where(or(eq(s.conversations.userA, u.id), eq(s.conversations.userB, u.id)));
    await db.delete(s.photos).where(eq(s.photos.userId, u.id));
    await db.delete(s.profiles).where(eq(s.profiles.userId, u.id));
    await db.delete(s.messages).where(eq(s.messages.senderId, u.id));
    await db.delete(s.flaggedMessages).where(eq(s.flaggedMessages.senderId, u.id));
    await db.delete(s.likes).where(or(eq(s.likes.fromUser, u.id), eq(s.likes.toUser, u.id)));
    await db.delete(s.matches).where(or(eq(s.matches.userA, u.id), eq(s.matches.userB, u.id)));
    await db.delete(s.blocks).where(or(eq(s.blocks.blocker, u.id), eq(s.blocks.blocked, u.id)));
    await db.delete(s.consents).where(eq(s.consents.userId, u.id));
    await db.delete(s.userContacts).where(eq(s.userContacts.userId, u.id));
    await db.delete(s.trustedContacts).where(eq(s.trustedContacts.userId, u.id));
    await db.delete(s.dateSafety).where(eq(s.dateSafety.userId, u.id));
    if (convs.length) await db.delete(s.dates).where(inArray(s.dates.conversationId, convs.map((c) => c.id)));
    await db.delete(s.notifications).where(eq(s.notifications.userId, u.id));
    await db.delete(s.oauthAccounts).where(eq(s.oauthAccounts.userId, u.id));
    await db.delete(s.sessions).where(eq(s.sessions.userId, u.id));
    await db.delete(s.authTokens).where(eq(s.authTokens.userId, u.id));
    await db.delete(s.ageChecks).where(eq(s.ageChecks.userId, u.id));
    await db.delete(s.idVerifications).where(eq(s.idVerifications.userId, u.id));
    // The user row stays as a tombstone so retained moderation records still resolve to an id.
    await db.update(s.users).set({ email: null, emailHash: null, passwordHash: null, deviceHash: null, eraseAfter: null, emailVerifiedAt: null }).where(eq(s.users.id, u.id));
    await audit(db, SYSTEM, "account.erased", "user", u.id, { photos: ph.length }, now);
    erased.push(u.id);
  }
  return { erased, r2Keys, held };
}

/* ── Read helpers used by both apps ── */

export async function memberFlags(db: DB, userId: string) {
  const [age] = await db.select().from(s.ageChecks).where(and(eq(s.ageChecks.userId, userId), eq(s.ageChecks.status, "passed"))).limit(1);
  const [idv] = await db.select().from(s.idVerifications).where(eq(s.idVerifications.userId, userId)).orderBy(desc(s.idVerifications.createdAt)).limit(1);
  const [profile] = await db.select({ status: s.profiles.status, rejectionReason: s.profiles.rejectionReason }).from(s.profiles).where(eq(s.profiles.userId, userId));
  return {
    agePassed: !!age,
    idVerified: idv?.status === "passed",
    idStatus: (idv?.status ?? "none") as "none" | "pending" | "passed" | "failed" | "review",
    profileStatus: (profile?.status ?? "none") as "none" | "draft" | "pending" | "approved" | "rejected" | "hidden",
    profileRejection: profile?.rejectionReason ?? null,
  };
}

export async function isVerified(db: DB, userId: string) {
  const [v] = await db.select({ id: s.idVerifications.id }).from(s.idVerifications).where(and(eq(s.idVerifications.userId, userId), eq(s.idVerifications.status, "passed"))).limit(1);
  return !!v;
}

export async function isBlockedEitherWay(db: DB, a: string, b: string) {
  const [row] = await db.select().from(s.blocks).where(or(and(eq(s.blocks.blocker, a), eq(s.blocks.blocked, b)), and(eq(s.blocks.blocker, b), eq(s.blocks.blocked, a)))).limit(1);
  return !!row;
}

export async function hasActiveConsent(db: DB, userId: string, kind: (typeof s.consents.$inferSelect)["kind"], scope = "") {
  const [row] = await db.select({ id: s.consents.id }).from(s.consents).where(and(eq(s.consents.userId, userId), eq(s.consents.kind, kind), eq(s.consents.scope, scope), isNull(s.consents.withdrawnAt))).limit(1);
  return !!row;
}

/* ── Pre-moderation decisions (spec 8: approve / reject with reason) ── */

export interface ModerationResult {
  /** R2 objects the caller must delete (rejected media). */
  r2KeysToDelete: string[];
  /** A held chat image was approved: the member app must now deliver it into the conversation. */
  deliverChatPhotoId?: string;
  /** The member's standing changed and their live connections should be dropped. */
  disconnectUserId?: string;
  notifyUserId: string;
}

export async function decideModeration(env: CoreEnv, db: DB, actor: Actor, queueId: string, decision: "approve" | "reject" | "escalate", reasonCode: string | undefined, now = Date.now()): Promise<ModerationResult> {
  const [item] = await db.select().from(s.modQueue).where(eq(s.modQueue.id, queueId));
  if (!item) throw new DomainError("not_found", "No such queue item", 404);
  if (item.status !== "pending") throw new DomainError("already_decided", "Someone has already handled this item", 409);
  const role = actor.role as StaffRole;
  const needed = item.kind === "ban_evasion" ? "ban_evasion.review" : "queue.premod";
  if (actor.role === "system" || actor.role === "member" || !can(role, needed)) throw new DomainError("forbidden", "Your role cannot handle this item", 403);
  if (decision === "reject" && !(reasonCode && REASON_CODES[reasonCode])) throw new DomainError("reason_required", "A reason code is required to reject");
  const reason = reasonCode ? REASON_CODES[reasonCode] : undefined;
  const result: ModerationResult = { r2KeysToDelete: [], notifyUserId: item.userId };

  if (decision === "escalate") {
    await db.update(s.modQueue).set({ status: "escalated", decidedBy: actor.id, decidedAt: now, reasonCode: reasonCode ?? null }).where(eq(s.modQueue.id, queueId));
    await db.insert(s.reports).values({ id: newId("rep"), reporterId: "system", subjectUserId: item.userId, reason: "other", detail: `Escalated from pre-moderation (${item.kind} ${item.refId})${reason ? `: ${reason.label}` : ""}.`, priority: 0, status: "escalated", createdAt: now });
    await audit(db, actor, "premod.escalate", item.kind, item.refId, { queueId, reasonCode }, now);
    return result;
  }

  if (item.kind === "profile") {
    if (decision === "approve") {
      const approved = await db.select({ id: s.photos.id }).from(s.photos).where(and(eq(s.photos.userId, item.userId), eq(s.photos.purpose, "profile"), eq(s.photos.status, "approved")));
      if (approved.length === 0) throw new DomainError("photo_first", "Approve at least one of this member's photos before approving the profile", 409);
      await db.update(s.profiles).set({ status: "approved", approvedAt: now, rejectionReason: null, updatedAt: now }).where(eq(s.profiles.userId, item.userId));
      await notify(db, item.userId, { kind: "moderation", title: "Your profile is live", body: "You can browse and match now.", href: "/app/discover" }, now);
    } else {
      await db.update(s.profiles).set({ status: "rejected", rejectionReason: reason!.notice, updatedAt: now }).where(eq(s.profiles.userId, item.userId));
      await notify(db, item.userId, { kind: "moderation", title: "Your profile needs a change", body: reason!.notice, href: "/app/profile" }, now);
    }
  } else if (item.kind === "photo") {
    const [photo] = await db.select().from(s.photos).where(eq(s.photos.id, item.refId));
    if (photo && photo.status === "pending") {
      if (decision === "approve") {
        await db.update(s.photos).set({ status: "approved" }).where(eq(s.photos.id, photo.id));
        if (photo.purpose === "chat") result.deliverChatPhotoId = photo.id;
      } else {
        await db.update(s.photos).set({ status: "rejected" }).where(eq(s.photos.id, photo.id));
        result.r2KeysToDelete.push(photo.r2Key);
        await notify(db, item.userId, { kind: "moderation", title: "A photo was not accepted", body: reason!.notice, href: photo.purpose === "chat" ? "/app/matches" : "/app/profile" }, now);
        // A zero-tolerance finding on a photo is an account matter, not just a photo matter.
        if (reason!.zeroTolerance) { await applyEnforcement(env, db, SYSTEM, { userId: item.userId, kind: "ban", reasonCode: reason!.code, note: `Pre-moderation finding on ${photo.id} by ${actor.id}` }, now); result.disconnectUserId = item.userId; }
      }
    }
  } else if (item.kind === "idv_review") {
    const status = decision === "approve" ? "passed" : "failed";
    await db.update(s.idVerifications).set({ status, decidedAt: now, reviewNote: `Manual review by ${actor.id}${reason ? `: ${reason.label}` : ""}` }).where(and(eq(s.idVerifications.id, item.refId), eq(s.idVerifications.status, "review")));
    await notify(db, item.userId, decision === "approve" ? { kind: "verification", title: "You are verified", body: "Your Verified badge is live.", href: "/app/matches" } : { kind: "verification", title: "Verification did not pass", body: "Our team could not confirm your identity. You can try again.", href: "/app/verify" }, now);
  } else if (item.kind === "ban_evasion") {
    if (decision === "reject") { await applyEnforcement(env, db, actor, { userId: item.userId, kind: "ban", reasonCode: "BAN_EVASION", note: `Ban-evasion review ${queueId}` }, now); result.disconnectUserId = item.userId; }
  }

  await db.update(s.modQueue).set({ status: decision === "approve" ? "approved" : "rejected", decidedBy: actor.id, decidedAt: now, reasonCode: reasonCode ?? null }).where(eq(s.modQueue.id, queueId));
  await audit(db, actor, `premod.${decision}`, item.kind, item.refId, { queueId, reasonCode, userId: item.userId }, now);
  return result;
}

/** Appeals are decided by a senior moderator who did not take the original action (spec 8: appeals workflow). */
export async function decideAppeal(env: CoreEnv, db: DB, actor: Actor, appealId: string, decision: "upheld" | "overturned", note: string, now = Date.now()) {
  if (actor.role === "system" || actor.role === "member" || !can(actor.role as StaffRole, "appeals.decide")) throw new DomainError("forbidden", "Your role cannot decide appeals", 403);
  const [appeal] = await db.select().from(s.appeals).where(eq(s.appeals.id, appealId));
  if (!appeal) throw new DomainError("not_found", "No such appeal", 404);
  if (appeal.status !== "open") throw new DomainError("already_decided", "This appeal has already been decided", 409);
  const [action] = await db.select().from(s.enforcementActions).where(eq(s.enforcementActions.id, appeal.actionId));
  if (action?.actorId === actor.id) throw new DomainError("conflict_of_interest", "An appeal must be decided by someone other than the person who took the action", 403);
  await db.update(s.appeals).set({ status: decision, decidedBy: actor.id, decisionNote: note, decidedAt: now }).where(eq(s.appeals.id, appealId));
  await audit(db, actor, `appeal.${decision}`, "appeal", appealId, { actionId: appeal.actionId, note }, now);
  if (decision === "overturned") await liftEnforcement(env, db, actor, appeal.actionId, `Your appeal was successful. ${note}`.trim(), now);
  else {
    await notify(db, appeal.userId, { kind: "moderation", title: "Your appeal was reviewed", body: `We looked again and the original decision stands. ${note}`.trim(), href: "/appeal" }, now);
    const [u] = await db.select().from(s.users).where(eq(s.users.id, appeal.userId));
    if (u?.email) await deliver(env, db, { channel: "email", to: u.email, template: "appeal_upheld", subject: "Your appeal was reviewed", body: `We looked again and the original decision stands.\n\n${note}\n\nReference: ${appeal.actionId}` }, now);
  }
  return { userId: appeal.userId };
}
