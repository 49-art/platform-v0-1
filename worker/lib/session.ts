import {
  OWASP_ARGON2ID, REAUTH_WINDOW_MS, SESSION_TTL_MS, expireStanding, hashPassword as coreHash, hashPasswordPbkdf2, hmacHex, makeDb, randomToken, schema,
  sha256Hex, timingSafeEqual,
} from "../../core";
import { and, eq, isNull } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Env } from "../env";
import { forbidden } from "./http";

export const SID = "__Host-sid";
export const DID = "__Host-did";
export const CSRF = "__Host-csrf";

const base = { path: "/", secure: true, sameSite: "Lax" as const };

export function hashPassword(env: Env, password: string) {
  // Workers Free cannot afford Argon2id (D-016): PASSWORD_ALGO=pbkdf2 selects the native WebCrypto fallback the spec allows.
  if (env.PASSWORD_ALGO === "pbkdf2") return hashPasswordPbkdf2(password);
  // Fast parameters are for the automated tests only and are refused outside the test environment.
  const fast = env.TEST_FAST_HASH === "1" && env.ENVIRONMENT === "test";
  return coreHash(password, fast ? { m: 64, t: 1, p: 1 } : OWASP_ARGON2ID);
}

/** A stored hash is upgraded on sign-in only when the configured algorithm is stronger than the stored one. */
export const shouldRehash = (env: Env, check: { ok: boolean; needsRehash: boolean }, stored: string | null | undefined) =>
  check.ok && check.needsRehash && !(env.PASSWORD_ALGO === "pbkdf2" && stored?.startsWith("pbkdf2$"));

function uaLabel(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "device";
  return `${browser} on ${os}`;
}

/** Long-lived first-party device id. Strictly for security: ban-evasion and session listing, never advertising. */
export function deviceId(c: Context<AppEnv>): string {
  let did = getCookie(c, DID);
  if (!did || did.length < 20) {
    did = randomToken(18);
    setCookie(c, DID, did, { ...base, httpOnly: true, maxAge: 60 * 60 * 24 * 400 });
  }
  return did;
}
export const deviceHash = async (c: Context<AppEnv>) => hmacHex(c.env.APP_SECRET, "blind/device", deviceId(c));

export async function startSession(c: Context<AppEnv>, userId: string, opts: { fresh?: boolean } = {}) {
  const token = randomToken(32);
  const now = c.get("now");
  const ua = c.req.header("user-agent") ?? "";
  await c.get("db").insert(schema.sessions).values({
    id: await sha256Hex(token), userId, createdAt: now, lastSeenAt: now, reauthAt: opts.fresh ? now : null,
    ipHash: await hmacHex(c.env.APP_SECRET, "ip", c.get("ip")), uaHash: await sha256Hex(ua), uaLabel: uaLabel(ua),
  });
  setCookie(c, SID, token, { ...base, httpOnly: true, maxAge: SESSION_TTL_MS / 1000 });
  // Double-submit CSRF token: readable by our own script, useless to another origin.
  setCookie(c, CSRF, randomToken(18), { ...base, httpOnly: false, maxAge: SESSION_TTL_MS / 1000 });
  await c.get("db").update(schema.users).set({ deviceHash: await deviceHash(c) }).where(eq(schema.users.id, userId));
}

export async function endSession(c: Context<AppEnv>) {
  const session = c.get("session");
  if (session) await c.get("db").update(schema.sessions).set({ revokedAt: c.get("now") }).where(eq(schema.sessions.id, session.id));
  setCookie(c, SID, "", { ...base, httpOnly: true, maxAge: 0 });
  setCookie(c, CSRF, "", { ...base, httpOnly: false, maxAge: 0 });
}

export async function revokeAllSessions(c: Context<AppEnv>, userId: string) {
  await c.get("db").update(schema.sessions).set({ revokedAt: c.get("now") }).where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
}

/** Spec 3 "Sessions": re-auth for sensitive actions (delete, phone swap, email change). */
export function requireFreshAuth(c: Context<AppEnv>) {
  const s = c.get("session");
  if (!s?.reauthAt || c.get("now") - s.reauthAt > REAUTH_WINDOW_MS) throw forbidden("reauth_required", "Please confirm your password to continue.");
}

/** Resolves the session cookie into `user` / `session` on the context. */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const now = Date.now();
  const db = makeDb(c.env.DB);
  c.set("db", db);
  c.set("now", now);
  c.set("ip", c.req.header("cf-connecting-ip") ?? "0.0.0.0");
  c.set("user", null);
  c.set("session", null);
  const token = getCookie(c, SID);
  if (token) {
    const [row] = await db.select().from(schema.sessions).innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId)).where(eq(schema.sessions.id, await sha256Hex(token)));
    const live = row && !row.sessions.revokedAt && now - row.sessions.createdAt < SESSION_TTL_MS && row.users.status !== "deleted" && !row.users.deletedAt;
    if (row && live) {
      await expireStanding(db, row.users, now);
      c.set("user", row.users);
      c.set("session", row.sessions);
      if (now - row.sessions.lastSeenAt > 5 * 60_000) await db.update(schema.sessions).set({ lastSeenAt: now }).where(eq(schema.sessions.id, row.sessions.id));
    }
  }
  await next();
};

/**
 * CSRF for every state-changing API route (spec 5). Two independent checks:
 *  1. Origin must be our own origin (blocks cross-site form posts outright).
 *  2. With a session, the x-csrf-token header must equal the CSRF cookie (double submit).
 * Provider webhooks are exempt: they are authenticated by signature instead.
 */
export const csrfMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS" || path.startsWith("/api/webhooks/") || path.startsWith("/internal/")) return next();
  const origin = c.req.header("origin");
  if (!origin || origin !== c.env.APP_ORIGIN) throw forbidden("bad_origin", "This request did not come from the app.");
  if (c.get("session")) {
    const header = c.req.header("x-csrf-token") ?? "";
    const cookie = getCookie(c, CSRF) ?? "";
    if (!cookie || !timingSafeEqual(header, cookie)) throw forbidden("bad_csrf", "Your session token is missing or out of date. Refresh the page and try again.");
  }
  return next();
};
