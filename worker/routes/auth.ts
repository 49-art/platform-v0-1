/**
 * Auth and account — spec section 3 "Auth and account" and section 5 "Auth" tab.
 * Every acceptance criterion in that table has a test in test/auth.test.ts.
 */
import {
  EMAIL_VERIFY_TTL_MS, RESET_TOKEN_TTL_MS, audit, banEvasionVerdict, blindIndex, deliver, enqueueModeration, matchBanSignals, memberFlags, newId,
  pkceChallenge, randomToken, requestDeletion, schema, seal, sha256Hex, unseal, verifyPassword,
} from "../../core";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv, User } from "../env";
import { botEvent, rateLimit, rateLimitIp, requireTurnstile } from "../lib/guard";
import { bad, body, forbidden, notFound, requireUser } from "../lib/http";
import { CSRF, deviceHash, endSession, hashPassword, requireFreshAuth, revokeAllSessions, shouldRehash, startSession } from "../lib/session";
import type { Context } from "hono";
import { isSample, linkFor } from "../lib/sample";
import { buildExport } from "./export";

const email = z.string().trim().toLowerCase().email().max(254);
// Length over composition rules (NIST 800-63B): 10+ characters, any characters, checked against the obvious.
const password = z.string().min(10, "Use at least 10 characters.").max(200).refine((p) => !/^(.)\1+$/.test(p) && !["password123", "1234567890", "qwertyuiop"].includes(p.toLowerCase()), "That password is too easy to guess.");

const MIN = 60_000;
const GENERIC_SIGNUP = { ok: true, message: "Check your inbox. If that address can be used, we have sent a link to finish signing up." };
const GENERIC_RESET = { ok: true, message: "If an account exists for that address, we have sent a reset link. It works once and expires in 30 minutes." };
const BAD_LOGIN = "That email and password do not match.";

async function issueToken(c: Context<AppEnv>, userId: string, kind: "email_verify" | "reset" | "reauth", ttl: number) {
  const token = randomToken(32);
  const db = c.get("db");
  // One live token per kind: asking again invalidates the previous link.
  await db.update(schema.authTokens).set({ usedAt: c.get("now") }).where(and(eq(schema.authTokens.userId, userId), eq(schema.authTokens.kind, kind), isNull(schema.authTokens.usedAt)));
  await db.insert(schema.authTokens).values({ id: newId("tok"), userId, kind, tokenHash: await sha256Hex(token), expiresAt: c.get("now") + ttl });
  return token;
}

/** Atomically consumes a token: the UPDATE only matches an unused, unexpired row, so a link cannot be used twice. */
async function consumeToken(c: Context<AppEnv>, token: string, kind: "email_verify" | "reset" | "reauth") {
  const now = c.get("now");
  const rows = await c.get("db").update(schema.authTokens).set({ usedAt: now })
    .where(and(eq(schema.authTokens.tokenHash, await sha256Hex(token)), eq(schema.authTokens.kind, kind), isNull(schema.authTokens.usedAt)))
    .returning();
  const row = rows[0];
  if (!row || row.expiresAt < now) return null;
  return row;
}

async function sendVerifyEmail(c: Context<AppEnv>, user: { id: string; email: string }) {
  const token = await issueToken(c, user.id, "email_verify", EMAIL_VERIFY_TTL_MS);
  const link = `${c.env.APP_ORIGIN}/verify-email?token=${token}`;
  await deliver(c.env, c.get("db"), {
    channel: "email", to: user.email, template: "verify_email", subject: `Confirm your email for ${c.env.APP_NAME}`,
    body: `Confirm your email to continue:\n\n${link}\n\nThis link works once and expires in 24 hours. If you did not sign up, ignore this email.`,
  }, c.get("now"));
  return link;
}

