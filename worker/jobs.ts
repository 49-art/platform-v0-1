/**
 * Queue consumers and the scheduled sweep (spec 11 "Async: scans, notifications, webhooks, deletion, export").
 * Each job is idempotent: queues deliver at least once.
 */
import {
  FLAG_RISK, type FlagCode, SCAN_THRESHOLDS, SYSTEM, addRisk, applyEnforcement, audit, blindIndex, deliver, encryptField, enqueueModeration, eraseDueAccounts,
  hasActiveConsent, imageScanner, makeDb, messageFingerprint, newId, notify, schema,
} from "../core";
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { Env, Job } from "./env";
import { dispatch } from "./lib/dispatch";
import { getMedia, removeMedia } from "./lib/media";
import { sendPush } from "./lib/push";

const HOUR = 3_600_000;
const room = (env: Env, id: string) => env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(id));
const hub = (env: Env, id: string) => env.USER_HUB.get(env.USER_HUB.idFromName(id));

/** Spec 8 "CSAM path": media quarantined, account frozen, not re-viewed, escalated, evidence preserved. */
async function csamPath(env: Env, photo: typeof schema.photos.$inferSelect, now: number) {
  const db = makeDb(env.DB);
  await db.update(schema.photos).set({ status: "quarantined" }).where(eq(schema.photos.id, photo.id));
  // A hold stops the scheduled erasure from destroying evidence if the account is deleted. Retention period is [LEGAL].
  await db.insert(schema.legalHolds).values({ userId: photo.userId, leRequestId: `csam:${photo.id}`, until: now + 10 * 365 * 24 * HOUR, createdAt: now }).onConflictDoNothing();
  await applyEnforcement(env, db, SYSTEM, { userId: photo.userId, kind: "suspend", reasonCode: "CSAM", note: `Hash match on upload ${photo.id}. Media quarantined. Account frozen pending Trust and safety lead.`, durationMs: 10 * 365 * 24 * HOUR }, now);
  await audit(db, SYSTEM, "csam.quarantine", "photo", photo.id, { userId: photo.userId }, now);
  await hub(env, photo.userId).closeAll("suspended");
  const convs = await db.select({ id: schema.conversations.id }).from(schema.conversations).where(or(eq(schema.conversations.userA, photo.userId), eq(schema.conversations.userB, photo.userId)));
  for (const c of convs) await room(env, c.id).freeze("member_suspended");
}

