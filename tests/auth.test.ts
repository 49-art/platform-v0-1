/**
 * Spec section 3 "Auth and account" — one group per row of that table.
 * Build plan P1-1: "E2E tests pass; tokens single-use and expire".
 */
import { applyEnforcement, eraseDueAccounts, schema } from "../core";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, PASSWORD, SENIOR, approvedMember, db, freshEmail, lastEmail, signUp, tokenFrom } from "./helpers";

afterEach(() => vi.useRealTimers());

const signupBody = (email: string, extra: Record<string, unknown> = {}) => ({ email, password: PASSWORD, turnstileToken: "human", over18: true, acceptTerms: true, ...extra });

describe("Email + password", () => {
  it("does not sign the member in until the one-time email link is followed", async () => {
    const c = new Client();
    const email = freshEmail();
    const res = await c.post("/api/auth/signup", signupBody(email));
    expect(res.status).toBe(200);
    expect((await c.get("/api/me")).data.user).toBeNull();
    // Signing in before verifying is refused and a fresh link is sent.
    const early = await c.post("/api/auth/login", { email, password: PASSWORD, turnstileToken: "human" });
    expect(early.status).toBe(403);
    expect(early.data.error.code).toBe("email_unverified");
    const token = tokenFrom((await lastEmail(email, "verify_email"))!.body);
    expect((await c.post("/api/auth/verify-email", { token })).status).toBe(200);
    const me = await c.get("/api/me");
    expect(me.data.user.email).toBe(email);
    expect(me.data.flags.emailVerified).toBe(true);
    expect(me.data.step).toBe("age");
  });

  it("stores an Argon2id hash, never the password", async () => {
    const { client } = await signUp();
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, client.userId));
    expect(u!.passwordHash).toMatch(/^argon2id\$m=\d+,t=\d+,p=\d+\$/);
    expect(u!.passwordHash).not.toContain(PASSWORD);
  });

  it("gives the same response whether or not the address is already registered", async () => {
    const { email } = await signUp();
    const c = new Client();
    const again = await c.post("/api/auth/signup", signupBody(email));
    const fresh = await new Client().post("/api/auth/signup", signupBody(freshEmail()));
    expect(again.status).toBe(200);
    expect(again.data).toEqual(fresh.data);
    expect((await lastEmail(email, "signup_existing"))).not.toBeNull();
  });

  it("makes the verification link single-use", async () => {
    const c = new Client();
    const email = freshEmail();
    await c.post("/api/auth/signup", signupBody(email));
    const token = tokenFrom((await lastEmail(email, "verify_email"))!.body);
    expect((await c.post("/api/auth/verify-email", { token })).status).toBe(200);
    const second = await new Client().post("/api/auth/verify-email", { token });
    expect(second.status).toBe(400);
    expect(second.data.error.code).toBe("bad_token");
  });

  it("rejects weak passwords and a missing 18+ confirmation", async () => {
    const c = new Client();
    expect((await c.post("/api/auth/signup", signupBody(freshEmail(), { password: "short" }))).status).toBe(400);
    expect((await c.post("/api/auth/signup", signupBody(freshEmail(), { over18: false }))).status).toBe(400);
  });

  it("refuses a wrong password with a message that does not say which part was wrong", async () => {
    const { email } = await signUp();
    const wrong = await new Client().post("/api/auth/login", { email, password: "not the password", turnstileToken: "human" });
    const unknown = await new Client().post("/api/auth/login", { email: freshEmail(), password: PASSWORD, turnstileToken: "human" });
    expect(wrong.status).toBe(403);
    expect(wrong.data.error).toEqual(unknown.data.error);
  });
});

describe("Bot gate (Turnstile)", () => {
  it.each([
    ["/api/auth/signup", () => signupBody(freshEmail(), { turnstileToken: "robot" })],
    ["/api/auth/login", () => ({ email: freshEmail(), password: PASSWORD, turnstileToken: "robot" })],
    ["/api/auth/reset/request", () => ({ email: freshEmail(), turnstileToken: "robot" })],
    ["/api/contact", () => ({ name: "A", email: freshEmail(), topic: "general", message: "Hello there, this is a message.", turnstileToken: "robot" })],
  ])("blocks %s server-side when the challenge fails", async (path, make) => {
    const res = await new Client().post(path, make());
    expect(res.status).toBe(403);
    expect(res.data.error.code).toBe("bot_check_failed");
  });

  it("blocks a request with no token at all and records the block", async () => {
    const res = await new Client().post("/api/auth/signup", signupBody(freshEmail(), { turnstileToken: undefined }));
    expect(res.status).toBe(403);
    const events = await db().select().from(schema.botEvents).where(eq(schema.botEvents.kind, "turnstile_fail"));
    expect(events.length).toBeGreaterThan(0);
  });

  it("rate-limits repeated sign-ups from one address", async () => {
    const c = new Client();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await c.post("/api/auth/signup", signupBody(freshEmail()))).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses).toContain(429);
  });
});

