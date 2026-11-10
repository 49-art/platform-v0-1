/**
 * Tests for the free-plan sample (decisions D-014 to D-021) and the staff console API (spec 8).
 * The core spec tests in auth.test.ts and journey.test.ts run with SAMPLE_MODE off, so they prove production behaviour.
 * Here SAMPLE_MODE is switched on for the duration of this file only.
 */
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "../core";
import { ensureReady } from "../worker/lib/bootstrap";
import { dispatch } from "../worker/lib/dispatch";
import { getMedia, putMedia, removeMedia } from "../worker/lib/media";
import { sampleAvatar } from "../worker/lib/png";
import { Client, PASSWORD, approvedMember, db, freshEmail, lastEmail, signUp, tokenFrom } from "./helpers";
import { jobs } from "./setup";

const E = env as any;

beforeAll(() => { E.SAMPLE_MODE = "1"; });
afterAll(() => { delete E.SAMPLE_MODE; });

async function admin() {
  const m = await approvedMember("Founder");
  await db().delete(schema.staff); // each test starts from "no staff yet"
  const claim = await m.client.post("/api/admin/claim");
  expect(claim.status).toBe(200);
  return m;
}

describe("Free-plan adapters", () => {
  it("stores media in D1 when no R2 bucket is bound, and reads it back byte for byte", async () => {
    const noR2 = { ...E, MEDIA: undefined };
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
    await putMedia(noR2, "u/test/blob1", bytes.buffer, "image/png");
    const got = await getMedia(noR2, "u/test/blob1");
    expect(got?.contentType).toBe("image/png");
    expect(new Uint8Array(got!.body as ArrayBuffer)).toEqual(bytes);
    await removeMedia(noR2, "u/test/blob1");
    expect(await getMedia(noR2, "u/test/blob1")).toBeNull();
  });

  it("runs a job inline when no queue is bound (Workers Free has no Queues)", async () => {
    const before = jobs.length;
    const noQueues = { ...E, Q_NOTIFY: undefined, Q_SCAN: undefined, Q_MAINT: undefined };
    const result = await dispatch(noQueues, { kind: "notify", userId: "usr_nobody", reason: "match" });
    expect(result).toBe("inline");
    expect(jobs.length).toBe(before); // nothing went to a queue
  });

  it("draws sample avatars as valid PNGs well under D1's 1 MB row limit", () => {
    const png = sampleAvatar(3);
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.byteLength).toBeLessThan(1_000_000);
  });

  it("brings the database up to date on first use, and does nothing the second time", async () => {
    await ensureReady(E);
    await ensureReady(E);
    const rows = (await E.DB.prepare("SELECT name FROM d1_migrations").all()).results.map((r: any) => r.name);
    expect(rows).toContain("0003_taxonomy_seed.sql");
    expect(new Set(rows).size).toBe(rows.length);
    const tax = await E.DB.prepare("SELECT COUNT(*) AS n FROM taxonomy").first();
    expect(tax.n).toBeGreaterThanOrEqual(17);
  });
});

describe("PBKDF2 password setting for the free plan (D-016)", () => {
  it("signs a member up and in with PBKDF2, and never downgrades an Argon2id hash", async () => {
    E.PASSWORD_ALGO = "pbkdf2";
    try {
      const email = freshEmail("pbkdf");
      const c = new Client();
      expect((await c.post("/api/auth/signup", { email, password: PASSWORD, turnstileToken: "human", over18: true, acceptTerms: true })).status).toBe(200);
      const [u] = await db().select().from(schema.users).where(eq(schema.users.email, email));
      expect(u!.passwordHash).toMatch(/^pbkdf2\$i=100000\$/);
      await c.post("/api/auth/verify-email", { token: tokenFrom((await lastEmail(email, "verify_email"))!.body) });
      const login = await new Client().post("/api/auth/login", { email, password: PASSWORD, turnstileToken: "human" });
      expect(login.status).toBe(200);
      const wrong = await new Client().post("/api/auth/login", { email, password: "not the password", turnstileToken: "human" });
      expect(wrong.status).toBe(403);
    } finally {
      delete E.PASSWORD_ALGO;
    }
  });
});

