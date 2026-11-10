/**
 * Reports, blocks, standing and appeals, notifications, push, and the public contact form.
 * Spec 2 (Reporter journey), 8 (enforcement, appeals), 9 ("Report bot" everywhere).
 */
import { REASON_CODES, REPORT_REASONS, type ReportReason, audit, createReport, newId, schema, sha256Hex, verifyHmac } from "../../core";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { dispatch } from "../lib/dispatch";
import { rateLimit, rateLimitIp, requireTurnstile } from "../lib/guard";
import { bad, body, forbidden, notFound, requireActive, requireUser } from "../lib/http";

const HOUR = 3_600_000;
export const safety = new Hono<AppEnv>();

safety.get("/api/report-reasons", (c) => c.json({ reasons: Object.entries(REPORT_REASONS).map(([key, v]) => ({ key, label: v.label })) }));

safety.post("/api/reports", async (c) => {
  const user = requireActive(c);
  const input = await body(c, z.object({ userId: z.string(), reason: z.enum(Object.keys(REPORT_REASONS) as [ReportReason, ...ReportReason[]]), detail: z.string().trim().max(2000).optional(), conversationId: z.string().optional(), block: z.boolean().optional() }));
  await rateLimit(c, `report:${user.id}`, 20, 24 * HOUR);
  const db = c.get("db");
  const [subject] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, input.userId));
  if (!subject) throw notFound();
  if (input.conversationId) {
    const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, input.conversationId));
    const members = conv ? [conv.userA, conv.userB] : [];
    if (!members.includes(user.id) || !members.includes(input.userId)) throw notFound();
  }
  const report = await createReport(db, { reporterId: user.id, subjectUserId: input.userId, reason: input.reason, detail: input.detail, conversationId: input.conversationId }, c.get("now"));
  if (input.reason === "underage") {
    // Precautionary suspension happened inside createReport: drop their live connections now.
    await c.env.USER_HUB.get(c.env.USER_HUB.idFromName(input.userId)).closeAll("suspended");
    if (input.conversationId) await c.env.CHAT_ROOM.get(c.env.CHAT_ROOM.idFromName(input.conversationId)).freeze("member_suspended");
  }
  if (input.block) await blockUser(c, user.id, input.userId);
  await dispatch(c.env, { kind: "notify", userId: user.id, reason: "report" });
  return c.json({ ok: true, reference: report.id, message: "Thank you. We have your report and a moderator will review it. We will tell you the outcome." });
});

async function blockUser(c: Context<AppEnv>, blocker: string, blocked: string) {
  const db = c.get("db");
  await db.insert(schema.blocks).values({ blocker, blocked, createdAt: c.get("now") }).onConflictDoNothing();
  const convs = await db.select().from(schema.conversations).where(or(and(eq(schema.conversations.userA, blocker), eq(schema.conversations.userB, blocked)), and(eq(schema.conversations.userA, blocked), eq(schema.conversations.userB, blocker))));
  for (const conv of convs) {
    await db.update(schema.conversations).set({ status: "closed", frozenReason: "blocked" }).where(eq(schema.conversations.id, conv.id));
    // The other person is told the conversation closed, not who closed it or why.
    await c.env.CHAT_ROOM.get(c.env.CHAT_ROOM.idFromName(conv.id)).freeze("closed");
  }
}

safety.post("/api/blocks", async (c) => {
  const user = requireActive(c);
  const input = await body(c, z.object({ userId: z.string() }));
  if (input.userId === user.id) throw bad("self", "You cannot block yourself.");
  await blockUser(c, user.id, input.userId);
  return c.json({ ok: true });
});

safety.delete("/api/blocks/:userId", async (c) => {
  const user = requireActive(c);
  await c.get("db").delete(schema.blocks).where(and(eq(schema.blocks.blocker, user.id), eq(schema.blocks.blocked, c.req.param("userId"))));
  return c.json({ ok: true });
});

