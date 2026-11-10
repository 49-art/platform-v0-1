/**
 * Chat, consented contact swap, date tools and safety.
 * DERIVED routes (Chat and Dates API tabs were not legible); behaviour comes from spec 2, 6, 7 and 9.
 */
import {
  CONSENT_VERSION, type DB, audit, blindIndex, decryptField, decryptJson, encryptField, encryptJson, hasActiveConsent, isBlockedEitherWay, isVerified,
  newId, notify, schema,
} from "../../core";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { dispatch } from "../lib/dispatch";
import { rateLimit } from "../lib/guard";
import { bad, body, forbidden, notFound, requireActive } from "../lib/http";
import { type Venue, raiseSafetyAlert, sharePlan } from "../lib/safety";
import { requireFreshAuth } from "../lib/session";
import { publicProfile } from "./profiles";

const HOUR = 3_600_000;
const room = (env: Env, conversationId: string) => env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(conversationId));
const hub = (env: Env, userId: string) => env.USER_HUB.get(env.USER_HUB.idFromName(userId));

async function membership(c: Context<AppEnv>, conversationId: string) {
  const user = requireActive(c);
  const [conv] = await c.get("db").select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
  if (!conv || (conv.userA !== user.id && conv.userB !== user.id)) throw notFound();
  return { user, conv, otherId: conv.userA === user.id ? conv.userB : conv.userA };
}

/** Flow nodes L to N: date tools and swaps stay locked until BOTH people are verified. */
async function verificationGate(db: DB, userId: string, otherId: string) {
  const [mine, theirs] = [await isVerified(db, userId), await isVerified(db, otherId)];
  return { mine, theirs, both: mine && theirs };
}
function assertBothVerified(gate: { mine: boolean; theirs: boolean }) {
  if (!gate.mine) throw forbidden("verification_required", "Verify your identity to unlock this.", { who: "you" });
  if (!gate.theirs) throw forbidden("verification_required", "This unlocks once your match is verified too.", { who: "them" });
}

export const chat = new Hono<AppEnv>();

/* ── Realtime ── */

chat.get("/api/hub/ws", async (c) => {
  const user = requireActive(c);
  if (c.req.header("upgrade") !== "websocket") throw bad("expected_websocket", "Expected a WebSocket.");
  return hub(c.env, user.id).fetch(c.req.raw);
});

chat.get("/api/conversations/:id/ws", async (c) => {
  const { user, conv } = await membership(c, c.req.param("id"));
  if (c.req.header("upgrade") !== "websocket") throw bad("expected_websocket", "Expected a WebSocket.");
  const headers = new Headers(c.req.raw.headers);
  // Identity comes from the session, never from the client. These headers are set here and nowhere else.
  headers.set("x-user-id", user.id);
  headers.set("x-conversation-id", conv.id);
  headers.set("x-user-a", conv.userA);
  headers.set("x-user-b", conv.userB);
  headers.set("x-conversation-status", conv.status);
  await hub(c.env, user.id).clear(conv.id);
  return room(c.env, conv.id).fetch(new Request(c.req.raw, { headers }));
});

chat.get("/api/conversations/:id", async (c) => {
  const { user, conv, otherId } = await membership(c, c.req.param("id"));
  const db = c.get("db");
  const now = c.get("now");
  if (await isBlockedEitherWay(db, user.id, otherId)) throw notFound();
  const [me] = await db.select({ geoCell: schema.profiles.geoCell }).from(schema.profiles).where(eq(schema.profiles.userId, user.id));
  const other = await publicProfile(c.env, db, { id: user.id, geoCell: me?.geoCell }, otherId, now);
  const gate = await verificationGate(db, user.id, otherId);
  const dateRows = await db.select().from(schema.dates).where(eq(schema.dates.conversationId, conv.id)).orderBy(desc(schema.dates.createdAt)).limit(5);
  const dates = await Promise.all(dateRows.map(async (d) => {
    const [safety] = await db.select().from(schema.dateSafety).where(and(eq(schema.dateSafety.dateId, d.id), eq(schema.dateSafety.userId, user.id)));
    return { id: d.id, status: d.status, startsAt: d.startsAt, mine: d.proposerId === user.id, venue: await decryptJson<Venue>(c.env.APP_SECRET, d.venueEnc, `date:${d.id}:venue`), safety: safety ? { trustedContactId: safety.trustedContactId, sharedAt: safety.sharedAt, checkinDueAt: safety.checkinDueAt, checkedInAt: safety.checkedInAt, alertedAt: safety.alertedAt, sosAt: safety.sosAt } : null };
  }));
  return c.json({
    conversation: { id: conv.id, status: conv.status },
    other: other ? { ...other, displayName: other.available ? other.displayName : "Member unavailable" } : null,
    verification: gate,
    swap: await swapState(c.env, db, conv.id, user.id, otherId),
    dates,
    restrictedUntil: user.restrictedUntil && user.restrictedUntil > now ? user.restrictedUntil : null,
  });
});