export async function mePayload(c: Context<AppEnv>, user: User) {
  const db = c.get("db");
  const flags = await memberFlags(db, user.id);
  const [x] = await db.select({ handle: schema.oauthAccounts.handle }).from(schema.oauthAccounts).where(eq(schema.oauthAccounts.userId, user.id));
  const emailVerified = !!user.emailVerifiedAt;
  const failedAge = (await db.select({ id: schema.ageChecks.id }).from(schema.ageChecks).where(and(eq(schema.ageChecks.userId, user.id), eq(schema.ageChecks.status, "failed")))).length;
  // The single source of truth for "what must this member do next" — the verification flow in spec 7.
  const step =
    user.status === "banned" ? "banned" : user.status === "suspended" ? "suspended"
    : !user.email ? "email_capture" : !emailVerified ? "email_verify"
    : !flags.agePassed ? "age"
    : flags.profileStatus === "none" || flags.profileStatus === "draft" || flags.profileStatus === "rejected" ? "profile"
    : flags.profileStatus === "pending" ? "pending" : "ready";
  return {
    user: { id: user.id, email: user.email, role: user.role, status: user.status, hasPassword: !!user.passwordHash, xHandle: x?.handle ?? null, restrictedUntil: user.restrictedUntil, suspendedUntil: user.suspendedUntil, createdAt: user.createdAt },
    flags: { emailVerified, ...flags, ageAttemptsLeft: Math.max(0, 3 - failedAge) },
    step,
    csrf: getCookie(c, CSRF) ?? null,
  };
}

export const auth = new Hono<AppEnv>();

auth.post("/api/auth/signup", async (c) => {
  const input = await body(c, z.object({ email, password, turnstileToken: z.string().optional(), over18: z.literal(true, "You must confirm you are 18 or over."), acceptTerms: z.literal(true, "You must accept the terms.") }));
  await rateLimitIp(c, "signup", 5, 60 * MIN);
  await requireTurnstile(c, input.turnstileToken);
  const db = c.get("db");
  const emailHash = await blindIndex(c.env, "email", input.email);
  const dev = await deviceHash(c);

  const verdict = banEvasionVerdict(await matchBanSignals(db, [{ kind: "email", hash: emailHash }]));
  if (verdict === "block") {
    await botEvent(c, "ban_evasion_block");
    return c.json(GENERIC_SIGNUP); // same response: a banned person learns nothing from the form
  }

  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, input.email));
  if (existing) {
    // Never reveal that the address is registered. Tell the owner by email instead.
    if (existing.status !== "deleted") {
      await deliver(c.env, db, { channel: "email", to: input.email, template: "signup_existing", subject: `You already have a ${c.env.APP_NAME} account`, body: `Someone tried to sign up with this address. You already have an account: sign in at ${c.env.APP_ORIGIN}/login, or reset your password at ${c.env.APP_ORIGIN}/reset.` }, c.get("now"));
    }
    // Sample mode: the "you already have an account" email carries a sign-in link, so show that one. Same shape either way.
    return c.json({ ...GENERIC_SIGNUP, sample: await linkFor(c, `${c.env.APP_ORIGIN}/login`) });
  }

  const id = newId("usr");
  await db.insert(schema.users).values({ id, email: input.email, emailHash, passwordHash: await hashPassword(c.env, input.password), deviceHash: dev, createdAt: c.get("now") });
  // A banned person's device is a weak signal: let them in, but put the account in front of a senior moderator.
  if (banEvasionVerdict(await matchBanSignals(db, [{ kind: "device", hash: dev }])) === "review") await enqueueModeration(db, { kind: "ban_evasion", refId: id, userId: id, scores: { signal: "device" }, slaMs: 3_600_000 }, c.get("now"));
  const link = await sendVerifyEmail(c, { id, email: input.email });
  await audit(db, { id, role: "member" }, "account.signup", "user", id, { via: "email" }, c.get("now"));
  return c.json({ ...GENERIC_SIGNUP, sample: await linkFor(c, link) });
});