describe("Password reset", () => {
  it("answers identically for known and unknown addresses", async () => {
    const { email } = await signUp();
    const known = await new Client().post("/api/auth/reset/request", { email, turnstileToken: "human" });
    const unknown = await new Client().post("/api/auth/reset/request", { email: freshEmail(), turnstileToken: "human" });
    expect(known.status).toBe(200);
    expect(known.data).toEqual(unknown.data);
  });

  it("uses a single-use token and revokes every session", async () => {
    const { client, email } = await signUp();
    const other = new Client();
    await other.post("/api/auth/login", { email, password: PASSWORD, turnstileToken: "human" });
    expect((await other.get("/api/me")).data.user).not.toBeNull();

    await new Client().post("/api/auth/reset/request", { email, turnstileToken: "human" });
    const token = tokenFrom((await lastEmail(email, "password_reset"))!.body);
    const fresh = new Client();
    expect((await fresh.post("/api/auth/reset/confirm", { token, password: "a brand new passphrase" })).status).toBe(200);

    expect((await client.get("/api/me")).data.user).toBeNull();
    expect((await other.get("/api/me")).data.user).toBeNull();
    expect((await fresh.post("/api/auth/reset/confirm", { token, password: "another new passphrase" })).data.error.code).toBe("bad_token");
    expect((await new Client().post("/api/auth/login", { email, password: PASSWORD, turnstileToken: "human" })).status).toBe(403);
    expect((await new Client().post("/api/auth/login", { email, password: "a brand new passphrase", turnstileToken: "human" })).status).toBe(200);
  });

  it("expires the token after 30 minutes", async () => {
    const { email } = await signUp();
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    await new Client().post("/api/auth/reset/request", { email, turnstileToken: "human" });
    const token = tokenFrom((await lastEmail(email, "password_reset"))!.body);
    vi.setSystemTime(t0 + 31 * 60_000);
    const res = await new Client().post("/api/auth/reset/confirm", { token, password: "a brand new passphrase" });
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe("bad_token");
  });
});

describe("Sessions", () => {
  it("sets an HttpOnly, Secure, SameSite=Lax session cookie", async () => {
    const { email } = await signUp();
    const res = await new Client().raw("POST", "/api/auth/login", { json: { email, password: PASSWORD, turnstileToken: "human" } });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-sid="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
  });

  it("never stores the raw session token", async () => {
    const { client } = await signUp();
    const raw = client.cookies.get("__Host-sid")!;
    const rows = await db().select().from(schema.sessions).where(eq(schema.sessions.userId, client.userId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).not.toBe(raw);
    expect(JSON.stringify(rows)).not.toContain(raw);
  });

  it("lists sessions, revokes one, and signs out everywhere", async () => {
    const { client, email } = await signUp();
    const phone = new Client();
    await phone.post("/api/auth/login", { email, password: PASSWORD, turnstileToken: "human" });
    const list = (await client.get("/api/me/sessions")).data.sessions;
    expect(list.length).toBe(2);
    expect(list.filter((s: any) => s.current).length).toBe(1);
    const otherId = list.find((s: any) => !s.current).id;
    expect((await client.del(`/api/me/sessions/${otherId}`)).status).toBe(200);
    expect((await phone.get("/api/me")).data.user).toBeNull();

    const laptop = new Client();
    await laptop.post("/api/auth/login", { email, password: PASSWORD, turnstileToken: "human" });
    expect((await client.del("/api/me/sessions")).status).toBe(200);
    expect((await client.get("/api/me")).data.user).toBeNull();
    expect((await laptop.get("/api/me")).data.user).toBeNull();
  });

  it("logs out", async () => {
    const { client } = await signUp();
    await client.post("/api/auth/logout");
    expect((await client.get("/api/me")).data.user).toBeNull();
  });
});

describe("CSRF protection on state-changing routes", () => {
  it("rejects a cross-site origin", async () => {
    const { client } = await signUp();
    client.origin = "https://evil.example";
    const res = await client.post("/api/auth/logout");
    expect(res.status).toBe(403);
    expect(res.data.error.code).toBe("bad_origin");
  });

  it("rejects a missing origin", async () => {
    const c = new Client();
    c.origin = null;
    expect((await c.post("/api/auth/signup", signupBody(freshEmail()))).data.error.code).toBe("bad_origin");
  });

  it("rejects a session request without the CSRF header", async () => {
    const { client } = await signUp();
    client.sendCsrf = false;
    const res = await client.post("/api/consents", { kind: "marketing", granted: true });
    expect(res.status).toBe(403);
    expect(res.data.error.code).toBe("bad_csrf");
  });
});

describe("Re-auth for sensitive actions", () => {
  it("requires a recent password confirmation to delete the account", async () => {
    const { client } = await signUp();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000); // the sign-in is no longer "fresh"
    const refused = await client.del("/api/me");
    expect(refused.status).toBe(403);
    expect(refused.data.error.code).toBe("reauth_required");
    expect((await client.post("/api/auth/reauth", { password: "wrong password" })).status).toBe(403);
    expect((await client.post("/api/auth/reauth", { password: PASSWORD })).status).toBe(200);
    expect((await client.del("/api/me")).status).toBe(200);
  });

  it("requires re-auth before saving a phone number for swaps", async () => {
    const { client } = await approvedMember("Phone");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await client.put("/api/me/phone", { phone: "+447700900123" })).data.error.code).toBe("reauth_required");
    await client.post("/api/auth/reauth", { password: PASSWORD });
    expect((await client.put("/api/me/phone", { phone: "+447700900123" })).status).toBe(200);
    const [row] = await db().select().from(schema.userContacts).where(eq(schema.userContacts.userId, client.userId));
    expect(row!.phoneEnc).toMatch(/^v1\./);
    expect(row!.phoneEnc).not.toContain("7700900123");
  });
});