export async function scanPhoto(env: Env, photoId: string, now = Date.now()) {
  const db = makeDb(env.DB);
  const [photo] = await db.select().from(schema.photos).where(eq(schema.photos.id, photoId));
  if (!photo || photo.status !== "pending" || photo.scores) return "skipped";
  const obj = await getMedia(env, photo.r2Key);
  if (!obj) return "missing";
  const scores = await imageScanner(env).scan(obj.body instanceof ArrayBuffer ? obj.body : await new Response(obj.body).arrayBuffer(), photo.contentType); // throws on provider failure: the queue retries
  await db.update(schema.photos).set({ scores: JSON.stringify(scores), explicit: scores.nudity >= SCAN_THRESHOLDS.nudity.reject }).where(eq(schema.photos.id, photo.id));

  if (scores.hashMatch) { await csamPath(env, photo, now); return "quarantined"; }
  const explicit = scores.nudity >= SCAN_THRESHOLDS.nudity.reject;
  const needsHuman = scores.minor >= SCAN_THRESHOLDS.minor.review || scores.weapon >= SCAN_THRESHOLDS.weapon.review || scores.drugs >= SCAN_THRESHOLDS.drugs.review;

  if (photo.purpose === "profile") {
    if (explicit) {
      // Clear-cut breach of the photo rules (spec 9): rejected without waiting for a moderator. Still appealable via contact.
      await db.update(schema.photos).set({ status: "rejected" }).where(eq(schema.photos.id, photo.id));
      await removeMedia(env, photo.r2Key);
      await notify(db, photo.userId, { kind: "moderation", title: "A photo was not accepted", body: "Profile photos must not contain nudity or sexual content. Please upload a different photo.", href: "/app/profile" }, now);
      await dispatch(env, { kind: "notify", userId: photo.userId, reason: "moderation" });
      return "rejected";
    }
    // Everything else is seen by a person before anyone else sees it (spec 1: pre-moderate photos and profiles).
    await enqueueModeration(db, { kind: "photo", refId: photo.id, userId: photo.userId, scores, slaMs: scores.minor >= SCAN_THRESHOLDS.minor.review ? HOUR : Number(env.PREMOD_SLA_HOURS ?? "4") * HOUR }, now);
    return "queued";
  }

  // Chat image: delivered only after the scan passes (spec 6).
  const convId = photo.conversationId!;
  const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, convId));
  if (!conv || conv.status !== "open") { await db.update(schema.photos).set({ status: "rejected" }).where(eq(schema.photos.id, photo.id)); return "rejected"; }
  const recipient = conv.userA === photo.userId ? conv.userB : conv.userA;
  if (needsHuman) {
    await enqueueModeration(db, { kind: "photo", refId: photo.id, userId: photo.userId, scores, slaMs: HOUR }, now);
    await room(env, convId).notifySender(photo.userId, "Your image is being checked before it can be delivered.");
    return "queued";
  }
  if (explicit && !(await hasActiveConsent(db, recipient, "explicit_media"))) {
    await db.update(schema.photos).set({ status: "rejected" }).where(eq(schema.photos.id, photo.id));
    await removeMedia(env, photo.r2Key);
    await addRisk(db, photo.userId, 10, "explicit image to a member who has not opted in", now);
    await room(env, convId).notifySender(photo.userId, "That image was not delivered. Explicit images can only be sent to someone who has chosen to receive them.");
    return "rejected";
  }
  await db.update(schema.photos).set({ status: "approved" }).where(eq(schema.photos.id, photo.id));
  await room(env, convId).postImage(photo.userId, photo.id, explicit);
  return "delivered";
}

/** Archive copy for moderation, plus the scam and spam signals that need history (spec 8). */
export async function archiveMessage(env: Env, job: Extract<Job, { kind: "archive_message" }>) {
  const db = makeDb(env.DB);
  const fp = job.kind2 === "text" ? messageFingerprint(job.body) : null;
  const fpHash = fp ? await blindIndex(env, "msgfp", fp) : null;
  const flags = new Set<string>(job.flags);

  if (fpHash) {
    // The same long message pasted into three or more different chats in a day.
    const [row] = await db.select({ n: sql<number>`count(distinct ${schema.messages.conversationId})` }).from(schema.messages)
      .where(and(eq(schema.messages.senderId, job.senderId), eq(schema.messages.fpHash, fpHash), gt(schema.messages.createdAt, job.at - 24 * HOUR), sql`${schema.messages.conversationId} != ${job.conversationId}`));
    if ((row?.n ?? 0) >= 2) flags.add("copy_paste");
  }
  const inserted = await db.insert(schema.messages).values({
    id: job.id, conversationId: job.conversationId, senderId: job.senderId, kind: job.kind2, bodyEnc: await encryptField(env.APP_SECRET, job.body, `message:${job.id}`),
    photoId: job.photoId ?? null, flags: JSON.stringify([...flags]), fpHash, createdAt: job.at,
  }).onConflictDoNothing().returning({ id: schema.messages.id });
  if (inserted.length === 0) return; // redelivered job

  if (flags.size) {
    await db.insert(schema.flaggedMessages).values({ id: newId("flg"), messageId: job.id, conversationId: job.conversationId, senderId: job.senderId, flags: JSON.stringify([...flags]), excerptEnc: await encryptField(env.APP_SECRET, job.body.slice(0, 280), `flagged:${job.id}`), createdAt: job.at });
    const delta = [...flags].reduce((n, f) => n + (FLAG_RISK[f as FlagCode] ?? 0), 0);
    if (delta) await addRisk(db, job.senderId, delta, `message flags: ${[...flags].join(",")}`, job.at);
  }

  // High outbound velocity: far more messages, to far more people, than a person manages.
  const [vel] = await db.select({ n: sql<number>`count(*)`, convs: sql<number>`count(distinct ${schema.messages.conversationId})` }).from(schema.messages).where(and(eq(schema.messages.senderId, job.senderId), gt(schema.messages.createdAt, job.at - HOUR)));
  if (vel && (vel.n === 120 || vel.convs === 15)) {
    await db.insert(schema.botEvents).values({ id: newId("bot"), kind: "velocity", userId: job.senderId, route: "chat", createdAt: job.at });
    await addRisk(db, job.senderId, 30, `outbound velocity: ${vel.n} messages to ${vel.convs} chats in an hour`, job.at);
  }
}