auth.post("/api/auth/verify-email", async (c) => {
  const { token } = await body(c, z.object({ token: z.string().min(10) }));
  await rateLimitIp(c, "verify", 20, 10 * MIN);
  const row = await consumeToken(c, token, "email_verify");
  if (!row) throw bad("bad_token", "That link has expired or was already used. Sign in and ask for a new one.");
  const db = c.get("db");
  await db.update(schema.users).set({ emailVerifiedAt: c.get("now") }).where(eq(schema.users.id, row.userId));
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId));
  if (!user || user.status === "deleted") throw notFound();
  if (!c.get("user")) await startSession(c, user.id, { fresh: true });
  return c.json({ ok: true });
});

auth.post("/api/auth/resend-verification", async (c) => {
  const user = requireUser(c);
  if (!user.email || user.emailVerifiedAt) return c.json({ ok: true });
  await rateLimit(c, `resend:${user.id}`, 3, 60 * MIN);
  const link = await sendVerifyEmail(c, { id: user.id, email: user.email });
  return c.json({ ok: true, sample: await linkFor(c, link, user) });
});

auth.post("/api/auth/login", async (c) => {
  const input = await body(c, z.object({ email, password: z.string().min(1).max(200), turnstileToken: z.string().optional() }));
  await rateLimitIp(c, "login-ip", 20, 10 * MIN);
  await rateLimit(c, `login-acct:${await blindIndex(c.env, "email", input.email)}`, 8, 15 * MIN);
  await requireTurnstile(c, input.turnstileToken);
  const db = c.get("db");
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, input.email));
  // Always run a hash so a missing account takes as long as a wrong password.
  const check = await verifyPassword(input.password, user?.passwordHash ?? (await dummyHash(c)));
  if (!user || !check.ok || user.status === "deleted") throw forbidden("bad_credentials", BAD_LOGIN);
  if (shouldRehash(c.env, check, user.passwordHash)) await db.update(schema.users).set({ passwordHash: await hashPassword(c.env, input.password) }).where(eq(schema.users.id, user.id));
  if (!user.emailVerifiedAt) {
    const link = await sendVerifyEmail(c, { id: user.id, email: user.email! });
    throw forbidden("email_unverified", "Please confirm your email first. We have sent you a fresh link.", { sample: await linkFor(c, link, user) });
  }
  // Suspended and banned members may sign in, but only to read why and to appeal (spec 1: every action can be appealed).
  await startSession(c, user.id, { fresh: true });
  c.set("user", user);
  return c.json({ ok: true, ...(await mePayload(c, user)) });
});

let cachedDummy: string | null = null;
async function dummyHash(c: Context<AppEnv>) {
  cachedDummy ??= await hashPassword(c.env, randomToken(16));
  return cachedDummy;
}

auth.post("/api/auth/logout", async (c) => {
  await endSession(c);
  return c.json({ ok: true });
});

auth.post("/api/auth/reset/request", async (c) => {
  const input = await body(c, z.object({ email, turnstileToken: z.string().optional() }));
  await rateLimitIp(c, "reset", 5, 30 * MIN);
  await requireTurnstile(c, input.turnstileToken);
  const db = c.get("db");
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, input.email));
  let sample: Awaited<ReturnType<typeof linkFor>>;
  if (user && user.status !== "deleted") {
    const token = await issueToken(c, user.id, "reset", RESET_TOKEN_TTL_MS);
    const link = `${c.env.APP_ORIGIN}/reset/confirm?token=${token}`;
    await deliver(c.env, db, { channel: "email", to: input.email, template: "password_reset", subject: `Reset your ${c.env.APP_NAME} password`, body: `Use this link to set a new password:\n\n${link}\n\nIt works once and expires in 30 minutes. If you did not ask for this, ignore this email and your password stays the same.` }, c.get("now"));
    // Sample mode: shown only on a device this account has used before, so this cannot be used to take an account over.
    sample = await linkFor(c, link, user);
  }
  return c.json({ ...GENERIC_RESET, sample }); // identical whether or not the email exists, outside sample mode
});