/* ── Consented swap: phone numbers or "Continue on X" (spec 2 step 8, flow nodes Q to S) ── */

async function swapState(env: Env, db: DB, conversationId: string, userId: string, otherId: string) {
  const out: Record<"phone" | "x", { mine: boolean; theirs: boolean; reveal: string | null }> = { phone: { mine: false, theirs: false, reveal: null }, x: { mine: false, theirs: false, reveal: null } };
  for (const [key, kind] of [["phone", "phone_swap"], ["x", "x_link"]] as const) {
    out[key].mine = await hasActiveConsent(db, userId, kind, conversationId);
    out[key].theirs = await hasActiveConsent(db, otherId, kind, conversationId);
  }
  // Revealed to each other only, and only while both consents stand and both are still verified.
  const verified = (await isVerified(db, userId)) && (await isVerified(db, otherId));
  if (verified && out.phone.mine && out.phone.theirs) {
    const [contact] = await db.select().from(schema.userContacts).where(eq(schema.userContacts.userId, otherId));
    out.phone.reveal = contact?.phoneEnc ? await decryptField(env.APP_SECRET, contact.phoneEnc, `contact:${otherId}:phone`).catch(() => null) : null;
  }
  if (verified && out.x.mine && out.x.theirs) {
    const [x] = await db.select({ handle: schema.oauthAccounts.handle }).from(schema.oauthAccounts).where(eq(schema.oauthAccounts.userId, otherId));
    // The XChat deep-link format is [UNVERIFIED] in the spec, so we use the documented fallback: the other person's X profile.
    out.x.reveal = x?.handle ? `https://x.com/${encodeURIComponent(x.handle)}` : null;
  }
  return out;
}

chat.put("/api/me/phone", async (c) => {
  const user = requireActive(c);
  requireFreshAuth(c); // spec 3: re-auth for phone swap
  const input = await body(c, z.object({ phone: z.string().trim().regex(/^\+?[0-9 ()-]{9,20}$/, "Enter a phone number with its country code.") }));
  const digits = input.phone.replace(/[^\d+]/g, "");
  await c.get("db").insert(schema.userContacts).values({ userId: user.id, phoneEnc: await encryptField(c.env.APP_SECRET, digits, `contact:${user.id}:phone`), phoneHash: await blindIndex(c.env, "phone", digits), updatedAt: c.get("now") })
    .onConflictDoUpdate({ target: schema.userContacts.userId, set: { phoneEnc: await encryptField(c.env.APP_SECRET, digits, `contact:${user.id}:phone`), phoneHash: await blindIndex(c.env, "phone", digits), updatedAt: c.get("now") } });
  return c.json({ ok: true });
});

