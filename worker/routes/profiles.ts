/**
 * Profiles, photos, discovery and matching.
 * DERIVED: the Profiles and Discovery feature tables and API tab were not legible in the spec print.
 * Built from spec 1 (privacy by default, safety over growth), 2 (journey steps 3 to 5), 7 and 9.
 */
import {
  ALLOWED_IMAGE_TYPES, CONSENT_VERSION, type DB, MAX_PHOTOS, MAX_PHOTO_BYTES, MIN_AGE, UK_AREAS, audit, banEvasionVerdict, boundingBox, cellDistanceKm,
  coarseCell, decryptJson, detectContactDetails, encryptJson, enqueueModeration, hasActiveConsent, isBlockedEitherWay, isInUk, isVerified, matchBanSignals,
  newId, notify, schema, sha256Hex, signMediaPath, verifyMediaSignature,
} from "../../core";
import { and, asc, between, desc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { dispatch } from "../lib/dispatch";
import { rateLimit } from "../lib/guard";
import { getMedia, putMedia, removeMedia } from "../lib/media";
import { sampleLikeBack } from "../lib/sample";
import { bad, body, forbidden, notFound, requireActive, requireUser } from "../lib/http";

export interface Identity {
  gender?: string;
  orientation?: string;
  pronouns?: string;
  /** Which of the above the member has chosen to display. Nothing is shown unless listed here (minimal display). */
  show: ("gender" | "orientation" | "pronouns")[];
}

const HOUR = 3_600_000;
/** Expiry is rounded so the same photo keeps one URL for up to an hour and the browser can cache it. */
export const photoUrl = (env: Env, key: string, viewerId: string, now: number) => signMediaPath(env.APP_SECRET, key, viewerId, Math.ceil(now / HOUR) * HOUR + HOUR);

function sniffImage(bytes: Uint8Array): (typeof ALLOWED_IMAGE_TYPES)[number] | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

async function agePassed(db: DB, userId: string) {
  const [row] = await db.select({ id: schema.ageChecks.id }).from(schema.ageChecks).where(and(eq(schema.ageChecks.userId, userId), eq(schema.ageChecks.status, "passed"))).limit(1);
  return !!row;
}

/** What one member may see of another. Used by discovery, matches and chat headers. */
export async function publicProfile(env: Env, db: DB, viewer: { id: string; geoCell?: string | null }, userId: string, now: number) {
  const [p] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, userId));
  if (!p) return null;
  const photos = await db.select().from(schema.photos).where(and(eq(schema.photos.userId, userId), eq(schema.photos.purpose, "profile"), eq(schema.photos.status, "approved"))).orderBy(asc(schema.photos.position));
  const identity = await decryptJson<Identity>(env.APP_SECRET, p.identityEnc, `profile:${userId}:identity`);
  const shown: Record<string, string> = {};
  for (const key of identity?.show ?? []) if (identity?.[key]) shown[key] = identity[key]!;
  return {
    userId, displayName: p.displayName, age: p.birthYear ? new Date(now).getUTCFullYear() - p.birthYear : null, bio: p.bio, lookingFor: p.lookingFor,
    countryOfOrigin: p.countryOfOrigin, area: p.areaLabel, identity: shown, verified: await isVerified(db, userId),
    distanceKm: viewer.geoCell && p.geoCell ? cellDistanceKm(viewer.geoCell, p.geoCell) : null,
    photos: await Promise.all(photos.map((ph) => photoUrl(env, ph.r2Key, viewer.id, now))),
    available: p.status === "approved",
  };
}

export const profiles = new Hono<AppEnv>();

/* ── Consent ledger (UK GDPR Art. 9: separate, withdrawable, versioned) ── */

profiles.get("/api/consents", async (c) => {
  const user = requireUser(c);
  const rows = await c.get("db").select().from(schema.consents).where(and(eq(schema.consents.userId, user.id), eq(schema.consents.scope, ""))).orderBy(desc(schema.consents.grantedAt));
  return c.json({ version: CONSENT_VERSION, consents: rows.map((r) => ({ kind: r.kind, grantedAt: r.grantedAt, withdrawnAt: r.withdrawnAt, version: r.version })) });
});