auth.post("/api/auth/reset/confirm", async (c) => {
  const input = await body(c, z.object({ token: z.string().min(10), password }));
  await rateLimitIp(c, "reset-confirm", 10, 30 * MIN);
  const row = await consumeToken(c, input.token, "reset");
  if (!row) throw bad("bad_token", "That reset link has expired or was already used. Ask for a new one.");
  const db = c.get("db");
  // Following the emailed link also proves control of the address.
  await db.update(schema.users).set({ passwordHash: await hashPassword(c.env, input.password) }).where(eq(schema.users.id, row.userId));
  await db.update(schema.users).set({ emailVerifiedAt: c.get("now") }).where(and(eq(schema.users.id, row.userId), isNull(schema.users.emailVerifiedAt)));
  await revokeAllSessions(c, row.userId); // spec: all sessions revoked on reset
  await endSession(c);
  await audit(db, { id: row.userId, role: "member" }, "account.password_reset", "user", row.userId, {}, c.get("now"));
  return c.json({ ok: true });
});

/* ── Sign in with X: OAuth 2.0 authorization code + PKCE. No X password or long-lived token touches our storage. ── */

const X_COOKIE = "__Host-xoauth";

auth.get("/api/auth/x/start", async (c) => {
  if (!c.env.X_CLIENT_ID) return c.redirect("/login?error=x_unavailable");
  await rateLimitIp(c, "x-start", 20, 10 * MIN);
  const user = c.get("user");
  if (!user) await requireTurnstile(c, c.req.query("ts")); // linking from a signed-in session needs no bot check
  const state = randomToken(18);
  const verifier = randomToken(48);
  setCookie(c, X_COOKIE, await seal(c.env.APP_SECRET, "x-oauth", { state, verifier, link: user?.id ?? null }, 10 * MIN), { path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge: 600 });
  const url = new URL("https://x.com/i/oauth2/authorize");
  url.search = new URLSearchParams({
    response_type: "code", client_id: c.env.X_CLIENT_ID, redirect_uri: `${c.env.APP_ORIGIN}/api/auth/x/callback`, scope: "users.read tweet.read",
    state, code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256",
  }).toString();
  return c.redirect(url.toString());
});

