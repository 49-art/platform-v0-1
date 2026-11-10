/**
 * Every outside service sits behind an adapter (spec 12). The open decisions on vendors
 * (ID + liveness provider, SMS) do not block the build: the real adapter is added beside
 * the development double and selected by configuration.
 *
 * SAFETY: development doubles refuse to run when ENVIRONMENT is "production". A missing
 * provider must fail closed, never silently pass people through an age or identity check.
 */
import { hmacHex, newId, verifyHmac } from "./crypto";

export interface ProviderEnv {
  ENVIRONMENT: string; // development | test | staging | production
  APP_ORIGIN: string;
  APP_SECRET: string;
  TURNSTILE_SECRET?: string;
  EMAIL_TRANSPORT?: string; // log | resend
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  SMS_TRANSPORT?: string; // log (no vendor chosen yet — open decision)
  AGE_PROVIDER?: string; // mock (no vendor chosen yet — open decision)
  IDV_PROVIDER?: string; // mock
  PROVIDER_WEBHOOK_SECRET?: string;
  SCAN_PROVIDER?: string; // mock | sightengine
  SIGHTENGINE_USER?: string;
  SIGHTENGINE_SECRET?: string;
}

export const isProduction = (env: { ENVIRONMENT: string }) => env.ENVIRONMENT === "production";

export class ProviderConfigError extends Error {}

/* ── Turnstile (spec 3: bot gate; failed challenge blocks the request server-side) ── */

export async function verifyTurnstile(env: ProviderEnv, token: string | undefined | null, ip?: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) {
    if (isProduction(env)) throw new ProviderConfigError("TURNSTILE_SECRET is not set");
    return false;
  }
  if (!token) return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false; // fail closed
  }
}

/* ── Email / SMS ── */

export interface OutboundMessage {
  channel: "email" | "sms";
  to: string;
  template: string;
  subject: string;
  body: string;
}
export interface SendResult {
  transport: string;
  status: "sent" | "failed" | "logged";
  error?: string;
}

export async function sendMessage(env: ProviderEnv, msg: OutboundMessage): Promise<SendResult> {
  const transport = (msg.channel === "email" ? env.EMAIL_TRANSPORT : env.SMS_TRANSPORT) ?? "log";
  if (transport === "log") {
    if (isProduction(env)) return { transport, status: "failed", error: `No ${msg.channel} transport configured` };
    return { transport, status: "logged" };
  }
  if (msg.channel === "email" && transport === "resend") {
    if (!env.RESEND_API_KEY || !env.MAIL_FROM) return { transport, status: "failed", error: "RESEND_API_KEY / MAIL_FROM not set" };
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.body }),
      });
      return res.ok ? { transport, status: "sent" } : { transport, status: "failed", error: `Resend HTTP ${res.status}` };
    } catch (e) {
      return { transport, status: "failed", error: String(e) };
    }
  }
  return { transport, status: "failed", error: `Unknown transport "${transport}"` };
}

/* ── Age assurance and ID + liveness (spec 7) ── */

export type CheckKind = "age" | "idv";

export interface HostedCheck {
  provider: string;
  providerRef: string;
  /** Where the member is sent to complete the check with the provider. */
  url: string;
}

/**
 * What a provider webhook is reduced to before it touches our database.
 * Result only: no document images, no date of birth, no document numbers.
 */
export interface CheckOutcome {
  provider: string;
  providerRef: string;
  status: "passed" | "failed" | "review";
  method?: string;
  /** IDV only: the selfie matches the profile photos we supplied for comparison. */
  faceMatch?: boolean;
  /** IDV only: provider's stable token for "this person", used to spot a banned person returning. */
  duplicateToken?: string;
}

export interface CheckProvider {
  name: string;
  start(kind: CheckKind, userId: string): Promise<HostedCheck>;
  /** Verify the webhook signature and normalise the payload. Returns null if it is not authentic. */
  parseWebhook(kind: CheckKind, rawBody: string, headers: Headers): Promise<CheckOutcome | null>;
}

/** Development double. Sends the member to an in-app page that plays the provider's part. */
function mockCheckProvider(env: ProviderEnv): CheckProvider {
  const secret = env.PROVIDER_WEBHOOK_SECRET ?? env.APP_SECRET;
  return {
    name: "mock",
    async start(kind, _userId) {
      const providerRef = newId(kind === "age" ? "mockage" : "mockidv");
      return { provider: "mock", providerRef, url: `${env.APP_ORIGIN}/dev/provider?kind=${kind}&ref=${providerRef}` };
    },
    async parseWebhook(_kind, rawBody, headers) {
      const sig = headers.get("x-provider-signature") ?? "";
      const t = headers.get("x-provider-timestamp") ?? "";
      if (!t || Math.abs(Date.now() - Number(t)) > 5 * 60_000) return null; // replay window
      if (!(await verifyHmac(secret, "provider-webhook", `${t}.${rawBody}`, sig))) return null;
      const p = JSON.parse(rawBody) as Partial<CheckOutcome>;
      if (!p.providerRef || !p.status) return null;
      return { provider: "mock", providerRef: p.providerRef, status: p.status, method: p.method, faceMatch: p.faceMatch, duplicateToken: p.duplicateToken };
    },
  };
}

