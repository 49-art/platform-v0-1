/**
 * SAMPLE mode (decision D-017). Lets the free sample be walked end to end with no email provider, no ID vendor
 * and no real members yet. Every behaviour here is switched off unless SAMPLE_MODE is "1", and none of it can run
 * when ENVIRONMENT is "production".
 *
 *  - Emailed links: no email is sent (no email provider on the free plan without a domain), so a link the email
 *    would carry is shown on screen instead, but only to the device that asked for it (see linkFor).
 *  - Sample members: an admin can add clearly labelled SAMPLE profiles so discovery is not empty, and remove them.
 *    They are not bots: they never message anyone. They only "like back", so the match and chat screens can be seen.
 */
import { type DB, coarseCell, newId, schema } from "../../core";
import { and, eq, inArray, like } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv, Env, User } from "../env";
import { putMedia, removeMedia } from "./media";
import { sampleAvatar } from "./png";
import { deviceHash } from "./session";

export const SAMPLE_DOMAIN = "sample.invalid"; // .invalid is reserved (RFC 2606): it can never be a real address

export const isSample = (env: Env) => env.SAMPLE_MODE === "1" && env.ENVIRONMENT !== "production";
export const isSampleMember = (email: string | null | undefined) => !!email && email.endsWith(`@${SAMPLE_DOMAIN}`);

/**
 * The link an email would have carried, revealed on screen in sample mode.
 * For a brand-new sign-up it is shown to whoever filled in the form (nothing was sent anywhere, so nobody else
 * is affected). For an existing account it is shown only on a device that account has already used, so typing
 * someone else's email address into "forgot password" cannot take their account over.
 */
export async function linkFor(c: Context<AppEnv>, link: string, account?: Pick<User, "deviceHash"> | null): Promise<{ link: string; note: string } | undefined> {
  if (!isSample(c.env)) return undefined;
  if (account && account.deviceHash !== (await deviceHash(c))) return undefined;
  return { link, note: "SAMPLE MODE: no email was sent. This is the link the email would contain." };
}

const PEOPLE = [
  { name: "Aisha", year: 1994, area: "London", lat: 51.515, lon: -0.142, looking: "relationship", country: "United Kingdom", verified: true },
  { name: "Ben", year: 1990, area: "Harrow", lat: 51.58, lon: -0.335, looking: "dinner", country: "Ireland", verified: true },
  { name: "Chloe", year: 1996, area: "Camden", lat: 51.539, lon: -0.143, looking: "dating", country: "France", verified: false },
  { name: "Dev", year: 1988, area: "Wembley", lat: 51.556, lon: -0.279, looking: "relationship", country: "India", verified: true },
  { name: "Ellie", year: 1992, area: "Ealing", lat: 51.513, lon: -0.305, looking: "friendship", country: "United Kingdom", verified: false },
  { name: "Femi", year: 1991, area: "Brixton", lat: 51.462, lon: -0.114, looking: "dinner", country: "Nigeria", verified: true },
  { name: "Grace", year: 1995, area: "Watford", lat: 51.656, lon: -0.39, looking: "relationship", country: "Jamaica", verified: false },
  { name: "Hugo", year: 1989, area: "Greenwich", lat: 51.482, lon: 0.0, looking: "dating", country: "Spain", verified: true },
];

export async function seedSampleMembers(env: Env, db: DB, now = Date.now()): Promise<number> {
  let added = 0;
  for (const [i, p] of PEOPLE.entries()) {
    const email = `sample-${p.name.toLowerCase()}@${SAMPLE_DOMAIN}`;
    const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    if (existing) continue;
    const id = newId("usr");
    // No password: a sample member can never be signed in to.
    await db.insert(schema.users).values({ id, email, emailVerifiedAt: now, createdAt: now });
    await db.insert(schema.ageChecks).values({ id: newId("age"), userId: id, provider: "sample", providerRef: `sample-age-${id}`, method: "sample", status: "passed", createdAt: now, decidedAt: now });
    if (p.verified) await db.insert(schema.idVerifications).values({ id: newId("idv"), userId: id, provider: "sample", providerRef: `sample-idv-${id}`, status: "passed", faceMatch: true, createdAt: now, decidedAt: now });
    await db.insert(schema.profiles).values({
      userId: id, displayName: `${p.name} (SAMPLE)`, birthYear: p.year,
      bio: `SAMPLE PROFILE, not a real person. Added so you can see how browsing, liking and matching work. ${p.name} will like you back but never sends messages.`,
      lookingFor: p.looking, countryOfOrigin: p.country, areaLabel: p.area, ...coarseCell(p.lat, p.lon),
      status: "approved", submittedAt: now, approvedAt: now - i * 60_000, updatedAt: now,
    });
    const photoId = newId("pho");
    const key = `u/${id}/${photoId}`;
    const png = sampleAvatar(i);
    await putMedia(env, key, png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, "image/png");
    await db.insert(schema.photos).values({ id: photoId, userId: id, r2Key: key, contentType: "image/png", bytes: png.byteLength, position: 0, purpose: "profile", status: "approved", scores: JSON.stringify({ provider: "sample" }), createdAt: now });
    added++;
  }
  return added;
}

export async function removeSampleMembers(env: Env, db: DB): Promise<number> {
  const rows = await db.select({ id: schema.users.id }).from(schema.users).where(like(schema.users.email, `%@${SAMPLE_DOMAIN}`));
  const ids = rows.map((r) => r.id);
  if (!ids.length) return 0;
  const photos = await db.select({ key: schema.photos.r2Key }).from(schema.photos).where(inArray(schema.photos.userId, ids));
  for (const p of photos) await removeMedia(env, p.key);
  await db.delete(schema.photos).where(inArray(schema.photos.userId, ids));
  await db.delete(schema.profiles).where(inArray(schema.profiles.userId, ids));
  await db.delete(schema.ageChecks).where(inArray(schema.ageChecks.userId, ids));
  await db.delete(schema.idVerifications).where(inArray(schema.idVerifications.userId, ids));
  await db.delete(schema.likes).where(inArray(schema.likes.fromUser, ids));
  await db.delete(schema.likes).where(inArray(schema.likes.toUser, ids));
  // Conversations with sample members are closed rather than deleted: the real member's side is their data.
  for (const id of ids) {
    await db.update(schema.conversations).set({ status: "closed", frozenReason: "member_left" }).where(eq(schema.conversations.userA, id));
    await db.update(schema.conversations).set({ status: "closed", frozenReason: "member_left" }).where(eq(schema.conversations.userB, id));
  }
  await db.update(schema.users).set({ status: "deleted", deletedAt: Date.now(), email: null, emailHash: null }).where(inArray(schema.users.id, ids));
  return ids.length;
}

/** A sample member likes back whoever likes them, so a real person can see a match and open the chat. */
export async function sampleLikeBack(env: Env, db: DB, fromUser: string, toUser: string, now: number) {
  if (!isSample(env)) return;
  const [target] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, toUser));
  if (!isSampleMember(target?.email)) return;
  await db.insert(schema.likes).values({ fromUser: toUser, toUser: fromUser, kind: "like", createdAt: now }).onConflictDoNothing();
}

export async function countSampleMembers(db: DB) {
  const rows = await db.select({ id: schema.users.id }).from(schema.users).where(and(like(schema.users.email, `%@${SAMPLE_DOMAIN}`), eq(schema.users.status, "active")));
  return rows.length;
}