auth.get("/api/auth/x/callback", async (c) => {
  const sealed = await unseal<{ state: string; verifier: string; link: string | null }>(c.env.APP_SECRET, "x-oauth", getCookie(c, X_COOKIE));
  setCookie(c, X_COOKIE, "", { path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge: 0 });
  const code = c.req.query("code");
  if (!sealed || !code || c.req.query("state") !== sealed.state) return c.redirect("/login?error=x_failed");
  const db = c.get("db");
  const now = c.get("now");

  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (c.env.X_CLIENT_SECRET) headers.authorization = `Basic ${btoa(`${c.env.X_CLIENT_ID}:${c.env.X_CLIENT_SECRET}`)}`;
  const tokenRes = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST", headers,
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: c.env.X_CLIENT_ID!, redirect_uri: `${c.env.APP_ORIGIN}/api/auth/x/callback`, code_verifier: sealed.verifier }),
  });
  if (!tokenRes.ok) return c.redirect("/login?error=x_failed");
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  const meRes = await fetch("https://api.x.com/2/users/me", { headers: { authorization: `Bearer ${access_token}` } });
  if (!meRes.ok) return c.redirect("/login?error=x_failed");
  const { data } = (await meRes.json()) as { data?: { id: string; username: string } };
  if (!data?.id) return c.redirect("/login?error=x_failed");
  // The access token is used for this one call and then dropped: it is never written anywhere.

  const [linked] = await db.select().from(schema.oauthAccounts).where(and(eq(schema.oauthAccounts.provider, "x"), eq(schema.oauthAccounts.providerUserId, data.id)));
  const current = c.get("user");

  if (sealed.link) {
    // Account linking: only for the same signed-in member who started the flow.
    if (!current || current.id !== sealed.link) return c.redirect("/login?error=x_failed");
    if (linked && linked.userId !== current.id) return c.redirect("/app/settings?error=x_in_use");
    if (!linked) await db.insert(schema.oauthAccounts).values({ id: newId("oa"), userId: current.id, provider: "x", providerUserId: data.id, handle: data.username, linkedAt: now });
    await audit(db, { id: current.id, role: "member" }, "account.x_linked", "user", current.id, {}, now);
    return c.redirect("/app/settings?linked=x");
  }

  if (linked) {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, linked.userId));
    if (!user || user.status === "deleted") return c.redirect("/login?error=x_failed");
    if (linked.handle !== data.username) await db.update(schema.oauthAccounts).set({ handle: data.username }).where(eq(schema.oauthAccounts.id, linked.id));
    await startSession(c, user.id, { fresh: true });
    return c.redirect("/app");
  }

  const xHash = await blindIndex(c.env, "x", data.id);
  if (banEvasionVerdict(await matchBanSignals(db, [{ kind: "x_account", hash: xHash }])) === "block") {
    await botEvent(c, "ban_evasion_block");
    return c.redirect("/login?error=x_failed");
  }
  const id = newId("usr");
  const dev = await deviceHash(c);
  await db.insert(schema.users).values({ id, email: null, deviceHash: dev, createdAt: now });
  await db.insert(schema.oauthAccounts).values({ id: newId("oa"), userId: id, provider: "x", providerUserId: data.id, handle: data.username, linkedAt: now });
  if (banEvasionVerdict(await matchBanSignals(db, [{ kind: "device", hash: dev }])) === "review") await enqueueModeration(db, { kind: "ban_evasion", refId: id, userId: id, scores: { signal: "device" }, slaMs: 3_600_000 }, now);
  await audit(db, { id, role: "member" }, "account.signup", "user", id, { via: "x" }, now);
  await startSession(c, id, { fresh: true });
  return c.redirect("/app"); // the app asks an X-only member for an email next
});

/* ── Current member ── */

auth.get("/api/me", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ user: null, config: publicConfig(c) });
  return c.json({ ...(await mePayload(c, user)), config: publicConfig(c) });
});

function publicConfig(c: Context<AppEnv>) {
  return { appName: c.env.APP_NAME, turnstileSiteKey: c.env.TURNSTILE_SITE_KEY, xEnabled: !!c.env.X_CLIENT_ID, vapidPublicKey: c.env.VAPID_PUBLIC_KEY || null, dev: c.env.ENVIRONMENT !== "production", sample: isSample(c.env) };
}

/** Email capture for X-only members, and email change for everyone else (re-auth required for a change). */
auth.post("/api/me/email", async (c) => {
  const user = requireUser(c);
  const input = await body(c, z.object({ email }));
  if (user.email) requireFreshAuth(c);
  await rateLimit(c, `email-change:${user.id}`, 5, 60 * MIN);
  const db = c.get("db");
  const emailHash = await blindIndex(c.env, "email", input.email);
  if (banEvasionVerdict(await matchBanSignals(db, [{ kind: "email", hash: emailHash }])) === "block") {
    await botEvent(c, "ban_evasion_block", user.id);
    throw forbidden("email_unavailable", "That email address cannot be used.");
  }
  const [taken] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, input.email));
  if (taken && taken.id !== user.id) throw bad("email_unavailable", "That email address cannot be used.");
  await db.update(schema.users).set({ email: input.email, emailHash, emailVerifiedAt: null }).where(eq(schema.users.id, user.id));
  const link = await sendVerifyEmail(c, { id: user.id, email: input.email });
  await audit(db, { id: user.id, role: "member" }, "account.email_changed", "user", user.id, {}, c.get("now"));
  return c.json({ ok: true, sample: await linkFor(c, link, user) });
});

auth.post("/api/me/password", async (c) => {
  const user = requireUser(c);
  const input = await body(c, z.object({ password }));
  if (user.passwordHash) requireFreshAuth(c);
  await c.get("db").update(schema.users).set({ passwordHash: await hashPassword(c.env, input.password) }).where(eq(schema.users.id, user.id));
  return c.json({ ok: true });
});

