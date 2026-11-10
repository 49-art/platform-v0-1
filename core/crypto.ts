/**
 * Cryptographic helpers. WebCrypto only, so they run unchanged on Workers and in Node tests.
 *
 * One master secret (APP_SECRET) is expanded into purpose-bound subkeys, so a
 * signed media URL can never be replayed as, say, a webhook signature.
 */
import { argon2idAsync } from "@noble/hashes/argon2.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64url = {
  encode(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(text: string): Uint8Array {
    const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  return b64url.encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function newId(prefix: string): string {
  return `${prefix}_${hex(crypto.getRandomValues(new Uint8Array(12)))}`;
}

export async function sha256Hex(input: string | Uint8Array | ArrayBuffer): Promise<string> {
  const data = typeof input === "string" ? enc.encode(input) : input;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)));
}

async function hmacKey(secret: string, purpose: string): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sub = await crypto.subtle.sign("HMAC", master, enc.encode(`platform/v1/${purpose}`));
  return crypto.subtle.importKey("raw", sub, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Keyed digest. Used for blind indexes (email / phone / device hashes) and signatures. */
export async function hmacHex(secret: string, purpose: string, message: string): Promise<string> {
  const key = await hmacKey(secret, purpose);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message))));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ (y[i % (y.length || 1)] ?? 0);
  return diff === 0;
}

export async function verifyHmac(secret: string, purpose: string, message: string, signature: string): Promise<boolean> {
  return timingSafeEqual(await hmacHex(secret, purpose, message), signature);
}

/* ── Field encryption (columns ending in _enc) ── */

async function aesKey(secret: string): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const raw = await crypto.subtle.sign("HMAC", master, enc.encode("platform/v1/field-encryption"));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM. `context` is bound as additional data so a ciphertext cannot be moved between rows or columns. */
export async function encryptField(secret: string, plaintext: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(context) }, await aesKey(secret), enc.encode(plaintext));
  return `v1.${b64url.encode(iv)}.${b64url.encode(new Uint8Array(ct))}`;
}

export async function decryptField(secret: string, ciphertext: string, context: string): Promise<string> {
  const [version, iv, ct] = ciphertext.split(".");
  if (version !== "v1" || !iv || !ct) throw new Error("Unknown ciphertext format");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64url.decode(iv) as BufferSource, additionalData: enc.encode(context) },
    await aesKey(secret),
    b64url.decode(ct) as BufferSource,
  );
  return dec.decode(pt);
}

export async function encryptJson(secret: string, value: unknown, context: string): Promise<string> {
  return encryptField(secret, JSON.stringify(value), context);
}

export async function decryptJson<T>(secret: string, ciphertext: string | null | undefined, context: string): Promise<T | null> {
  if (!ciphertext) return null;
  try {
    return JSON.parse(await decryptField(secret, ciphertext, context)) as T;
  } catch {
    return null;
  }
}

/* ── Password hashing ──
 * Spec: Argon2id, or PBKDF2-SHA256 at the OWASP count "if Workers CPU limits bite — benchmark".
 * workerd caps WebCrypto PBKDF2 at 100,000 iterations, below OWASP's 600,000, so PBKDF2 is not
 * a compliant fallback on this runtime. We use Argon2id at the OWASP minimum (m=19 MiB, t=2, p=1)
 * with an audited pure-JS implementation; see docs/DECISIONS.md D-007 for the benchmark.
 * The parameters are stored in every hash so they can be raised later and re-hashed on login.
 */
export interface PasswordParams {
  m: number; // KiB
  t: number;
  p: number;
}
export const OWASP_ARGON2ID: PasswordParams = { m: 19456, t: 2, p: 1 };

export async function hashPassword(password: string, params: PasswordParams = OWASP_ARGON2ID): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const out = await argon2idAsync(enc.encode(password.normalize("NFKC")), salt, { ...params, dkLen: 32 });
  return `argon2id$m=${params.m},t=${params.t},p=${params.p}$${b64url.encode(salt)}$${b64url.encode(out)}`;
}

