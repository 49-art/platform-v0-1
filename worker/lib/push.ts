/**
 * Web Push from a Worker using VAPID (RFC 8292). We send pushes with NO payload: the service worker shows a
 * generic "You have a new notification". That satisfies spec 6 ("Web Push ... with no message content") and
 * means there is nothing sensitive to encrypt or leak in transit.
 */
import { b64url } from "../../core";
import type { Env } from "../env";

export async function sendPush(env: Env, endpoint: string, now = Date.now()): Promise<"sent" | "gone" | "failed" | "disabled"> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK) return "disabled";
  try {
    const key = await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_PRIVATE_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const enc = new TextEncoder();
    const part = (o: unknown) => b64url.encode(enc.encode(JSON.stringify(o)));
    const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: `${env.APP_ORIGIN}/contact` })}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned)));
    const res = await fetch(endpoint, { method: "POST", headers: { authorization: `vapid t=${unsigned}.${b64url.encode(sig)}, k=${env.VAPID_PUBLIC_KEY}`, ttl: "86400", urgency: "normal", "content-length": "0" } });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