export async function signMockWebhook(env: ProviderEnv, rawBody: string, now = Date.now()): Promise<Record<string, string>> {
  const secret = env.PROVIDER_WEBHOOK_SECRET ?? env.APP_SECRET;
  return { "x-provider-timestamp": String(now), "x-provider-signature": await hmacHex(secret, "provider-webhook", `${now}.${rawBody}`) };
}

export function checkProvider(env: ProviderEnv, kind: CheckKind): CheckProvider {
  const name = (kind === "age" ? env.AGE_PROVIDER : env.IDV_PROVIDER) ?? "";
  if (name === "mock") {
    if (isProduction(env)) throw new ProviderConfigError(`The mock ${kind} provider cannot be used in production`);
    return mockCheckProvider(env);
  }
  // A real adapter (Yoti / Persona / Onfido / Veriff — open decision) is registered here once chosen.
  throw new ProviderConfigError(`No ${kind} provider is configured`);
}

/* ── Image scanning (spec 8: auto-scores nudity, faces, hash match) ── */

export interface ScanScores {
  nudity: number; // 0..1
  minor: number; // 0..1 likelihood a depicted person is under 18
  weapon: number;
  drugs: number;
  faces: number; // count
  /** Known illegal image hash match. Triggers the CSAM path: quarantine, freeze, escalate. */
  hashMatch: boolean;
  provider: string;
}

export interface ImageScanner {
  name: string;
  scan(bytes: ArrayBuffer, contentType: string): Promise<ScanScores>;
}

const ascii = (bytes: ArrayBuffer) => new TextDecoder("latin1").decode(bytes.slice(0, 4096));

/** Development double: reads marker strings embedded in the file so every branch can be exercised in tests. */
const mockScanner: ImageScanner = {
  name: "mock",
  async scan(bytes) {
    const head = ascii(bytes);
    return {
      nudity: head.includes("MOCK_NUDITY") ? 0.97 : head.includes("MOCK_SUGGESTIVE") ? 0.45 : 0.01,
      minor: head.includes("MOCK_MINOR") ? 0.9 : 0.0,
      weapon: head.includes("MOCK_WEAPON") ? 0.9 : 0.0,
      drugs: head.includes("MOCK_DRUGS") ? 0.9 : 0.0,
      faces: head.includes("MOCK_NOFACE") ? 0 : 1,
      hashMatch: head.includes("MOCK_HASH_MATCH"),
      provider: "mock",
    };
  },
};

/**
 * Sightengine adapter, written against their public REST documentation.
 * NOT yet exercised against a live account (no credentials) — tracked in docs/OPEN-ITEMS.md.
 * Hash matching is not a Sightengine feature; `hashMatch` comes from the hash service (see below).
 */
function sightengineScanner(env: ProviderEnv): ImageScanner {
  return {
    name: "sightengine",
    async scan(bytes, contentType) {
      const form = new FormData();
      form.set("media", new Blob([bytes], { type: contentType }), "upload");
      form.set("models", "nudity-2.1,weapon,recreational_drug,face-attributes");
      form.set("api_user", env.SIGHTENGINE_USER ?? "");
      form.set("api_secret", env.SIGHTENGINE_SECRET ?? "");
      const res = await fetch("https://api.sightengine.com/1.0/check.json", { method: "POST", body: form });
      if (!res.ok) throw new Error(`Sightengine HTTP ${res.status}`);
      const d = (await res.json()) as any;
      const n = d?.nudity ?? {};
      const faces: any[] = Array.isArray(d?.faces) ? d.faces : [];
      const num = (v: unknown) => (typeof v === "number" ? v : 0);
      return {
        nudity: Math.max(num(n.sexual_activity), num(n.sexual_display), num(n.erotica), num(n.very_suggestive) * 0.6),
        minor: faces.reduce((m, f) => Math.max(m, num(f?.attributes?.minor)), 0),
        weapon: Math.max(num(d?.weapon?.classes?.firearm), num(d?.weapon?.classes?.knife), num(d?.weapon)),
        drugs: Math.max(num(d?.recreational_drug?.prob), num(d?.drugs)),
        faces: faces.length,
        hashMatch: false,
        provider: "sightengine",
      };
    },
  };
}

export function imageScanner(env: ProviderEnv): ImageScanner {
  const name = env.SCAN_PROVIDER ?? "";
  if (name === "sightengine") {
    if (!env.SIGHTENGINE_USER || !env.SIGHTENGINE_SECRET) throw new ProviderConfigError("Sightengine credentials are not set");
    return sightengineScanner(env);
  }
  if (name === "mock") {
    if (isProduction(env)) throw new ProviderConfigError("The mock image scanner cannot be used in production");
    return mockScanner;
  }
  throw new ProviderConfigError("No image scanner is configured");
}