/** Offline delivery (spec 6): a push or an email digest, never with message content. */
export async function deliverNotification(env: Env, userId: string, reason: string, now = Date.now()) {
  const { live } = await hub(env, userId).push({ type: "notification", reason });
  if (live) return "live";
  const db = makeDb(env.DB);
  const subs = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId));
  let pushed = false;
  for (const sub of subs) {
    const result = await sendPush(env, sub.endpoint, now);
    if (result === "sent") pushed = true;
    if (result === "gone") await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, sub.id));
  }
  if (pushed) return "push";
  // Email digest, at most one every six hours, and only for things worth an email.
  if (!["message", "match", "date", "safety", "moderation", "verification"].includes(reason)) return "none";
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!user?.email || user.status === "deleted") return "none";
  // The outbox is the throttle record (no KV on the free plan, D-015): one digest per address per six hours.
  if (reason !== "safety") {
    const [recent] = await db.select({ id: schema.outbox.id }).from(schema.outbox).where(and(eq(schema.outbox.toAddress, user.email), eq(schema.outbox.template, "digest"), gt(schema.outbox.createdAt, now - 6 * HOUR))).limit(1);
    if (recent) return "throttled";
  }
  await deliver(env, db, { channel: "email", to: user.email, template: "digest", subject: `You have new activity on ${env.APP_NAME}`, body: `Something new is waiting for you.\n\nOpen the app to see it: ${env.APP_ORIGIN}/app\n\nFor your privacy we never put message content in emails.` }, now);
  return "email";
}

export async function runJob(env: Env, job: Job) {
  switch (job.kind) {
    case "scan_photo": return scanPhoto(env, job.photoId);
    case "archive_message": return archiveMessage(env, job);
    case "notify": return deliverNotification(env, job.userId, job.reason);
    case "purge_user_chat": return room(env, job.conversationId).purgeSender(job.userId);
  }
}

export async function handleQueue(batch: MessageBatch<Job>, env: Env) {
  for (const msg of batch.messages) {
    try {
      await runJob(env, msg.body);
      msg.ack();
    } catch (err) {
      console.error("job failed", msg.body.kind, err);
      msg.retry({ delaySeconds: Math.min(600, 15 * 2 ** msg.attempts) });
    }
  }
}

/** Every 15 minutes: scheduled erasure (spec 3: personal data erased within 30 days) and tidy-up. */
export async function handleScheduled(env: Env, now = Date.now()) {
  const db = makeDb(env.DB);
  // Find the conversations first: erasure removes the rows that would tell us where their messages live.
  const due = await db.select({ id: schema.users.id }).from(schema.users).where(and(sql`${schema.users.eraseAfter} is not null`, sql`${schema.users.eraseAfter} <= ${now}`)).limit(50);
  const convs = due.length ? await db.select().from(schema.conversations).where(or(inArray(schema.conversations.userA, due.map((d) => d.id)), inArray(schema.conversations.userB, due.map((d) => d.id)))) : [];
  const result = await eraseDueAccounts(db, now, 50);
  for (const key of result.r2Keys) await removeMedia(env, key);
  for (const conv of convs) for (const uid of [conv.userA, conv.userB]) if (result.erased.includes(uid)) await dispatch(env, { kind: "purge_user_chat", userId: uid, conversationId: conv.id });
  // Spent single-use tokens and old bot events are not worth keeping.
  await db.delete(schema.authTokens).where(sql`${schema.authTokens.expiresAt} < ${now - 7 * 24 * HOUR}`);
  await db.delete(schema.botEvents).where(sql`${schema.botEvents.createdAt} < ${now - 90 * 24 * HOUR}`);
  return result;
}