profiles.post("/api/consents", async (c) => {
  const user = requireActive(c);
  const input = await body(c, z.object({ kind: z.enum(["special_category", "marketing", "explicit_media"]), granted: z.boolean() }));
  const db = c.get("db");
  const now = c.get("now");
  const active = await hasActiveConsent(db, user.id, input.kind);
  if (input.granted && !active) await db.insert(schema.consents).values({ id: newId("con"), userId: user.id, kind: input.kind, grantedAt: now, version: CONSENT_VERSION });
  if (!input.granted && active) {
    await db.update(schema.consents).set({ withdrawnAt: now }).where(and(eq(schema.consents.userId, user.id), eq(schema.consents.kind, input.kind), eq(schema.consents.scope, ""), isNull(schema.consents.withdrawnAt)));
    // Withdrawing consent removes the data it covered, straight away.
    if (input.kind === "special_category") await db.update(schema.profiles).set({ identityEnc: null, updatedAt: now }).where(eq(schema.profiles.userId, user.id));
  }
  await audit(db, { id: user.id, role: "member" }, input.granted ? "consent.granted" : "consent.withdrawn", "user", user.id, { kind: input.kind, version: CONSENT_VERSION }, now);
  return c.json({ ok: true });
});

/* ── Own profile ── */

profiles.get("/api/taxonomy", async (c) => {
  const rows = await c.get("db").select().from(schema.taxonomy).where(eq(schema.taxonomy.active, true)).orderBy(asc(schema.taxonomy.position));
  const pick = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => ({ slug: r.slug, label: r.label }));
  return c.json({ lookingFor: pick("looking_for"), gender: pick("gender"), orientation: pick("orientation"), areas: UK_AREAS.map((a) => a.label) });
});

profiles.get("/api/profile", async (c) => {
  const user = requireActive(c);
  const db = c.get("db");
  const [p] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, user.id));
  const photos = await db.select().from(schema.photos).where(and(eq(schema.photos.userId, user.id), eq(schema.photos.purpose, "profile"))).orderBy(asc(schema.photos.position));
  return c.json({
    profile: p ? { displayName: p.displayName, birthYear: p.birthYear, bio: p.bio, lookingFor: p.lookingFor, countryOfOrigin: p.countryOfOrigin, area: p.areaLabel, hasLocation: !!p.geoCell, status: p.status, rejectionReason: p.rejectionReason } : null,
    identity: p ? await decryptJson<Identity>(c.env.APP_SECRET, p.identityEnc, `profile:${user.id}:identity`) : null,
    specialCategoryConsent: await hasActiveConsent(db, user.id, "special_category"),
    photos: await Promise.all(photos.filter((ph) => ph.status !== "quarantined").map(async (ph) => ({ id: ph.id, status: ph.status, url: await photoUrl(c.env, ph.r2Key, user.id, c.get("now")) }))),
    limits: { maxPhotos: MAX_PHOTOS, maxPhotoBytes: MAX_PHOTO_BYTES },
  });
});

const profileInput = z.object({
  displayName: z.string().trim().min(2).max(30),
  birthYear: z.number().int().min(1900).max(2100),
  bio: z.string().trim().max(600),
  lookingFor: z.string().max(40),
  countryOfOrigin: z.string().trim().max(60),
  location: z.union([z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), label: z.string().trim().max(40).optional() }), z.object({ area: z.string().max(40) })]).optional(),
  identity: z.object({ gender: z.string().max(40).optional(), orientation: z.string().max(40).optional(), pronouns: z.string().max(20).optional(), show: z.array(z.enum(["gender", "orientation", "pronouns"])).max(3) }).nullable().optional(),
});