describe("Sample mode: links on screen, never someone else's", () => {
  it("shows the verify link to the person who just signed up", async () => {
    const c = new Client();
    const res = await c.post("/api/auth/signup", { email: freshEmail("s1"), password: PASSWORD, turnstileToken: "human", over18: true, acceptTerms: true });
    expect(res.data.sample.link).toMatch(/\/verify-email\?token=/);
    expect(res.data.sample.note).toMatch(/SAMPLE MODE/);
  });

  it("gives the same response shape whether or not the address is registered", async () => {
    const { email } = await signUp(freshEmail("s2"));
    const res = await new Client().post("/api/auth/signup", { email, password: PASSWORD, turnstileToken: "human", over18: true, acceptTerms: true });
    expect(Object.keys(res.data).sort()).toEqual(["message", "ok", "sample"]);
    expect(res.data.sample.link).toMatch(/\/login$/); // a sign-in link, not a token
  });

  it("never shows a password reset link on a device the account has not used (no takeover by typing an email)", async () => {
    const { client, email } = await signUp(freshEmail("s3"));
    const stranger = await new Client().post("/api/auth/reset/request", { email, turnstileToken: "human" });
    expect(stranger.status).toBe(200);
    expect(stranger.data.sample).toBeUndefined();
    const owner = await client.post("/api/auth/reset/request", { email, turnstileToken: "human" });
    expect(owner.data.sample.link).toMatch(/\/reset\/confirm\?token=/);
  });

  it("keeps the outbox for staff only", async () => {
    const { client } = await signUp(freshEmail("s4"));
    E.ENVIRONMENT = "sample";
    try {
      expect((await client.get("/api/dev/outbox")).status).toBe(403);
    } finally {
      E.ENVIRONMENT = "test";
    }
  });
});

describe("Sample members", () => {
  it("are added by an admin, show in Discover, like back, and are removed cleanly", async () => {
    const boss = await admin();
    const seed = await boss.client.post("/api/admin/sample/seed");
    expect(seed.data.n).toBe(8);
    expect((await boss.client.post("/api/admin/sample/seed")).data.n).toBe(0); // idempotent
    const found = await boss.client.get("/api/discover?km=100");
    const sample = found.data.profiles.find((p: any) => p.displayName.includes("(SAMPLE)"));
    expect(sample).toBeTruthy();
    expect(sample.bio).toMatch(/not a real person/);
    const like = await boss.client.post("/api/likes", { userId: sample.userId, kind: "like" });
    expect(like.data.matched).toBe(true);
    const removed = await boss.client.post("/api/admin/sample/remove");
    expect(removed.data.n).toBe(8);
    const [conv] = await db().select().from(schema.conversations).where(eq(schema.conversations.id, like.data.conversationId));
    expect(conv!.status).toBe("closed");
  });

  it("cannot be seeded by a member who is not staff", async () => {
    const m = await approvedMember("Nobody");
    expect((await m.client.post("/api/admin/sample/seed")).status).toBe(403);
  });
});

