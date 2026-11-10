/** Data export — spec 3 "Data export": the member's own data as JSON, with links to download their photos. */
import { type DB, decryptField, decryptJson, schema, signMediaPath } from "../../core";
import { eq, or } from "drizzle-orm";
import type { Env, User } from "../env";

export async function buildExport(env: Env, db: DB, user: User, now: number) {
  const uid = user.id;
  const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, uid));
  const photos = await db.select().from(schema.photos).where(eq(schema.photos.userId, uid));
  const sent = await db.select().from(schema.messages).where(eq(schema.messages.senderId, uid));
  const [contact] = await db.select().from(schema.userContacts).where(eq(schema.userContacts.userId, uid));
  const trusted = await db.select().from(schema.trustedContacts).where(eq(schema.trustedContacts.userId, uid));
  const week = now + 7 * 86_400_000;
  const open = async (ct: string | null | undefined, ctx: string) => (ct ? decryptField(env.APP_SECRET, ct, ctx).catch(() => null) : null);
  return {
    exportedAt: new Date(now).toISOString(),
    notice: "This is the personal data we hold about you. Messages other people sent you are their data and are not included.",
    account: { id: uid, email: user.email, status: user.status, createdAt: user.createdAt, emailVerifiedAt: user.emailVerifiedAt },
    linkedAccounts: (await db.select().from(schema.oauthAccounts).where(eq(schema.oauthAccounts.userId, uid))).map((o) => ({ provider: o.provider, handle: o.handle, linkedAt: o.linkedAt })),
    consents: (await db.select().from(schema.consents).where(eq(schema.consents.userId, uid))).map(({ id: _i, userId: _u, ...rest }) => rest),
    profile: profile ? { ...profile, identityEnc: undefined, identity: await decryptJson(env.APP_SECRET, profile.identityEnc, `profile:${uid}:identity`) } : null,
    photos: await Promise.all(photos.map(async (p) => ({ id: p.id, status: p.status, purpose: p.purpose, createdAt: p.createdAt, download: p.status === "quarantined" ? null : `${env.APP_ORIGIN}${await signMediaPath(env.APP_SECRET, p.r2Key, uid, week)}` }))),
    phone: await open(contact?.phoneEnc, `contact:${uid}:phone`),
    trustedContacts: await Promise.all(trusted.map(async (t) => ({ name: await open(t.nameEnc, `trusted:${t.id}:name`), channel: t.channel, address: await open(t.addressEnc, `trusted:${t.id}:address`) }))),
    ageChecks: (await db.select().from(schema.ageChecks).where(eq(schema.ageChecks.userId, uid))).map((a) => ({ status: a.status, method: a.method, at: a.decidedAt ?? a.createdAt })),
    identityVerifications: (await db.select().from(schema.idVerifications).where(eq(schema.idVerifications.userId, uid))).map((v) => ({ status: v.status, at: v.decidedAt ?? v.createdAt })),
    likesGiven: (await db.select().from(schema.likes).where(eq(schema.likes.fromUser, uid))).map((l) => ({ kind: l.kind, at: l.createdAt })),
    matches: (await db.select().from(schema.matches).where(or(eq(schema.matches.userA, uid), eq(schema.matches.userB, uid)))).map((m) => ({ id: m.id, at: m.createdAt })),
    messagesSent: await Promise.all(sent.map(async (m) => ({ conversationId: m.conversationId, at: m.createdAt, kind: m.kind, text: await open(m.bodyEnc, `message:${m.id}`) }))),
    dates: (await db.select().from(schema.dates).where(or(eq(schema.dates.proposerId, uid), eq(schema.dates.inviteeId, uid)))).map((d) => ({ id: d.id, status: d.status, startsAt: d.startsAt })),
    reportsMade: (await db.select().from(schema.reports).where(eq(schema.reports.reporterId, uid))).map((r) => ({ id: r.id, reason: r.reason, status: r.status, outcome: r.outcome, at: r.createdAt })),
    moderationActions: (await db.select().from(schema.enforcementActions).where(eq(schema.enforcementActions.userId, uid))).map((a) => ({ id: a.id, kind: a.kind, reasonCode: a.reasonCode, at: a.createdAt, expiresAt: a.expiresAt, liftedAt: a.liftedAt })),
    notifications: (await db.select().from(schema.notifications).where(eq(schema.notifications.userId, uid))).map((n) => ({ kind: n.kind, title: n.title, at: n.createdAt })),
  };
}