profiles.put("/api/profile", async (c) => {
  const user = requireActive(c);
  const db = c.get("db");
  const now = c.get("now");
  if (!(await agePassed(db, user.id))) throw forbidden("age_required", "Please complete the age check first.");
  const input = await body(c, profileInput);
  if (new Date(now).getUTCFullYear() - input.birthYear < MIN_AGE) throw bad("under_age", "You must be 18 or over to use this service.");
  // Contact details in a profile are the commonest way round the "verify before you meet" rule.
  if (detectContactDetails(`${input.displayName} ${input.bio}`).length) throw bad("contact_in_profile", "Please remove phone numbers, usernames, emails and links from your profile.");

  const [existing] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, user.id));
  const set: Partial<typeof schema.profiles.$inferInsert> = { displayName: input.displayName, birthYear: input.birthYear, bio: input.bio, lookingFor: input.lookingFor, countryOfOrigin: input.countryOfOrigin, updatedAt: now };

  if (input.location) {
    const point = "area" in input.location ? UK_AREAS.find((a) => a.label === (input.location as { area: string }).area) : { lat: input.location.lat, lon: input.location.lon, label: input.location.label ?? "" };
    if (!point) throw bad("bad_area", "Choose an area from the list.");
    if (!isInUk(point.lat, point.lon)) throw bad("outside_launch_area", "We are only open in the UK for now.");
    Object.assign(set, coarseCell(point.lat, point.lon), { areaLabel: point.label || nearestArea(point.lat, point.lon) }); // exact coordinates are dropped here
  }

  if (input.identity !== undefined) {
    if (input.identity === null) set.identityEnc = null;
    else {
      // Special category data is only ever written under a live, explicit consent.
      if (!(await hasActiveConsent(db, user.id, "special_category"))) throw forbidden("consent_required", "We need your explicit consent before storing this information.");
      set.identityEnc = await encryptJson(c.env.APP_SECRET, input.identity, `profile:${user.id}:identity`);
    }
  }

  // Text that members see is pre-moderated, so changing it on a live profile sends it back for approval (decision D-009).
  const textChanged = !!existing && (existing.displayName !== input.displayName || existing.bio !== input.bio);
  if (existing && (existing.status === "approved" || existing.status === "hidden") && textChanged) {
    set.status = "pending";
    set.submittedAt = now;
    await enqueueModeration(db, { kind: "profile", refId: user.id, userId: user.id, scores: { resubmission: true }, slaMs: slaMs(c.env) }, now);
  }
  if (existing) await db.update(schema.profiles).set(set).where(eq(schema.profiles.userId, user.id));
  else await db.insert(schema.profiles).values({ userId: user.id, ...set, updatedAt: now });
  return c.json({ ok: true, status: set.status ?? existing?.status ?? "draft" });
});

const slaMs = (env: Env) => Number(env.PREMOD_SLA_HOURS ?? "4") * HOUR;
function nearestArea(lat: number, lon: number) {
  let best = UK_AREAS[0]!, d = Infinity;
  for (const a of UK_AREAS) { const x = (a.lat - lat) ** 2 + (a.lon - lon) ** 2; if (x < d) { d = x; best = a; } }
  return `Near ${best.label}`;
}

profiles.post("/api/profile/submit", async (c) => {
  const user = requireActive(c);
  const db = c.get("db");
  const now = c.get("now");
  const [p] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, user.id));
  if (!p) throw bad("no_profile", "Fill in your profile first.");
  if (p.status === "pending") return c.json({ ok: true, status: "pending" });
  if (p.status === "approved") return c.json({ ok: true, status: "approved" });
  const photos = await db.select().from(schema.photos).where(and(eq(schema.photos.userId, user.id), eq(schema.photos.purpose, "profile"), inArray(schema.photos.status, ["pending", "approved"])));
  const missing = [!p.displayName && "a display name", !p.birthYear && "your year of birth", !p.lookingFor && "what you are looking for", !p.geoCell && "your area", photos.length === 0 && "at least one photo of you"].filter(Boolean);
  if (missing.length) throw bad("incomplete", `Please add ${missing.join(", ")}.`);
  await db.update(schema.profiles).set({ status: "pending", submittedAt: now, rejectionReason: null, updatedAt: now }).where(eq(schema.profiles.userId, user.id));
  await enqueueModeration(db, { kind: "profile", refId: user.id, userId: user.id, slaMs: slaMs(c.env) }, now);
  return c.json({ ok: true, status: "pending" });
});

/* ── Photos (private R2, scan before anyone sees them) ── */

