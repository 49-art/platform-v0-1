import { hmacHex, newId, schema, verifyTurnstile } from "../../core";
import type { Context } from "hono";
import type { AppEnv, Env } from "../env";
import { forbidden, tooMany } from "./http";

export const ipHash = (env: Env, ip: string) => hmacHex(env.APP_SECRET, "ip", ip);

export async function botEvent(c: Context<AppEnv>, kind: string, userId?: string) {
  await c.get("db").insert(schema.botEvents).values({ id: newId("bot"), kind, ipHash: await ipHash(c.env, c.get("ip")), userId: userId ?? null, route: new URL(c.req.url).pathname, createdAt: c.get("now") });
}

/** Throws 429 when the key is over its limit. `key` should already include the route family. */
export async function rateLimit(c: Context<AppEnv>, key: string, limit: number, windowMs: number) {
  const stub = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(key));
  const result = await stub.hit(limit, windowMs, c.get("now"));
  if (!result.allowed) {
    await botEvent(c, "rate_limit", c.get("user")?.id);
    throw tooMany(result.retryAfterS);
  }
}

export async function rateLimitIp(c: Context<AppEnv>, family: string, limit: number, windowMs: number) {
  return rateLimit(c, `${family}:${await ipHash(c.env, c.get("ip"))}`, limit, windowMs);
}

/** Spec 3 "Bot gate": a failed challenge blocks the request server-side. */
export async function requireTurnstile(c: Context<AppEnv>, token: string | undefined | null) {
  const ok = await verifyTurnstile(c.env, token, c.get("ip"));
  if (!ok) {
    await botEvent(c, "turnstile_fail");
    throw forbidden("bot_check_failed", "We could not confirm you are a real person. Please try the check again.");
  }
}