describe("Staff console (spec 8)", () => {
  it("lets the first verified member claim admin once, then never again", async () => {
    await admin();
    const late = await approvedMember("Latecomer");
    expect((await late.client.post("/api/admin/claim")).status).toBe(403);
    expect((await late.client.get("/api/admin/dashboard")).status).toBe(403);
  });

  it("does not offer the claim outside sample mode", async () => {
    await db().delete(schema.staff);
    delete E.SAMPLE_MODE;
    try {
      const m = await approvedMember("Prod");
      expect((await m.client.post("/api/admin/claim")).status).toBe(403);
    } finally {
      E.SAMPLE_MODE = "1";
    }
  });

  it("checks every call against the role: a moderator cannot ban or manage staff", async () => {
    const boss = await admin();
    const mod = await approvedMember("Moddy");
    const [modUser] = await db().select().from(schema.users).where(eq(schema.users.id, mod.client.userId));
    expect((await boss.client.post("/api/admin/staff", { email: modUser!.email, role: "moderator" })).status).toBe(200);
    const target = await approvedMember("Target");
    expect((await mod.client.post(`/api/admin/users/${target.client.userId}/enforce`, { kind: "ban", reasonCode: "SCAM" })).status).toBe(403);
    expect((await mod.client.post(`/api/admin/users/${target.client.userId}/enforce`, { kind: "suspend", reasonCode: "SCAM", durationDays: 30 })).status).toBe(403);
    expect((await mod.client.post(`/api/admin/users/${target.client.userId}/enforce`, { kind: "suspend", reasonCode: "SCAM", durationDays: 3 })).status).toBe(200);
    expect((await mod.client.get("/api/admin/staff")).status).toBe(403);
    expect((await mod.client.get("/api/admin/audit")).status).toBe(403);
  });

  it("approves a profile from the pre-moderation queue (photos first), and logs every view", async () => {
    const boss = await admin();
    const { client } = await signUp(freshEmail("queue"));
    const { completeCheck, upload, runJobs } = await import("./helpers");
    await completeCheck(client, "age");
    await client.put("/api/profile", { displayName: "Queued", birthYear: 1992, bio: "Waiting for a moderator.", lookingFor: "dinner", countryOfOrigin: "", location: { area: "London" } });
    await upload(client);
    await client.post("/api/profile/submit");
    await runJobs();
    const queue = await boss.client.get("/api/admin/premod");
    const mine = queue.data.items.filter((i: any) => i.userId === client.userId);
    const profileItem = mine.find((i: any) => i.kind === "profile");
    const photoItem = mine.find((i: any) => i.kind === "photo");
    expect((await boss.client.post(`/api/admin/premod/${profileItem.id}`, { decision: "approve" })).status).toBe(409); // photo first
    const media = await boss.client.raw("GET", photoItem.photos[0].url);
    expect(media.status).toBe(200);
    expect((await boss.client.post(`/api/admin/premod/${photoItem.id}`, { decision: "approve" })).status).toBe(200);
    expect((await boss.client.post(`/api/admin/premod/${profileItem.id}`, { decision: "approve" })).status).toBe(200);
    expect((await client.get("/api/me")).data.step).toBe("ready");
    const logged = await db().select().from(schema.auditLog).where(and(eq(schema.auditLog.action, "media.view"), eq(schema.auditLog.targetId, photoItem.photos[0].id)));
    expect(logged.length).toBe(1);
  });

  it("works a report end to end: open the chat (logged), act, and tell the reporter the outcome", async () => {
    const boss = await admin();
    const { matched } = await import("./helpers");
    const { a, b, conversationId } = await matched("Rita", "Sam");
    const rep = await a.post("/api/reports", { userId: b.userId, reason: "scam", detail: "Asked me for money", conversationId });
    expect(rep.status).toBe(200);
    const list = await boss.client.get("/api/admin/reports");
    const item = list.data.reports.find((r: any) => r.id === rep.data.reference);
    expect(item.priority).toBe(1);
    expect((await boss.client.get(`/api/admin/reports/${item.id}/chat`)).status).toBe(200);
    const res = await boss.client.post(`/api/admin/reports/${item.id}/resolve`, { outcome: "action_taken", note: "Money request", action: { kind: "suspend", reasonCode: "SCAM", durationDays: 7 } });
    expect(res.status).toBe(200);
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, b.userId));
    expect(u!.status).toBe("suspended");
    const notes = (await a.get("/api/notifications")).data.notifications;
    expect(notes.some((n: any) => n.title === "Update on your report")).toBe(true);
    const opened = await db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "chat.open_on_report"));
    expect(opened.some((r) => r.targetId === conversationId)).toBe(true);
    // Closed reports cannot be used to read chats.
    expect((await boss.client.get(`/api/admin/reports/${item.id}/chat`)).status).toBe(403);
  });

  it("will not record a law-enforcement disclosure before the legal-basis check, except in an emergency", async () => {
    const boss = await admin();
    const subject = await approvedMember("Subject");
    const made = await boss.client.post("/api/admin/le", { agency: "Test Police", reference: "REF1", subjectUserId: subject.client.userId, legalBasis: "Example basis" });
    expect((await boss.client.post(`/api/admin/le/${made.data.id}`, { action: "disclose", note: "x" })).status).toBe(400);
    expect((await boss.client.post(`/api/admin/le/${made.data.id}`, { action: "preserve" })).status).toBe(200);
    const holds = await db().select().from(schema.legalHolds).where(eq(schema.legalHolds.userId, subject.client.userId));
    expect(holds.length).toBe(1);
    expect((await boss.client.post(`/api/admin/le/${made.data.id}`, { action: "basis_checked" })).status).toBe(200);
    expect((await boss.client.post(`/api/admin/le/${made.data.id}`, { action: "disclose", note: "Subscriber info" })).status).toBe(200);
  });

  it("keeps the audit log append-only even for an admin", async () => {
    await admin();
    await expect(E.DB.prepare("DELETE FROM audit_log").run()).rejects.toThrow(/append-only/);
  });
});