/**
 * Free-plan fallback (decision D-016). Workers Free allows 10 ms of CPU per request and the Argon2id hash above
 * measures ~350 ms, so a free-plan deployment cannot sign anyone in with it. PBKDF2-SHA256 runs natively in WebCrypto
 * at the 100,000-iteration ceiling workerd imposes. Below OWASP's 600,000 for this algorithm, so it is the
 * sample/free-plan setting only; the Workers Paid plan switches back to Argon2id and re-hashes on next sign-in.
 */
export const PBKDF2_ITERATIONS = 100_000;

export async function hashPasswordPbkdf2(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const out = await pbkdf2(password, salt, iterations);
  return `pbkdf2$i=${iterations}$${b64url.encode(salt)}$${b64url.encode(out)}`;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256));
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<{ ok: boolean; needsRehash: boolean }> {
  const fail = { ok: false, needsRehash: false };
  if (!stored) return fail;
  const [algo, paramText, saltText, hashText] = stored.split("$");
  if (algo === "pbkdf2" && paramText && saltText && hashText) {
    const iterations = Number(paramText.replace("i=", ""));
    if (!iterations) return fail;
    const out = await pbkdf2(password, b64url.decode(saltText), iterations);
    // A PBKDF2 hash is always "weaker" than the Argon2id target: it is re-hashed whenever the runtime can afford Argon2id.
    return { ok: timingSafeEqual(b64url.encode(out), hashText), needsRehash: true };
  }
  if (algo !== "argon2id" || !paramText || !saltText || !hashText) return fail;
  const params = Object.fromEntries(paramText.split(",").map((kv) => kv.split("="))) as Record<string, string>;
  const p: PasswordParams = { m: Number(params.m), t: Number(params.t), p: Number(params.p) };
  if (!p.m || !p.t || !p.p) return fail;
  const out = await argon2idAsync(enc.encode(password.normalize("NFKC")), b64url.decode(saltText), { ...p, dkLen: 32 });
  const ok = timingSafeEqual(b64url.encode(out), hashText);
  const weaker = p.m < OWASP_ARGON2ID.m || p.t < OWASP_ARGON2ID.t;
  return { ok, needsRehash: ok && weaker };
}

/* ── Signed, expiring URLs for private media ── */

export async function signMediaPath(secret: string, key: string, viewerId: string, expiresAt: number): Promise<string> {
  const sig = await hmacHex(secret, "media-url", `${key}|${viewerId}|${expiresAt}`);
  return `/media/${encodeURIComponent(key)}?u=${encodeURIComponent(viewerId)}&e=${expiresAt}&s=${sig}`;
}

export async function verifyMediaSignature(secret: string, key: string, viewerId: string, expiresAt: number, sig: string, now: number): Promise<boolean> {
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
  return verifyHmac(secret, "media-url", `${key}|${viewerId}|${expiresAt}`, sig);
}

/* ── Short-lived sealed values (OAuth state + PKCE verifier, upload tickets) ── */

export async function seal(secret: string, purpose: string, value: unknown, ttlMs: number, now = Date.now()): Promise<string> {
  const body = b64url.encode(enc.encode(JSON.stringify({ v: value, e: now + ttlMs })));
  return `${body}.${await hmacHex(secret, `seal/${purpose}`, body)}`;
}

export async function unseal<T>(secret: string, purpose: string, sealed: string | undefined | null, now = Date.now()): Promise<T | null> {
  if (!sealed) return null;
  const [body, sig] = sealed.split(".");
  if (!body || !sig || !(await verifyHmac(secret, `seal/${purpose}`, body, sig))) return null;
  try {
    const parsed = JSON.parse(dec.decode(b64url.decode(body))) as { v: T; e: number };
    return parsed.e >= now ? parsed.v : null;
  } catch {
    return null;
  }
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}