safety.get("/api/blocks", async (c) => {
  const user = requireActive(c);
  const rows = await c.get("db").select({ userId: schema.blocks.blocked, at: schema.blocks.createdAt, name: schema.profiles.displayName }).from(schema.blocks).leftJoin(schema.profiles, eq(schema.profiles.userId, schema.blocks.blocked)).where(eq(schema.blocks.blocker, user.id));
  return c.json({ blocks: rows });
});

/* ── Standing and appeals: available to suspended and banned members too (spec 1: every action can be appealed) ── */

safety.get("/api/standing", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const actions = await db.select().from(schema.enforcementActions).where(eq(schema.enforcementActions.userId, user.id)).orderBy(desc(schema.enforcementActions.createdAt)).limit(20);
  const appeals = await db.select().from(schema.appeals).where(eq(schema.appeals.userId, user.id));
  return c.json({
    status: user.status, restrictedUntil: user.restrictedUntil, suspendedUntil: user.suspendedUntil,
    actions: actions.map((a) => {
      const appeal = appeals.find((x) => x.actionId === a.id);
      return { id: a.id, kind: a.kind, reasonCode: a.reasonCode, reason: REASON_CODES[a.reasonCode]?.notice ?? "", at: a.createdAt, expiresAt: a.expiresAt, liftedAt: a.liftedAt, appeal: appeal ? { status: appeal.status, decisionNote: appeal.decisionNote, at: appeal.createdAt } : null };
    }),
  });
});

safety.post("/api/appeals", async (c) => {
  const user = requireUser(c);
  const input = await body(c, z.object({ actionId: z.string(), body: z.string().trim().min(20, "Please tell us a little more (at least 20 characters).").max(3000) }));
  await rateLimit(c, `appeal:${user.id}`, 5, 24 * HOUR);
  const db = c.get("db");
  const [action] = await db.select().from(schema.enforcementActions).where(and(eq(schema.enforcementActions.id, input.actionId), eq(schema.enforcementActions.userId, user.id)));
  if (!action) throw notFound();
  if (action.liftedAt) throw bad("already_lifted", "This action has already been lifted.");
  const [existing] = await db.select().from(schema.appeals).where(eq(schema.appeals.actionId, action.id));
  if (existing) throw bad("already_appealed", "You have already appealed this action. We will reply as soon as we can.");
  const id = newId("apl");
  await db.insert(schema.appeals).values({ id, actionId: action.id, userId: user.id, body: input.body, createdAt: c.get("now") });
  await audit(db, { id: user.id, role: "member" }, "appeal.create", "enforcement_action", action.id, { appealId: id }, c.get("now"));
  return c.json({ ok: true, reference: id, message: "We have your appeal. A senior moderator who was not involved in the original decision will review it." });
});

/* ── Notifications ── */

safety.get("/api/notifications", async (c) => {
  const user = requireUser(c);
  const rows = await c.get("db").select().from(schema.notifications).where(eq(schema.notifications.userId, user.id)).orderBy(desc(schema.notifications.createdAt)).limit(50);
  return c.json({ unread: rows.filter((r) => !r.readAt).length, notifications: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, href: r.href, at: r.createdAt, read: !!r.readAt })) });
});

safety.post("/api/notifications/read", async (c) => {
  const user = requireUser(c);
  await c.get("db").update(schema.notifications).set({ readAt: c.get("now") }).where(and(eq(schema.notifications.userId, user.id), isNull(schema.notifications.readAt)));
  return c.json({ ok: true });
});

/* ── Web Push (spec 11: VAPID from Workers). We only store the endpoint: pushes carry no payload and no content. ── */

safety.post("/api/push/subscribe", async (c) => {
  const user = requireActive(c);
  const input = await body(c, z.object({ endpoint: z.string().url().startsWith("https://").max(1000) }));
  await c.get("db").insert(schema.pushSubscriptions).values({ id: await sha256Hex(input.endpoint), userId: user.id, endpoint: input.endpoint, createdAt: c.get("now") }).onConflictDoUpdate({ target: schema.pushSubscriptions.id, set: { userId: user.id } });
  return c.json({ ok: true });
});