profiles.post("/api/photos", async (c) => {
  const user = requireActive(c);
  const db = c.get("db");
  const now = c.get("now");
  if (!(await agePassed(db, user.id))) throw forbidden("age_required", "Please complete the age check first.");
  await rateLimit(c, `photo-upload:${user.id}`, 30, HOUR);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") throw bad("no_file", "Choose a photo to upload.");
  const conversationId = typeof form?.get("conversationId") === "string" ? (form!.get("conversationId") as string) : null;
  const purpose = conversationId ? "chat" : "profile";
  if (file.size > MAX_PHOTO_BYTES) throw bad("too_large", `Photos must be under ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB.`);
  const bytes = await file.arrayBuffer();
  // Trust the bytes, not the filename or the declared type.
  const type = sniffImage(new Uint8Array(bytes.slice(0, 16)));
  if (!type) throw bad("bad_type", "Photos must be JPEG, PNG or WebP.");

  if (purpose === "profile") {
    const count = (await db.select({ id: schema.photos.id }).from(schema.photos).where(and(eq(schema.photos.userId, user.id), eq(schema.photos.purpose, "profile"), inArray(schema.photos.status, ["pending", "approved"])))).length;
    if (count >= MAX_PHOTOS) throw bad("too_many", `You can have up to ${MAX_PHOTOS} photos.`);
  } else {
    const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId!));
    if (!conv || (conv.userA !== user.id && conv.userB !== user.id)) throw notFound();
    if (conv.status !== "open") throw forbidden("conversation_closed", "This conversation is closed.");
    if (user.restrictedUntil && user.restrictedUntil > now) throw forbidden("restricted", "Messaging is paused on your account.");
  }

  const contentHash = await sha256Hex(bytes);
  const id = newId("pho");
  const key = `u/${user.id}/${id}`;
  await putMedia(c.env, key, bytes, type);
  const [{ max } = { max: -1 }] = await db.select({ max: sql<number>`coalesce(max(${schema.photos.position}), -1)` }).from(schema.photos).where(and(eq(schema.photos.userId, user.id), eq(schema.photos.purpose, "profile")));
  await db.insert(schema.photos).values({ id, userId: user.id, r2Key: key, contentType: type, bytes: file.size, position: max + 1, purpose, conversationId, contentHash, createdAt: now });
  // A photo already used on a banned account is a weak ban-evasion signal: a senior moderator looks.
  if (purpose === "profile" && banEvasionVerdict(await matchBanSignals(db, [{ kind: "photo", hash: contentHash }])) === "review") await enqueueModeration(db, { kind: "ban_evasion", refId: user.id, userId: user.id, scores: { signal: "photo", photoId: id }, slaMs: HOUR }, now);
  await dispatch(c.env, { kind: "scan_photo", photoId: id });
  return c.json({ ok: true, photo: { id, status: "pending", url: await photoUrl(c.env, key, user.id, now) } });
});

profiles.delete("/api/photos/:id", async (c) => {
  const user = requireActive(c);
  const db = c.get("db");
  const [ph] = await db.select().from(schema.photos).where(and(eq(schema.photos.id, c.req.param("id")), eq(schema.photos.userId, user.id)));
  if (!ph) throw notFound();
  // Quarantined media is evidence and is never deleted by the member (spec 8: CSAM path).
  if (ph.status === "quarantined") throw forbidden("held", "This item cannot be removed.");
  await removeMedia(c.env, ph.r2Key);
  await db.delete(schema.photos).where(eq(schema.photos.id, ph.id));
  return c.json({ ok: true });
});