chat.post("/api/conversations/:id/swap", async (c) => {
  const { user, conv, otherId } = await membership(c, c.req.param("id"));
  const input = await body(c, z.object({ kind: z.enum(["phone", "x"]), consent: z.boolean() }));
  const db = c.get("db");
  const now = c.get("now");
  const consentKind = input.kind === "phone" ? "phone_swap" : "x_link";
  const active = await hasActiveConsent(db, user.id, consentKind, conv.id);

  if (!input.consent) {
    if (active) await db.update(schema.consents).set({ withdrawnAt: now }).where(and(eq(schema.consents.userId, user.id), eq(schema.consents.kind, consentKind), eq(schema.consents.scope, conv.id), isNull(schema.consents.withdrawnAt)));
    await room(c.env, conv.id).refreshGate();
    return c.json({ ok: true, swap: await swapState(c.env, db, conv.id, user.id, otherId) });
  }
  if (conv.status !== "open") throw forbidden("conversation_closed", "This conversation is closed.");
  assertBothVerified(await verificationGate(db, user.id, otherId));
  if (input.kind === "phone") {
    const [contact] = await db.select().from(schema.userContacts).where(eq(schema.userContacts.userId, user.id));
    if (!contact?.phoneEnc) throw bad("phone_missing", "Add your phone number in Settings first.");
  } else {
    const [x] = await db.select().from(schema.oauthAccounts).where(eq(schema.oauthAccounts.userId, user.id));
    if (!x) throw bad("x_missing", "Link your X account in Settings first.");
  }
  if (!active) await db.insert(schema.consents).values({ id: newId("con"), userId: user.id, kind: consentKind, scope: conv.id, grantedAt: now, version: CONSENT_VERSION });
  await audit(db, { id: user.id, role: "member" }, "swap.consent", "conversation", conv.id, { kind: input.kind }, now);
  const state = await swapState(c.env, db, conv.id, user.id, otherId);
  const both = state[input.kind].mine && state[input.kind].theirs;
  if (both) await room(c.env, conv.id).systemMessage(input.kind === "phone" ? "You both agreed to swap phone numbers. They are shown at the top of this chat." : "You both agreed to continue on X. The link is at the top of this chat.");
  else {
    await room(c.env, conv.id).refreshGate();
    await notify(db, otherId, { kind: "date", title: input.kind === "phone" ? "Your match would like to swap numbers" : "Your match would like to continue on X", body: "Nothing is shared unless you agree too.", href: `/app/chat/${conv.id}` }, now);
    await dispatch(c.env, { kind: "notify", userId: otherId, reason: "swap" });
  }
  return c.json({ ok: true, swap: state });
});

/* ── Trusted contacts ── */

chat.get("/api/trusted-contacts", async (c) => {
  const user = requireActive(c);
  const rows = await c.get("db").select().from(schema.trustedContacts).where(eq(schema.trustedContacts.userId, user.id));
  return c.json({ contacts: await Promise.all(rows.map(async (t) => ({ id: t.id, channel: t.channel, name: await decryptField(c.env.APP_SECRET, t.nameEnc, `trusted:${t.id}:name`), address: await decryptField(c.env.APP_SECRET, t.addressEnc, `trusted:${t.id}:address`) }))) });
});

chat.post("/api/trusted-contacts", async (c) => {
  const user = requireActive(c);
  const input = await body(c, z.discriminatedUnion("channel", [
    z.object({ channel: z.literal("email"), name: z.string().trim().min(1).max(60), address: z.string().trim().toLowerCase().email() }),
    z.object({ channel: z.literal("sms"), name: z.string().trim().min(1).max(60), address: z.string().trim().regex(/^\+[0-9]{9,15}$/, "Use international format, for example +447700900123.") }),
  ]));
  const db = c.get("db");
  if ((await db.select({ id: schema.trustedContacts.id }).from(schema.trustedContacts).where(eq(schema.trustedContacts.userId, user.id))).length >= 3) throw bad("too_many", "You can keep up to three trusted contacts.");
  const id = newId("tc");
  await db.insert(schema.trustedContacts).values({ id, userId: user.id, channel: input.channel, nameEnc: await encryptField(c.env.APP_SECRET, input.name, `trusted:${id}:name`), addressEnc: await encryptField(c.env.APP_SECRET, input.address, `trusted:${id}:address`), createdAt: c.get("now") });
  return c.json({ ok: true, id });
});