/** Re-auth with a password, or (for X-only members with no password) with a one-time emailed link. */
auth.post("/api/auth/reauth", async (c) => {
  const user = requireUser(c);
  const input = await body(c, z.object({ password: z.string().optional(), token: z.string().optional() }));
  await rateLimit(c, `reauth:${user.id}`, 8, 15 * MIN);
  const db = c.get("db");
  if (input.token) {
    const row = await consumeToken(c, input.token, "reauth");
    if (!row || row.userId !== user.id) throw bad("bad_token", "That confirmation link has expired or was already used.");
  } else if (user.passwordHash) {
    if (!(await verifyPassword(input.password ?? "", user.passwordHash)).ok) throw forbidden("bad_credentials", "That password is not right.");
  } else {
    if (!user.email) throw bad("no_email", "Add an email address first.");
    const token = await issueToken(c, user.id, "reauth", 15 * MIN);
    await deliver(c.env, db, { channel: "email", to: user.email, template: "reauth", subject: "Confirm it is you", body: `Use this link to confirm a sensitive change to your account:\n\n${c.env.APP_ORIGIN}/app/settings?reauth=${token}\n\nIt works once and expires in 15 minutes.` }, c.get("now"));
    return c.json({ ok: true, emailed: true });
  }
  await db.update(schema.sessions).set({ reauthAt: c.get("now") }).where(eq(schema.sessions.id, c.get("session")!.id));
  return c.json({ ok: true });
});

auth.get("/api/me/sessions", async (c) => {
  const user = requireUser(c);
  const rows = await c.get("db").select().from(schema.sessions).where(and(eq(schema.sessions.userId, user.id), isNull(schema.sessions.revokedAt)));
  // The session id is a hash of the cookie, so it is safe to hand back as a handle. Only a prefix is shown.
  return c.json({ sessions: rows.map((r) => ({ id: r.id.slice(0, 16), label: r.uaLabel, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, current: r.id === c.get("session")!.id })) });
});

auth.delete("/api/me/sessions/:id", async (c) => {
  const user = requireUser(c);
  const prefix = c.req.param("id");
  const rows = await c.get("db").select().from(schema.sessions).where(and(eq(schema.sessions.userId, user.id), isNull(schema.sessions.revokedAt)));
  const target = rows.find((r) => r.id.startsWith(prefix) && prefix.length >= 16);
  if (!target) throw notFound();
  await c.get("db").update(schema.sessions).set({ revokedAt: c.get("now") }).where(eq(schema.sessions.id, target.id));
  return c.json({ ok: true });
});

/** "Sign out everywhere" (spec 3). */
auth.delete("/api/me/sessions", async (c) => {
  const user = requireUser(c);
  await revokeAllSessions(c, user.id);
  await endSession(c);
  return c.json({ ok: true });
});

auth.get("/api/me/export", async (c) => {
  const user = requireUser(c);
  await rateLimit(c, `export:${user.id}`, 3, 60 * MIN);
  const data = await buildExport(c.env, c.get("db"), user, c.get("now"));
  await audit(c.get("db"), { id: user.id, role: "member" }, "account.export", "user", user.id, {}, c.get("now"));
  return new Response(JSON.stringify(data, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="my-data-${new Date(c.get("now")).toISOString().slice(0, 10)}.json"`, "cache-control": "no-store" } });
});

auth.delete("/api/me", async (c) => {
  const user = requireUser(c);
  requireFreshAuth(c); // spec: re-auth for delete
  await requestDeletion(c.env, c.get("db"), user.id, c.get("now"));
  // Close their sockets and drop their presence straight away.
  await c.env.USER_HUB.get(c.env.USER_HUB.idFromName(user.id)).closeAll("account_deleted");
  await endSession(c);
  return c.json({ ok: true });
});
