/**
 * Date safety alerts — spec 2 step 7 ("share with trusted contact, set check-in") and flow node P (trusted contact, check-in, SOS).
 * DERIVED: the "Dates and safety" feature table was not legible in the spec print.
 */
import { type DB, SYSTEM, audit, decryptField, decryptJson, deliver, newId, notify, schema } from "../../core";
import { and, eq } from "drizzle-orm";
import type { Env } from "../env";

export interface Venue {
  name: string;
  area: string;
}

async function load(env: Env, db: DB, dateId: string, userId: string) {
  const [date] = await db.select().from(schema.dates).where(eq(schema.dates.id, dateId));
  const [safety] = await db.select().from(schema.dateSafety).where(and(eq(schema.dateSafety.dateId, dateId), eq(schema.dateSafety.userId, userId)));
  if (!date || !safety) return null;
  const otherId = date.proposerId === userId ? date.inviteeId : date.proposerId;
  const [me] = await db.select({ name: schema.profiles.displayName }).from(schema.profiles).where(eq(schema.profiles.userId, userId));
  const [other] = await db.select({ name: schema.profiles.displayName }).from(schema.profiles).where(eq(schema.profiles.userId, otherId));
  const venue = await decryptJson<Venue>(env.APP_SECRET, date.venueEnc, `date:${dateId}:venue`);
  let contact: { name: string; channel: "email" | "sms"; address: string } | null = null;
  if (safety.trustedContactId) {
    const [tc] = await db.select().from(schema.trustedContacts).where(and(eq(schema.trustedContacts.id, safety.trustedContactId), eq(schema.trustedContacts.userId, userId)));
    if (tc) contact = { name: await decryptField(env.APP_SECRET, tc.nameEnc, `trusted:${tc.id}:name`), channel: tc.channel, address: await decryptField(env.APP_SECRET, tc.addressEnc, `trusted:${tc.id}:address`) };
  }
  return { date, safety, otherId, myName: me?.name || "Your contact", otherName: other?.name || "their date", venue, contact };
}

const when = (ms: number) => new Date(ms).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "full", timeStyle: "short" });

/** Sends the plan to the trusted contact. The contact learns only what the member chose to share for this one date. */
export async function sharePlan(env: Env, db: DB, dateId: string, userId: string, now: number) {
  const x = await load(env, db, dateId, userId);
  if (!x?.contact) return false;
  const body = `${x.myName} has a date planned and asked us to let you know as their trusted contact.\n\nWho: ${x.otherName} (identity verified on ${env.APP_NAME})\nWhen: ${when(x.date.startsAt)}\nWhere: ${x.venue?.name ?? "not given"}, ${x.venue?.area ?? ""}\n${x.safety.checkinDueAt ? `Check-in due: ${when(x.safety.checkinDueAt)}\n` : ""}\nYou do not need to do anything. We will only contact you again if ${x.myName} misses their check-in or asks for help.`;
  await deliver(env, db, { channel: x.contact.channel, to: x.contact.address, template: "date_plan_shared", subject: `${x.myName} shared a date plan with you`, body }, now);
  await db.update(schema.dateSafety).set({ sharedAt: now }).where(and(eq(schema.dateSafety.dateId, dateId), eq(schema.dateSafety.userId, userId)));
  return true;
}

/**
 * Missed check-in or SOS. Alerts the trusted contact, tells the member what we did, and puts a priority-0 item in
 * front of staff. We are not an emergency service and the copy says so: the member is told to call 999.
 */
export async function raiseSafetyAlert(env: Env, db: DB, dateId: string, userId: string, kind: "missed_checkin" | "sos", now: number) {
  const x = await load(env, db, dateId, userId);
  if (!x) return { ok: false as const };
  if (kind === "missed_checkin" && (x.safety.checkedInAt || x.safety.alertedAt)) return { ok: true as const, skipped: true };
  await db.update(schema.dateSafety).set(kind === "sos" ? { sosAt: now, alertedAt: now } : { alertedAt: now }).where(and(eq(schema.dateSafety.dateId, dateId), eq(schema.dateSafety.userId, userId)));
  let contacted = false;
  if (x.contact) {
    const lead = kind === "sos" ? `${x.myName} pressed the SOS button during a date.` : `${x.myName} has not checked in after a date and asked us to tell you if that happened.`;
    const body = `${lead}\n\nWho they were meeting: ${x.otherName}\nWhen: ${when(x.date.startsAt)}\nWhere: ${x.venue?.name ?? "not given"}, ${x.venue?.area ?? ""}\n\nPlease try to reach ${x.myName} now. If you believe they are in danger, call 999.\n\n${env.APP_NAME} is not an emergency service.`;
    contacted = (await deliver(env, db, { channel: x.contact.channel, to: x.contact.address, template: `safety_${kind}`, subject: kind === "sos" ? `Urgent: ${x.myName} asked for help` : `${x.myName} missed their safety check-in`, body }, now)).status !== "failed";
  }
  await notify(db, userId, { kind: "safety", title: kind === "sos" ? "SOS sent" : "You missed your check-in", body: contacted ? `We have alerted ${x.contact!.name}. If you are in danger call 999.` : "You have no trusted contact set for this date. If you are in danger call 999.", href: `/app/chat/${x.date.conversationId}` }, now);
  await db.insert(schema.reports).values({ id: newId("rep"), reporterId: "system", subjectUserId: x.otherId, conversationId: x.date.conversationId, reason: "threat", detail: `Safety alert (${kind}) raised by ${userId} for date ${dateId}. Trusted contact ${contacted ? "alerted" : "NOT alerted (none set or delivery failed)"}.`, priority: 0, status: "escalated", createdAt: now });
  await audit(db, SYSTEM, `safety.${kind}`, "date", dateId, { userId, contacted }, now);
  return { ok: true as const, contacted };
}