chat.delete("/api/trusted-contacts/:id", async (c) => {
  const user = requireActive(c);
  await c.get("db").delete(schema.trustedContacts).where(and(eq(schema.trustedContacts.id, c.req.param("id")), eq(schema.trustedContacts.userId, user.id)));
  return c.json({ ok: true });
});

/* ── Dates (spec 2 step 7: both verified, propose, accept, share with trusted contact, set check-in) ── */

chat.post("/api/conversations/:id/dates", async (c) => {
  const { user, conv, otherId } = await membership(c, c.req.param("id"));
  const db = c.get("db");
  const now = c.get("now");
  if (conv.status !== "open") throw forbidden("conversation_closed", "This conversation is closed.");
  assertBothVerified(await verificationGate(db, user.id, otherId));
  const input = await body(c, z.object({ startsAt: z.number().int(), venueName: z.string().trim().min(2).max(80), venueArea: z.string().trim().min(2).max(60) }));
  if (input.startsAt < now + HOUR || input.startsAt > now + 90 * 24 * HOUR) throw bad("bad_time", "Choose a time between an hour from now and three months ahead.");
  await rateLimit(c, `date-propose:${user.id}`, 10, 24 * HOUR);
  const open = await db.select({ id: schema.dates.id }).from(schema.dates).where(and(eq(schema.dates.conversationId, conv.id), eq(schema.dates.status, "proposed")));
  if (open.length) throw bad("already_proposed", "There is already a date waiting for an answer in this chat.");
  const id = newId("dat");
  await db.insert(schema.dates).values({ id, conversationId: conv.id, proposerId: user.id, inviteeId: otherId, startsAt: input.startsAt, venueEnc: await encryptJson(c.env.APP_SECRET, { name: input.venueName, area: input.venueArea } satisfies Venue, `date:${id}:venue`), createdAt: now });
  await room(c.env, conv.id).systemMessage("A date has been proposed. Open the date panel to reply.");
  await notify(db, otherId, { kind: "date", title: "You have a date proposal", body: "Open the chat to see the details and reply.", href: `/app/chat/${conv.id}` }, now);
  await dispatch(c.env, { kind: "notify", userId: otherId, reason: "date" });
  return c.json({ ok: true, id });
});

async function dateFor(c: Context<AppEnv>, dateId: string) {
  const user = requireActive(c);
  const [date] = await c.get("db").select().from(schema.dates).where(eq(schema.dates.id, dateId));
  if (!date || (date.proposerId !== user.id && date.inviteeId !== user.id)) throw notFound();
  return { user, date, otherId: date.proposerId === user.id ? date.inviteeId : date.proposerId };
}
const timer = (env: Env, dateId: string, userId: string) => env.DATE_TIMER.get(env.DATE_TIMER.idFromName(`${dateId}:${userId}`));

chat.post("/api/dates/:id/respond", async (c) => {
  const { user, date, otherId } = await dateFor(c, c.req.param("id"));
  const input = await body(c, z.object({ action: z.enum(["accept", "decline", "cancel"]) }));
  const db = c.get("db");
  const now = c.get("now");
  if (input.action === "cancel") {
    if (!["proposed", "accepted"].includes(date.status)) throw bad("bad_state", "This date can no longer be changed.");
    await db.update(schema.dates).set({ status: "cancelled", respondedAt: now }).where(eq(schema.dates.id, date.id));
    for (const uid of [user.id, otherId]) await timer(c.env, date.id, uid).cancel();
    await room(c.env, date.conversationId).systemMessage("The date was cancelled.");
  } else {
    if (date.inviteeId !== user.id) throw forbidden("not_invitee", "Only the person invited can answer.");
    if (date.status !== "proposed") throw bad("bad_state", "This date has already been answered.");
    if (input.action === "accept") assertBothVerified(await verificationGate(db, user.id, otherId));
    await db.update(schema.dates).set({ status: input.action === "accept" ? "accepted" : "declined", respondedAt: now }).where(eq(schema.dates.id, date.id));
    await room(c.env, date.conversationId).systemMessage(input.action === "accept" ? "Date accepted. Set up your safety check-in from the date panel." : "The date was declined.");
  }
  await notify(db, otherId, { kind: "date", title: { accept: "Your date was accepted", decline: "Your date was declined", cancel: "Your date was cancelled" }[input.action], href: `/app/chat/${date.conversationId}` }, now);
  await dispatch(c.env, { kind: "notify", userId: otherId, reason: "date" });
  return c.json({ ok: true });
});