/** Private media. A URL is signed for one viewer, expires, and is still checked against the photo's current state. */
profiles.get("/media/*", async (c) => {
  const user = requireUser(c);
  const key = decodeURIComponent(new URL(c.req.url).pathname.slice("/media/".length));
  const viewer = c.req.query("u") ?? "";
  const ok = viewer === user.id && (await verifyMediaSignature(c.env.APP_SECRET, key, viewer, Number(c.req.query("e")), c.req.query("s") ?? "", c.get("now")));
  if (!ok) throw forbidden("bad_signature", "This link has expired.");
  const db = c.get("db");
  const [ph] = await db.select().from(schema.photos).where(eq(schema.photos.r2Key, key));
  if (!ph || ph.status === "quarantined") throw notFound();
  if (ph.userId !== user.id) {
    if (ph.status !== "approved") throw notFound(); // nothing is shown to others before it passes scanning and moderation
    if (await isBlockedEitherWay(db, user.id, ph.userId)) throw notFound();
    if (ph.purpose === "chat") {
      const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, ph.conversationId ?? ""));
      if (!conv || (conv.userA !== user.id && conv.userB !== user.id)) throw notFound();
    }
  }
  const obj = await getMedia(c.env, key);
  if (!obj) throw notFound();
  return new Response(obj.body, { headers: { "content-type": ph.contentType, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" } });
});

/* ── Discovery ── */

profiles.get("/api/discover", async (c) => {
  const user = requireActive(c);
  const db = c.get("db");
  const now = c.get("now");
  const [me] = await db.select().from(schema.profiles).where(eq(schema.profiles.userId, user.id));
  if (me?.status !== "approved") throw forbidden("profile_not_approved", "Your profile needs to be approved before you can browse.");
  const q = z.object({ minAge: z.coerce.number().int().min(18).max(99).default(18), maxAge: z.coerce.number().int().min(18).max(99).default(99), km: z.coerce.number().min(5).max(800).default(50), lookingFor: z.string().max(40).optional(), country: z.string().max(60).optional(), gender: z.string().max(40).optional(), verifiedOnly: z.enum(["0", "1"]).default("0") }).parse(c.req.query());
  await rateLimit(c, `discover:${user.id}`, 120, HOUR);
  const year = new Date(now).getUTCFullYear();
  const box = boundingBox(me.cellLat ?? 0, me.cellLon ?? 0, q.km);

  const seen = db.select({ id: schema.likes.toUser }).from(schema.likes).where(eq(schema.likes.fromUser, user.id));
  const blockedByMe = db.select({ id: schema.blocks.blocked }).from(schema.blocks).where(eq(schema.blocks.blocker, user.id));
  const blockedMe = db.select({ id: schema.blocks.blocker }).from(schema.blocks).where(eq(schema.blocks.blocked, user.id));
  const rows = await db.select({ userId: schema.profiles.userId, geoCell: schema.profiles.geoCell }).from(schema.profiles)
    .innerJoin(schema.users, eq(schema.users.id, schema.profiles.userId))
    .where(and(
      eq(schema.profiles.status, "approved"), eq(schema.users.status, "active"), ne(schema.profiles.userId, user.id),
      between(schema.profiles.cellLat, box.latMin, box.latMax), between(schema.profiles.cellLon, box.lonMin, box.lonMax),
      between(schema.profiles.birthYear, year - q.maxAge, year - q.minAge),
      q.lookingFor ? eq(schema.profiles.lookingFor, q.lookingFor) : undefined,
      q.country ? eq(schema.profiles.countryOfOrigin, q.country) : undefined,
      notInArray(schema.profiles.userId, seen), notInArray(schema.profiles.userId, blockedByMe), notInArray(schema.profiles.userId, blockedMe),
    ))
    .orderBy(desc(schema.profiles.approvedAt)).limit(60);

  const out = [];
  for (const r of rows) {
    const km = cellDistanceKm(me.geoCell, r.geoCell);
    if (km !== null && km > q.km) continue;
    const p = await publicProfile(c.env, db, { id: user.id, geoCell: me.geoCell }, r.userId, now);
    if (!p || p.photos.length === 0) continue;
    if (q.verifiedOnly === "1" && !p.verified) continue;
    // A gender filter only ever matches people who chose to display it: undisclosed data is never used to sort people.
    if (q.gender && p.identity.gender !== q.gender) continue;
    out.push(p);
    if (out.length >= 20) break;
  }
  return c.json({ profiles: out });
});

profiles.get("/api/profiles/:id", async (c) => {
  const user = requireActive(c);
  const db = c.get("db");
  const id = c.req.param("id");
  if (await isBlockedEitherWay(db, user.id, id)) throw notFound();
  const [me] = await db.select({ geoCell: schema.profiles.geoCell, status: schema.profiles.status }).from(schema.profiles).where(eq(schema.profiles.userId, user.id));
  if (me?.status !== "approved") throw forbidden("profile_not_approved", "Your profile needs to be approved first.");
  const p = await publicProfile(c.env, db, { id: user.id, geoCell: me.geoCell }, id, c.get("now"));
  if (!p || !p.available) throw notFound();
  return c.json({ profile: p });
});

/* ── Likes and matches ── */

profiles.post("/api/likes", async (c) => {
  const user = requireActive(c);
  const db = c.get("db");
  const now = c.get("now");
  const input = await body(c, z.object({ userId: z.string(), kind: z.enum(["like", "pass"]) }));
  if (input.userId === user.id) throw bad("self", "You cannot like yourself.");
  await rateLimit(c, `likes:${user.id}`, 150, 24 * HOUR); // a person does not like 150 people a day; a bot does
  const rows = await db.select({ userId: schema.profiles.userId, status: schema.profiles.status }).from(schema.profiles).where(inArray(schema.profiles.userId, [user.id, input.userId]));
  if (rows.find((r) => r.userId === user.id)?.status !== "approved") throw forbidden("profile_not_approved", "Your profile needs to be approved first.");
  if (rows.find((r) => r.userId === input.userId)?.status !== "approved" || (await isBlockedEitherWay(db, user.id, input.userId))) throw notFound();
  await db.insert(schema.likes).values({ fromUser: user.id, toUser: input.userId, kind: input.kind, createdAt: now }).onConflictDoUpdate({ target: [schema.likes.fromUser, schema.likes.toUser], set: { kind: input.kind, createdAt: now } });
  if (input.kind === "pass") return c.json({ ok: true, matched: false });
  await sampleLikeBack(c.env, db, user.id, input.userId, now);

  const [back] = await db.select().from(schema.likes).where(and(eq(schema.likes.fromUser, input.userId), eq(schema.likes.toUser, user.id), eq(schema.likes.kind, "like")));
  if (!back) return c.json({ ok: true, matched: false });
  const [a, b] = [user.id, input.userId].sort() as [string, string];
  const [already] = await db.select().from(schema.matches).where(and(eq(schema.matches.userA, a), eq(schema.matches.userB, b)));
  if (already) return c.json({ ok: true, matched: true, conversationId: already.conversationId });
  const conversationId = newId("cnv");
  await db.insert(schema.conversations).values({ id: conversationId, userA: a, userB: b, createdAt: now });
  await db.insert(schema.matches).values({ id: newId("mat"), userA: a, userB: b, conversationId, createdAt: now });
  for (const uid of [a, b]) {
    await notify(db, uid, { kind: "match", title: "It's a match", body: "You both liked each other. Say hello.", href: `/app/chat/${conversationId}` }, now);
    await dispatch(c.env, { kind: "notify", userId: uid, reason: "match" });
  }
  return c.json({ ok: true, matched: true, conversationId });
});

profiles.get("/api/matches", async (c) => {
  const user = requireActive(c);
  const db = c.get("db");
  const now = c.get("now");
  const [me] = await db.select({ geoCell: schema.profiles.geoCell }).from(schema.profiles).where(eq(schema.profiles.userId, user.id));
  const convs = await db.select().from(schema.conversations).where(and(or(eq(schema.conversations.userA, user.id), eq(schema.conversations.userB, user.id)), ne(schema.conversations.status, "closed"))).orderBy(desc(sql`coalesce(${schema.conversations.lastMessageAt}, ${schema.conversations.createdAt})`));
  const hub = await c.env.USER_HUB.get(c.env.USER_HUB.idFromName(user.id)).snapshot();
  const out = [];
  for (const conv of convs) {
    const otherId = conv.userA === user.id ? conv.userB : conv.userA;
    if (await isBlockedEitherWay(db, user.id, otherId)) continue;
    const p = await publicProfile(c.env, db, { id: user.id, geoCell: me?.geoCell }, otherId, now);
    if (!p) continue;
    const online = p.available ? await c.env.USER_HUB.get(c.env.USER_HUB.idFromName(otherId)).isOnline() : false;
    out.push({ conversationId: conv.id, status: conv.status, lastMessageAt: conv.lastMessageAt, unread: hub.unread[conv.id] ?? 0, online, other: { userId: p.userId, displayName: p.available ? p.displayName : "Member unavailable", age: p.age, area: p.area, verified: p.verified, photo: p.available ? (p.photos[0] ?? null) : null, available: p.available } });
  }
  return c.json({ matches: out });
});
