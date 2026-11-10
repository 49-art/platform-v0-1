/**
 * Age assurance and ID + liveness — spec section 7 (verification flow).
 * DERIVED routes: the "Verification" API tab was not legible in the spec print (docs/spec/DERIVED.md).
 *
 * Rules taken from the complete parts of the spec:
 *  - Age assurance happens straight after sign-up and before any profile is built (flow nodes D, E, X2).
 *  - A failed age check means no access and the data we hold is minimised.
 *  - ID + liveness is asked for when a member wants to arrange a date (node H to L).
 *  - We store results only. Documents and selfies stay with the provider (spec 1: "We never store ID documents").
 */
import {
  type CheckKind, type CheckOutcome, SYSTEM, applyEnforcement, audit, banEvasionVerdict, blindIndex, checkProvider, enqueueModeration, isProduction,
  matchBanSignals, newId, notify, schema, signMockWebhook,
} from "../../core";
import { and, desc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { dispatch } from "../lib/dispatch";
import { rateLimit } from "../lib/guard";
import { requireStaff } from "../lib/staff";
import { removeMedia } from "../lib/media";
import { bad, body, forbidden, notFound, requireActive } from "../lib/http";
import type { DB } from "../../core";

const MAX_AGE_ATTEMPTS = 3;

export const verification = new Hono<AppEnv>();

verification.post("/api/age/start", async (c) => {
  const user = requireActive(c);
  const db = c.get("db");
  const checks = await db.select().from(schema.ageChecks).where(eq(schema.ageChecks.userId, user.id));
  if (checks.some((x) => x.status === "passed")) return c.json({ ok: true, alreadyPassed: true });
  if (checks.filter((x) => x.status === "failed").length >= MAX_AGE_ATTEMPTS) throw forbidden("age_blocked", "We could not confirm you are 18 or over, so this account cannot be used.");
  await rateLimit(c, `age-start:${user.id}`, 6, 3_600_000);
  const provider = checkProvider(c.env, "age");
  const hosted = await provider.start("age", user.id);
  await db.insert(schema.ageChecks).values({ id: newId("age"), userId: user.id, provider: hosted.provider, providerRef: hosted.providerRef, status: "pending", createdAt: c.get("now") });
  return c.json({ ok: true, url: hosted.url });
});

verification.post("/api/verification/start", async (c) => {
  const user = requireActive(c);
  const db = c.get("db");
  const [profile] = await db.select({ status: schema.profiles.status }).from(schema.profiles).where(eq(schema.profiles.userId, user.id));
  if (profile?.status !== "approved") throw forbidden("profile_not_approved", "Your profile needs to be approved before you can verify your identity.");
  const [latest] = await db.select().from(schema.idVerifications).where(eq(schema.idVerifications.userId, user.id)).orderBy(desc(schema.idVerifications.createdAt)).limit(1);
  if (latest?.status === "passed") return c.json({ ok: true, alreadyVerified: true });
  if (latest?.status === "review") throw bad("in_review", "Your verification is with our team for a manual check. We will let you know.");
  await rateLimit(c, `idv-start:${user.id}`, 5, 24 * 3_600_000);
  const provider = checkProvider(c.env, "idv");
  const hosted = await provider.start("idv", user.id);
  await db.insert(schema.idVerifications).values({ id: newId("idv"), userId: user.id, provider: hosted.provider, providerRef: hosted.providerRef, status: "pending", createdAt: c.get("now") });
  return c.json({ ok: true, url: hosted.url });
});

verification.get("/api/verification/status", async (c) => {
  const user = requireActive(c);
  const db = c.get("db");
  const age = await db.select({ status: schema.ageChecks.status, at: schema.ageChecks.createdAt }).from(schema.ageChecks).where(eq(schema.ageChecks.userId, user.id)).orderBy(desc(schema.ageChecks.createdAt));
  const idv = await db.select({ status: schema.idVerifications.status, at: schema.idVerifications.createdAt }).from(schema.idVerifications).where(eq(schema.idVerifications.userId, user.id)).orderBy(desc(schema.idVerifications.createdAt));
  return c.json({ age: age[0]?.status ?? "none", ageAttemptsLeft: Math.max(0, MAX_AGE_ATTEMPTS - age.filter((a) => a.status === "failed").length), idv: idv[0]?.status ?? "none" });
});

/** Minimise what we hold about someone who failed age assurance for the last time (flow node X2). */
async function minimiseAfterAgeFailure(env: Env, db: DB, userId: string, now: number) {
  const photos = await db.select({ key: schema.photos.r2Key }).from(schema.photos).where(eq(schema.photos.userId, userId));
  for (const p of photos) await removeMedia(env, p.key);
  await db.delete(schema.photos).where(eq(schema.photos.userId, userId));
  await db.delete(schema.profiles).where(eq(schema.profiles.userId, userId));
  await applyEnforcement(env, db, SYSTEM, { userId, kind: "suspend", reasonCode: "UNDERAGE", note: "Age assurance failed on every allowed attempt.", durationMs: 365 * 86_400_000 }, now);
}

/**
 * Applies a provider result. Idempotent: a webhook delivered twice changes nothing the second time.
 * Exported so the tests and the development provider page drive exactly the production code path.
 */
export async function applyCheckOutcome(env: Env, db: DB, kind: CheckKind, outcome: CheckOutcome, now = Date.now()): Promise<"applied" | "unknown" | "duplicate"> {
  if (kind === "age") {
    const [row] = await db.select().from(schema.ageChecks).where(and(eq(schema.ageChecks.provider, outcome.provider), eq(schema.ageChecks.providerRef, outcome.providerRef)));
    if (!row) return "unknown";
    if (row.status !== "pending") return "duplicate";
    // Age assurance has no "review" state: anything short of a pass is a fail.
    const status = outcome.status === "passed" ? "passed" : "failed";
    await db.update(schema.ageChecks).set({ status, method: outcome.method ?? null, decidedAt: now }).where(eq(schema.ageChecks.id, row.id));
    await audit(db, SYSTEM, `age.${status}`, "user", row.userId, { provider: outcome.provider, method: outcome.method }, now);
    if (status === "passed") {
      await notify(db, row.userId, { kind: "verification", title: "Age check passed", body: "You can build your profile now.", href: "/app/profile" }, now);
    } else {
      const failed = (await db.select({ id: schema.ageChecks.id }).from(schema.ageChecks).where(and(eq(schema.ageChecks.userId, row.userId), eq(schema.ageChecks.status, "failed")))).length;
      if (failed >= MAX_AGE_ATTEMPTS) await minimiseAfterAgeFailure(env, db, row.userId, now);
    }
    return "applied";
  }

  const [row] = await db.select().from(schema.idVerifications).where(and(eq(schema.idVerifications.provider, outcome.provider), eq(schema.idVerifications.providerRef, outcome.providerRef)));
  if (!row) return "unknown";
  if (row.status !== "pending") return "duplicate";
  const dupHash = outcome.duplicateToken ? await blindIndex(env, "id", outcome.duplicateToken) : null;

  // Ban evasion (spec 8): the provider says this is a person we have already banned.
  if (dupHash && banEvasionVerdict(await matchBanSignals(db, [{ kind: "id_duplicate", hash: dupHash }])) === "block") {
    await db.update(schema.idVerifications).set({ status: "failed", duplicateSignalHash: dupHash, decidedAt: now, reviewNote: "Matched a banned identity" }).where(eq(schema.idVerifications.id, row.id));
    await applyEnforcement(env, db, SYSTEM, { userId: row.userId, kind: "ban", reasonCode: "BAN_EVASION", note: "ID verification matched a permanently banned identity." }, now);
    return "applied";
  }
  // The same real person verified on a different live account: one person, one account.
  if (dupHash) {
    const others = await db.select({ userId: schema.idVerifications.userId }).from(schema.idVerifications)
      .innerJoin(schema.users, eq(schema.users.id, schema.idVerifications.userId))
      .where(and(eq(schema.idVerifications.duplicateSignalHash, dupHash), eq(schema.idVerifications.status, "passed"), eq(schema.users.status, "active")));
    if (others.some((o) => o.userId !== row.userId)) {
      await db.update(schema.idVerifications).set({ status: "review", duplicateSignalHash: dupHash, faceMatch: outcome.faceMatch ?? null, decidedAt: now, reviewNote: "Same identity already verified on another account" }).where(eq(schema.idVerifications.id, row.id));
      await enqueueModeration(db, { kind: "idv_review", refId: row.id, userId: row.userId, scores: { duplicateIdentity: true }, slaMs: 4 * 3_600_000 }, now);
      await notify(db, row.userId, { kind: "verification", title: "Verification needs a manual check", body: "A member of our team will review it and let you know.", href: "/app/verify" }, now);
      return "applied";
    }
  }

  // Flow node J: pass AND the face matches the profile photos. A pass with no face match goes to a human.
  const status = outcome.status === "passed" && outcome.faceMatch === true ? "passed" : outcome.status === "failed" ? "failed" : "review";
  await db.update(schema.idVerifications).set({ status, faceMatch: outcome.faceMatch ?? null, duplicateSignalHash: dupHash, decidedAt: now, reviewNote: status === "review" ? (outcome.status === "passed" ? "Provider passed but face did not match profile photos" : "Provider asked for manual review") : null }).where(eq(schema.idVerifications.id, row.id));
  await audit(db, SYSTEM, `idv.${status}`, "user", row.userId, { provider: outcome.provider, faceMatch: outcome.faceMatch ?? null }, now);
  if (status === "passed") await notify(db, row.userId, { kind: "verification", title: "You are verified", body: "Your Verified badge is live. Date tools unlock once your match is verified too.", href: "/app/matches" }, now);
  if (status === "failed") await notify(db, row.userId, { kind: "verification", title: "Verification did not pass", body: "You can try again. Use a clear photo of your ID and good lighting for the selfie.", href: "/app/verify" }, now);
  if (status === "review") {
    await enqueueModeration(db, { kind: "idv_review", refId: row.id, userId: row.userId, scores: { faceMatch: outcome.faceMatch ?? null, provider: outcome.status }, slaMs: 4 * 3_600_000 }, now);
    await notify(db, row.userId, { kind: "verification", title: "Verification needs a manual check", body: "A member of our team will review it and let you know.", href: "/app/verify" }, now);
  }
  return "applied";
}

async function webhook(c: Context<AppEnv>, kind: CheckKind) {
  const raw = await c.req.text();
  const provider = checkProvider(c.env, kind);
  const outcome = await provider.parseWebhook(kind, raw, c.req.raw.headers);
  if (!outcome) return c.json({ error: { code: "bad_signature", message: "Signature check failed." } }, 401);
  const result = await applyCheckOutcome(c.env, c.get("db"), kind, outcome, c.get("now"));
  if (result === "applied") {
    const table = kind === "age" ? schema.ageChecks : schema.idVerifications;
    const [row] = await c.get("db").select({ userId: table.userId }).from(table).where(eq(table.providerRef, outcome.providerRef));
    if (row) await dispatch(c.env, { kind: "notify", userId: row.userId, reason: "verification" });
  }
  // 200 for unknown / duplicate too: the provider should stop retrying.
  return c.json({ ok: true, result });
}
verification.post("/api/webhooks/age", (c) => webhook(c, "age"));
verification.post("/api/webhooks/idv", (c) => webhook(c, "idv"));

/* ── Development provider. Plays the vendor's hosted page so the whole flow can be walked locally. Never mounted in production. ── */

export const devProvider = new Hono<AppEnv>();

devProvider.use("*", async (c, next) => {
  if (isProduction(c.env)) throw notFound();
  await next();
});

devProvider.post("/api/dev/provider/complete", async (c) => {
  const user = requireActive(c);
  const input = await body(c, z.object({ kind: z.enum(["age", "idv"]), ref: z.string(), status: z.enum(["passed", "failed", "review"]), faceMatch: z.boolean().optional(), duplicateToken: z.string().optional() }));
  const db = c.get("db");
  const table = input.kind === "age" ? schema.ageChecks : schema.idVerifications;
  const [row] = await db.select({ userId: table.userId }).from(table).where(eq(table.providerRef, input.ref));
  if (!row || row.userId !== user.id) throw notFound();
  // Build and sign a webhook exactly as the vendor would, then run it through the same signature check and handler.
  const payload = JSON.stringify({ providerRef: input.ref, status: input.status, method: input.kind === "age" ? "face_estimation" : "id_document", faceMatch: input.faceMatch, duplicateToken: input.duplicateToken ?? `mock-person-${user.id}` });
  const outcome = await checkProvider(c.env, input.kind).parseWebhook(input.kind, payload, new Headers(await signMockWebhook(c.env, payload, c.get("now"))));
  if (!outcome) throw bad("bad_signature", "Signature check failed.");
  const result = await applyCheckOutcome(c.env, db, input.kind, outcome, c.get("now"));
  return c.json({ ok: true, result });
});

devProvider.get("/api/dev/outbox", async (c) => {
  // On a reachable deployment the outbox holds other people's links: staff only (sample mode, D-017).
  if (c.env.ENVIRONMENT !== "development" && c.env.ENVIRONMENT !== "test") await requireStaff(c, "audit.read");
  const rows = await c.get("db").select().from(schema.outbox).where(gt(schema.outbox.createdAt, c.get("now") - 7 * 86_400_000)).orderBy(desc(schema.outbox.createdAt)).limit(50);
  return c.json({ messages: rows });
});