/** Each person sets up their own safety net. The other person is never told whether or how it is set. */
chat.put("/api/dates/:id/safety", async (c) => {
  const { user, date } = await dateFor(c, c.req.param("id"));
  if (date.status !== "accepted") throw bad("bad_state", "Safety tools are available once the date is accepted.");
  const input = await body(c, z.object({ trustedContactId: z.string().nullable(), share: z.boolean(), checkinAt: z.number().int().nullable() }));
  const db = c.get("db");
  const now = c.get("now");
  if (input.trustedContactId) {
    const [tc] = await db.select({ id: schema.trustedContacts.id }).from(schema.trustedContacts).where(and(eq(schema.trustedContacts.id, input.trustedContactId), eq(schema.trustedContacts.userId, user.id)));
    if (!tc) throw bad("bad_contact", "Choose one of your trusted contacts.");
  }
  if (input.share && !input.trustedContactId) throw bad("no_contact", "Choose a trusted contact to share the plan with.");
  if (input.checkinAt !== null && (input.checkinAt < date.startsAt || input.checkinAt > date.startsAt + 24 * HOUR)) throw bad("bad_checkin", "Set the check-in for a time after the date starts, within 24 hours.");
  const [existing] = await db.select().from(schema.dateSafety).where(and(eq(schema.dateSafety.dateId, date.id), eq(schema.dateSafety.userId, user.id)));
  const values = { trustedContactId: input.trustedContactId, checkinDueAt: input.checkinAt, remindedAt: null, checkedInAt: null, alertedAt: null };
  if (existing) await db.update(schema.dateSafety).set(values).where(and(eq(schema.dateSafety.dateId, date.id), eq(schema.dateSafety.userId, user.id)));
  else await db.insert(schema.dateSafety).values({ dateId: date.id, userId: user.id, ...values });
  if (input.checkinAt) await timer(c.env, date.id, user.id).schedule(date.id, user.id, input.checkinAt);
  else await timer(c.env, date.id, user.id).cancel();
  const shared = input.share ? await sharePlan(c.env, db, date.id, user.id, now) : false;
  await audit(db, { id: user.id, role: "member" }, "date.safety_set", "date", date.id, { shared, checkin: !!input.checkinAt }, now);
  return c.json({ ok: true, shared });
});

chat.post("/api/dates/:id/checkin", async (c) => {
  const { user, date } = await dateFor(c, c.req.param("id"));
  const db = c.get("db");
  const [safety] = await db.select().from(schema.dateSafety).where(and(eq(schema.dateSafety.dateId, date.id), eq(schema.dateSafety.userId, user.id)));
  if (!safety) throw bad("no_safety", "No check-in is set for this date.");
  await db.update(schema.dateSafety).set({ checkedInAt: c.get("now") }).where(and(eq(schema.dateSafety.dateId, date.id), eq(schema.dateSafety.userId, user.id)));
  await timer(c.env, date.id, user.id).cancel();
  return c.json({ ok: true });
});

chat.post("/api/dates/:id/sos", async (c) => {
  const { user, date } = await dateFor(c, c.req.param("id"));
  await rateLimit(c, `sos:${user.id}`, 5, HOUR);
  const db = c.get("db");
  const [safety] = await db.select().from(schema.dateSafety).where(and(eq(schema.dateSafety.dateId, date.id), eq(schema.dateSafety.userId, user.id)));
  if (!safety) await db.insert(schema.dateSafety).values({ dateId: date.id, userId: user.id });
  const result = await raiseSafetyAlert(c.env, db, date.id, user.id, "sos", c.get("now"));
  await timer(c.env, date.id, user.id).cancel();
  return c.json({ ok: true, contacted: result.ok && "contacted" in result ? result.contacted : false, emergency: "If you are in immediate danger call 999." });
});