safety.post("/api/push/unsubscribe", async (c) => {
  const user = requireUser(c);
  const input = await body(c, z.object({ endpoint: z.string().url() }));
  await c.get("db").delete(schema.pushSubscriptions).where(and(eq(schema.pushSubscriptions.id, await sha256Hex(input.endpoint)), eq(schema.pushSubscriptions.userId, user.id)));
  return c.json({ ok: true });
});

/* ── Public contact form (spec 2 "Visitor"; spec 3 bot gate covers it) ── */

safety.post("/api/contact", async (c) => {
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(80), email: z.string().trim().toLowerCase().email(), topic: z.enum(["general", "safety", "press", "law_enforcement", "privacy", "appeal"]), message: z.string().trim().min(10).max(4000), turnstileToken: z.string().optional() }));
  await rateLimitIp(c, "contact", 5, HOUR);
  await requireTurnstile(c, input.turnstileToken);
  await c.get("db").insert(schema.contactMessages).values({ id: newId("ctc"), name: input.name, email: input.email, topic: input.topic, body: input.message, createdAt: c.get("now") });
  return c.json({ ok: true, message: "Thank you. Your message has reached us." });
});

/* ── Internal: the admin console tells this Worker that a member's standing changed ── */

export const internal = new Hono<AppEnv>();

internal.post("/internal/user-changed", async (c) => {
  const raw = await c.req.text();
  const t = c.req.header("x-internal-timestamp") ?? "";
  if (!c.env.INTERNAL_SECRET || Math.abs(Date.now() - Number(t)) > 60_000 || !(await verifyHmac(c.env.INTERNAL_SECRET, "internal", `${t}.${raw}`, c.req.header("x-internal-signature") ?? ""))) throw forbidden("bad_signature", "Forbidden.");
  const { userId, disconnect } = z.object({ userId: z.string(), disconnect: z.boolean() }).parse(JSON.parse(raw));
  const db = c.get("db");
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!user) throw notFound();
  const hub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(userId));
  if (disconnect) {
    // Ban or suspension: close every socket and freeze every conversation now, not at the next message.
    await hub.closeAll(user.status);
    const convs = await db.select({ id: schema.conversations.id }).from(schema.conversations).where(or(eq(schema.conversations.userA, userId), eq(schema.conversations.userB, userId)));
    for (const conv of convs) await c.env.CHAT_ROOM.get(c.env.CHAT_ROOM.idFromName(conv.id)).freeze(`member_${user.status}`);
  } else {
    await hub.push({ type: "standing", status: user.status });
  }
  await dispatch(c.env, { kind: "notify", userId, reason: "moderation" });
  return c.json({ ok: true });
});

/** A moderator approved a chat image that had been held for review: deliver it now. */
internal.post("/internal/photo-approved", async (c) => {
  const raw = await c.req.text();
  const t = c.req.header("x-internal-timestamp") ?? "";
  if (!c.env.INTERNAL_SECRET || Math.abs(Date.now() - Number(t)) > 60_000 || !(await verifyHmac(c.env.INTERNAL_SECRET, "internal", `${t}.${raw}`, c.req.header("x-internal-signature") ?? ""))) throw forbidden("bad_signature", "Forbidden.");
  const { photoId } = z.object({ photoId: z.string() }).parse(JSON.parse(raw));
  const [photo] = await c.get("db").select().from(schema.photos).where(eq(schema.photos.id, photoId));
  if (!photo || photo.purpose !== "chat" || photo.status !== "approved" || !photo.conversationId) throw notFound();
  await c.env.CHAT_ROOM.get(c.env.CHAT_ROOM.idFromName(photo.conversationId)).postImage(photo.userId, photo.id, photo.explicit);
  return c.json({ ok: true });
});