describe("Account deletion", () => {
  it("hides the profile at once, ends the session, emails a confirmation and schedules erasure within 30 days", async () => {
    const { client, email } = await approvedMember("Leaver");
    const viewer = await approvedMember("Viewer");
    expect((await viewer.client.get("/api/discover")).data.profiles.some((p: any) => p.userId === client.userId)).toBe(true);

    expect((await client.del("/api/me")).status).toBe(200);
    expect((await client.get("/api/me")).data.user).toBeNull();
    expect((await viewer.client.get("/api/discover")).data.profiles.some((p: any) => p.userId === client.userId)).toBe(false);
    expect(await lastEmail(email, "account_deleted")).not.toBeNull();
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, client.userId));
    expect(u!.status).toBe("deleted");
    expect(u!.eraseAfter! - u!.deletedAt!).toBe(30 * 86_400_000);
    // Cannot sign back in.
    expect((await new Client().post("/api/auth/login", { email, password: PASSWORD, turnstileToken: "human" })).status).toBe(403);
  });

  it("erases personal data on schedule but keeps moderation records and ban hashes", async () => {
    const { client, email } = await approvedMember("Erase");
    await applyEnforcement(env as any, db(), SENIOR, { userId: client.userId, kind: "ban", reasonCode: "SCAM" });
    const [before] = await db().select().from(schema.users).where(eq(schema.users.id, client.userId));
    await db().update(schema.users).set({ deletedAt: Date.now(), eraseAfter: Date.now() - 1 }).where(eq(schema.users.id, client.userId));

    const result = await eraseDueAccounts(db());
    expect(result.erased).toContain(client.userId);
    expect(result.r2Keys.length).toBeGreaterThan(0);
    const [after] = await db().select().from(schema.users).where(eq(schema.users.id, client.userId));
    expect(after!.email).toBeNull();
    expect(after!.passwordHash).toBeNull();
    expect(await db().select().from(schema.profiles).where(eq(schema.profiles.userId, client.userId))).toEqual([]);
    expect(await db().select().from(schema.photos).where(eq(schema.photos.userId, client.userId))).toEqual([]);
    // Retained: the enforcement record and the hashed ban signal that stops this person coming back.
    expect((await db().select().from(schema.enforcementActions).where(eq(schema.enforcementActions.userId, client.userId))).length).toBe(1);
    const signals = await db().select().from(schema.banSignals).where(eq(schema.banSignals.sourceUserId, client.userId));
    expect(signals.some((s) => s.kind === "email" && s.hash === before!.emailHash)).toBe(true);
    // And the ban holds: the same email cannot be used again, with no hint given.
    const again = new Client();
    expect((await again.post("/api/auth/signup", signupBody(email))).status).toBe(200);
    expect((await db().select().from(schema.users).where(eq(schema.users.email, email))).length).toBe(0);
  });

  it("does not erase an account under a legal hold", async () => {
    const { client } = await signUp();
    await db().update(schema.users).set({ deletedAt: Date.now(), eraseAfter: Date.now() - 1 }).where(eq(schema.users.id, client.userId));
    await db().insert(schema.legalHolds).values({ userId: client.userId, leRequestId: "le_test", until: Date.now() + 86_400_000, createdAt: Date.now() });
    const result = await eraseDueAccounts(db());
    expect(result.held).toContain(client.userId);
    expect(result.erased).not.toContain(client.userId);
  });
});

describe("Data export", () => {
  it("returns the member's own data as a JSON download", async () => {
    const { client, email } = await approvedMember("Export");
    const res = await client.raw("GET", "/api/me/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="my-data-/);
    const data = (await res.json()) as any;
    expect(data.account.email).toBe(email);
    expect(data.profile.displayName).toBe("Export");
    expect(data.photos.length).toBe(1);
    expect(data.photos[0].download).toMatch(/^https:\/\/app\.test\/media\//);
    expect(JSON.stringify(data)).not.toContain("argon2id");
  });
});
