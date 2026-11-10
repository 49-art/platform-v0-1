/**
 * The dater journey, sign-up to first date — spec section 2 steps 1 to 8 and the verification flow in section 7.
 * Each `describe` is one stretch of that flow; the node letters refer to the Mermaid chart in the spec.
 */
import { runDurableObjectAlarm } from "cloudflare:test";
import { decideModeration, hasActiveConsent, schema } from "../core";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { CHECKIN_GRACE_MS } from "../worker/do/date-timer";
import { Client, MOD, PASSWORD, SENIOR, approvePending, approvedMember, completeCheck, db, freshEmail, lastEmail, matched, runJobs, signUp, upload } from "./helpers";
import { jobs } from "./setup";

const LONDON = { lat: 51.5074, lon: -0.1278 };
const profileBody = (extra: Record<string, unknown> = {}) => ({ displayName: "Casey", birthYear: 1992, bio: "Dinner, films and the seaside.", lookingFor: "relationship", countryOfOrigin: "United Kingdom", location: LONDON, ...extra });

describe("Age assurance at sign-up (nodes D, E, X2)", () => {
  it("locks profile building until the age check passes", async () => {
    const { client } = await signUp();
    expect((await client.put("/api/profile", profileBody())).data.error.code).toBe("age_required");
    expect((await upload(client)).data.error.code).toBe("age_required");
    await completeCheck(client, "age");
    expect((await client.get("/api/me")).data.step).toBe("profile");
    expect((await client.put("/api/profile", profileBody())).status).toBe(200);
  });

  it("stores the result only, never a date of birth or document", async () => {
    const { client } = await signUp();
    await completeCheck(client, "age");
    const rows = await db().select().from(schema.ageChecks).where(eq(schema.ageChecks.userId, client.userId));
    expect(Object.keys(rows[0]!).sort()).toEqual(["createdAt", "decidedAt", "id", "method", "provider", "providerRef", "status", "userId"]);
  });

  it("refuses access after three failed checks and minimises the data held", async () => {
    const { client } = await signUp();
    for (let i = 0; i < 3; i++) await completeCheck(client, "age", "failed");
    const me = await client.get("/api/me");
    // Sessions are revoked with the suspension, so the client is signed out.
    expect(me.data.user).toBeNull();
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, client.userId));
    expect(u!.status).toBe("suspended");
    expect(await db().select().from(schema.profiles).where(eq(schema.profiles.userId, client.userId))).toEqual([]);
    const actions = await db().select().from(schema.enforcementActions).where(eq(schema.enforcementActions.userId, client.userId));
    expect(actions[0]!.reasonCode).toBe("UNDERAGE");
  });

  it("rejects a webhook with a bad signature", async () => {
    const res = await new Client().raw("POST", "/api/webhooks/age", { json: { providerRef: "x", status: "passed" }, headers: { "x-provider-timestamp": String(Date.now()), "x-provider-signature": "00" } });
    expect(res.status).toBe(401);
  });

  it("rejects a self-declared birth year under 18", async () => {
    const { client } = await signUp();
    await completeCheck(client, "age");
    const res = await client.put("/api/profile", profileBody({ birthYear: new Date().getUTCFullYear() - 16 }));
    expect(res.data.error.code).toBe("under_age");
  });
});

describe("Profile and pre-moderation (nodes E, F)", () => {
  it("keeps a profile out of discovery until a moderator approves it", async () => {
    const viewer = await approvedMember("Viewer");
    const { client } = await signUp();
    await completeCheck(client, "age");
    await client.put("/api/profile", profileBody({ displayName: "Pending Pat" }));
    await upload(client);
    expect((await client.post("/api/profile/submit")).data.status).toBe("pending");
    await runJobs();
    expect((await client.get("/api/me")).data.step).toBe("pending");
    expect((await client.get("/api/discover")).status).toBe(403);
    const seen = async () => (await viewer.client.get("/api/discover")).data.profiles.some((p: any) => p.userId === client.userId);
    expect(await seen()).toBe(false);

    // A profile cannot go live with no approved photo.
    const items = await db().select().from(schema.modQueue).where(and(eq(schema.modQueue.userId, client.userId), eq(schema.modQueue.status, "pending")));
    await expect(decideModeration(env as any, db(), MOD, items.find((i) => i.kind === "profile")!.id, "approve", undefined)).rejects.toThrow(/photo/);

    await approvePending(client.userId);
    expect((await client.get("/api/me")).data.step).toBe("ready");
    expect(await seen()).toBe(true);
  });

  it("sends a rejected profile back to the member with the reason", async () => {
    const { client } = await signUp();
    await completeCheck(client, "age");
    await client.put("/api/profile", profileBody());
    await upload(client);
    await client.post("/api/profile/submit");
    await runJobs();
    const [item] = await db().select().from(schema.modQueue).where(and(eq(schema.modQueue.userId, client.userId), eq(schema.modQueue.kind, "profile")));
    await expect(decideModeration(env as any, db(), MOD, item!.id, "reject", undefined)).rejects.toThrow(/reason/);
    await decideModeration(env as any, db(), MOD, item!.id, "reject", "PROFILE_TEXT");
    const me = await client.get("/api/me");
    expect(me.data.step).toBe("profile");
    expect(me.data.flags.profileRejection).toMatch(/guidelines/);
  });

  it("auto-rejects a nude profile photo and never shows it to anyone", async () => {
    const { client } = await signUp();
    await completeCheck(client, "age");
    const up = await upload(client, "MOCK_NUDITY");
    expect(await runJobs()).toContain("rejected");
    const [photo] = await db().select().from(schema.photos).where(eq(schema.photos.id, up.data.photo.id));
    expect(photo!.status).toBe("rejected");
    expect(await env.MEDIA!.get(photo!.r2Key)).toBeNull();
  });

  it("runs the CSAM path on a hash match: quarantine, freeze, escalate, preserve", async () => {
    const { client } = await signUp();
    await completeCheck(client, "age");
    const up = await upload(client, "MOCK_HASH_MATCH");
    expect(await runJobs()).toContain("quarantined");
    const [photo] = await db().select().from(schema.photos).where(eq(schema.photos.id, up.data.photo.id));
    expect(photo!.status).toBe("quarantined");
    expect(await env.MEDIA!.get(photo!.r2Key)).not.toBeNull(); // evidence preserved
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, client.userId));
    expect(u!.status).toBe("suspended");
    const reports = await db().select().from(schema.reports).where(eq(schema.reports.subjectUserId, client.userId));
    expect(reports.some((r) => r.priority === 0 && r.status === "escalated")).toBe(true);
    expect((await db().select().from(schema.legalHolds).where(eq(schema.legalHolds.userId, client.userId))).length).toBe(1);
    // The member cannot fetch or delete the quarantined item, even with a signed URL.
    const fresh = new Client();
    const email = (await db().select().from(schema.users).where(eq(schema.users.id, client.userId)))[0]!.email!;
    await fresh.post("/api/auth/login", { email, password: PASSWORD, turnstileToken: "human" });
    expect((await fresh.raw("GET", new URL(up.data.photo.url, "https://app.test").pathname + new URL(up.data.photo.url, "https://app.test").search)).status).toBe(404);
  });

  it("refuses non-image uploads whatever the filename says", async () => {
    const { client } = await signUp();
    await completeCheck(client, "age");
    const form = new FormData();
    form.set("file", new File([new TextEncoder().encode("<script>alert(1)</script>")], "me.jpg", { type: "image/jpeg" }));
    const res = await client.raw("POST", "/api/photos", { form });
    expect(((await res.json()) as any).error.code).toBe("bad_type");
  });

  it("blocks contact details in profile text", async () => {
    const { client } = await signUp();
    await completeCheck(client, "age");
    expect((await client.put("/api/profile", profileBody({ bio: "Text me on 07700 900123" }))).data.error.code).toBe("contact_in_profile");
    expect((await client.put("/api/profile", profileBody({ bio: "insta: @casey_real" }))).data.error.code).toBe("contact_in_profile");
  });

  it("only stores sexuality and identity under explicit consent, encrypted, and wipes them on withdrawal", async () => {
    const { client } = await signUp();
    await completeCheck(client, "age");
    const identity = { gender: "woman", orientation: "bisexual", show: ["gender"] };
    expect((await client.put("/api/profile", profileBody({ identity }))).data.error.code).toBe("consent_required");
    await client.post("/api/consents", { kind: "special_category", granted: true });
    expect((await client.put("/api/profile", profileBody({ identity }))).status).toBe(200);
    const [row] = await db().select().from(schema.profiles).where(eq(schema.profiles.userId, client.userId));
    expect(row!.identityEnc).toMatch(/^v1\./);
    expect(row!.identityEnc).not.toContain("bisexual");
    expect((await client.get("/api/profile")).data.identity.orientation).toBe("bisexual");

    await client.post("/api/consents", { kind: "special_category", granted: false });
    const [after] = await db().select().from(schema.profiles).where(eq(schema.profiles.userId, client.userId));
    expect(after!.identityEnc).toBeNull();
    const ledger = (await client.get("/api/consents")).data.consents;
    expect(ledger[0].withdrawnAt).not.toBeNull();
    expect(ledger[0].version).toBeTruthy();
  });

  it("shows other members only the identity fields someone chose to display", async () => {
    const a = await approvedMember("Shown");
    await a.client.post("/api/consents", { kind: "special_category", granted: true });
    await a.client.put("/api/profile", { displayName: "Shown", birthYear: 1990, bio: "Hi, I am Shown. I like long walks and good coffee.", lookingFor: "relationship", countryOfOrigin: "United Kingdom", identity: { gender: "woman", orientation: "lesbian", show: ["gender"] } });
    const b = await approvedMember("Looker");
    const p = (await b.client.get(`/api/profiles/${a.client.userId}`)).data.profile;
    expect(p.identity).toEqual({ gender: "woman" });
    expect(JSON.stringify(p)).not.toContain("lesbian");
  });

  it("discards exact coordinates and keeps a coarse cell", async () => {
    const { client } = await approvedMember("Coarse", { location: { lat: 51.580123, lon: -0.341987 } });
    const [row] = await db().select().from(schema.profiles).where(eq(schema.profiles.userId, client.userId));
    expect(row!.geoCell).toHaveLength(5);
    expect(JSON.stringify(row)).not.toContain("51.580123");
    expect(JSON.stringify(row)).not.toContain("0.341987");
  });

  it("is UK only at launch", async () => {
    const { client } = await signUp();
    await completeCheck(client, "age");
    expect((await client.put("/api/profile", profileBody({ location: { lat: 48.8566, lon: 2.3522 } }))).data.error.code).toBe("outside_launch_area");
  });
});

describe("Discovery and matching (node G)", () => {
  it("filters by distance and age, and never shows the same person twice after a pass", async () => {
    const me = await approvedMember("Seeker");
    const near = await approvedMember("Near", { birthYear: 1991 });
    const far = await approvedMember("Far", { location: { lat: 55.9533, lon: -3.1883 } }); // Edinburgh
    const older = await approvedMember("Older", { birthYear: 1960 });
    const ids = async (qs = "") => (await me.client.get(`/api/discover${qs}`)).data.profiles.map((p: any) => p.userId);
    expect(await ids("?km=50")).toContain(near.client.userId);
    expect(await ids("?km=50")).not.toContain(far.client.userId);
    expect(await ids("?km=800")).toContain(far.client.userId);
    expect(await ids("?km=50&maxAge=45")).not.toContain(older.client.userId);
    await me.client.post("/api/likes", { userId: near.client.userId, kind: "pass" });
    expect(await ids("?km=50")).not.toContain(near.client.userId);
  });

  it("opens a chat only on a mutual like", async () => {
    const a = await approvedMember("Ann");
    const b = await approvedMember("Ben");
    const first = await a.client.post("/api/likes", { userId: b.client.userId, kind: "like" });
    expect(first.data.matched).toBe(false);
    expect((await a.client.get("/api/matches")).data.matches).toEqual([]);
    const second = await b.client.post("/api/likes", { userId: a.client.userId, kind: "like" });
    expect(second.data.matched).toBe(true);
    const list = (await a.client.get("/api/matches")).data.matches;
    expect(list[0].conversationId).toBe(second.data.conversationId);
    expect(list[0].other.displayName).toBe("Ben");
    const note = (await a.client.get("/api/notifications")).data.notifications;
    expect(note.some((n: any) => n.kind === "match")).toBe(true);
  });

  it("serves photos only through a signed link bound to the viewer", async () => {
    const a = await approvedMember("Pic");
    const b = await approvedMember("Peeker");
    const c = await approvedMember("Thief");
    const url: string = (await b.client.get(`/api/profiles/${a.client.userId}`)).data.profile.photos[0];
    expect((await b.client.raw("GET", url)).status).toBe(200);
    expect((await c.client.raw("GET", url)).status).toBe(403); // someone else's link
    expect((await new Client().raw("GET", url)).status).toBe(401); // signed out
    expect((await b.client.raw("GET", url.replace(/s=[0-9a-f]{4}/, "s=0000"))).status).toBe(403); // tampered
  });
});

describe("Chat (spec 6)", () => {
  it("delivers a message in real time and archives an encrypted copy", async () => {
    const { a, b, conversationId } = await matched();
    const sa = await a.socket(`/api/conversations/${conversationId}/ws`);
    const sb = await b.socket(`/api/conversations/${conversationId}/ws`);
    await sa.until((f) => f.type === "ready");
    sa.send({ type: "send", clientId: "c1", text: "Hello Blake, fancy a coffee this week?" });
    const got = await sb.until((f) => f.type === "message");
    expect(got.message.text).toBe("Hello Blake, fancy a coffee this week?");
    expect(got.message.senderId).toBe(a.userId);
    await sa.until((f) => f.type === "sent" && f.clientId === "c1");

    await runJobs();
    const [row] = await db().select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(row!.bodyEnc).toMatch(/^v1\./);
    expect(row!.bodyEnc).not.toContain("coffee");
    // History is replayed to a client that connects later.
    const late = await b.socket(`/api/conversations/${conversationId}/ws`);
    const ready = await late.until((f) => f.type === "ready");
    expect(ready.messages.at(-1).text).toContain("coffee");
  });

  it("refuses a WebSocket to anyone who is not one of the two members", async () => {
    const { conversationId } = await matched("Mia", "Noah");
    const outsider = await approvedMember("Outsider");
    const res = await outsider.client.raw("GET", `/api/conversations/${conversationId}/ws`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(404);
    expect((await new Client().raw("GET", `/api/conversations/${conversationId}/ws`, { headers: { upgrade: "websocket" } })).status).toBe(401);
  });

  it("holds back contact details until both are verified and both consent", async () => {
    const { a, b, conversationId } = await matched("Cara", "Dev");
    const sa = await a.socket(`/api/conversations/${conversationId}/ws`);
    const sb = await b.socket(`/api/conversations/${conversationId}/ws`);
    sa.send({ type: "send", clientId: "p1", text: "call me on 07700 900 123" });
    const rejected = await sa.until((f) => f.type === "rejected" && f.clientId === "p1");
    expect(rejected.code).toBe("shield");
    expect(rejected.notice).toMatch(/ID-verified/);
    sa.send({ type: "send", clientId: "p2", text: "zero seven seven double oh nine hundred... whatsapp me" });
    sa.send({ type: "send", clientId: "ok", text: "ok, no numbers then" });
    await sb.until((f) => f.type === "message" && f.message.text === "ok, no numbers then");
    expect(sb.frames.filter((f) => f.type === "message").length).toBe(1);
  });

  it("keeps an unread count for a member who is not in the chat and queues an offline notice with no content", async () => {
    const { a, b, conversationId } = await matched("Eve", "Finn");
    const sa = await a.socket(`/api/conversations/${conversationId}/ws`);
    sa.send({ type: "send", clientId: "u1", text: "Are you free on Friday evening?" });
    await sa.until((f) => f.type === "sent");
    expect(jobs.some((j) => j.kind === "notify" && j.userId === b.userId && j.reason === "message")).toBe(true);
    const list = (await b.get("/api/matches")).data.matches;
    expect(list[0].unread).toBe(1);
    await runJobs();
    const digest = await lastEmail((await db().select().from(schema.users).where(eq(schema.users.id, b.userId)))[0]!.email!, "digest");
    expect(digest).not.toBeNull();
    expect(digest!.body).not.toContain("Friday");
    // Opening the conversation clears it.
    await b.socket(`/api/conversations/${conversationId}/ws`);
    expect((await b.get("/api/matches")).data.matches[0].unread).toBe(0);
  });

  it("limits how fast one person can send", async () => {
    const { a, conversationId } = await matched("Gus", "Hana");
    const sa = await a.socket(`/api/conversations/${conversationId}/ws`);
    for (let i = 0; i < 25; i++) sa.send({ type: "send", clientId: `r${i}`, text: `message number ${i}` });
    const limited = await sa.until((f) => f.type === "rejected" && f.code === "rate_limited");
    expect(limited).toBeTruthy();
    expect(sa.frames.filter((f) => f.type === "sent").length).toBe(20);
  });

  it("flags scam language for moderators and raises the sender's risk score", async () => {
    const { a, conversationId } = await matched("Ivy", "Jon");
    const sa = await a.socket(`/api/conversations/${conversationId}/ws`);
    sa.send({ type: "send", clientId: "s1", text: "I am stuck abroad, can you send money for my flight? Gift cards work too" });
    await sa.until((f) => f.type === "sent");
    await runJobs();
    const flagged = await db().select().from(schema.flaggedMessages).where(eq(schema.flaggedMessages.senderId, a.userId));
    expect(JSON.parse(flagged[0]!.flags)).toEqual(expect.arrayContaining(["money_request", "gift_card"]));
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, a.userId));
    expect(u!.riskScore).toBeGreaterThanOrEqual(55);
  });

  it("delivers a chat image only after it passes scanning, and never an explicit one without opt-in", async () => {
    const { a, b, conversationId } = await matched("Kit", "Lou");
    const sa = await a.socket(`/api/conversations/${conversationId}/ws`);
    const sb = await b.socket(`/api/conversations/${conversationId}/ws`);
    await upload(a, "", conversationId);
    expect(sb.frames.some((f) => f.type === "message" && f.message.kind === "image")).toBe(false); // nothing before the scan
    await runJobs();
    const img = await sb.until((f) => f.type === "message" && f.message.kind === "image");
    expect((await b.raw("GET", img.message.image)).status).toBe(200);

    await upload(a, "MOCK_NUDITY", conversationId);
    expect(await runJobs()).toContain("rejected");
    await sa.until((f) => f.type === "rejected" && f.code === "image");
    expect(sb.frames.filter((f) => f.type === "message" && f.message.kind === "image").length).toBe(1);

    await b.post("/api/consents", { kind: "explicit_media", granted: true });
    await upload(a, "MOCK_NUDITY", conversationId);
    await runJobs();
    const explicit = await sb.until((f) => f.type === "message" && f.message.explicit === true);
    expect(explicit.message.kind).toBe("image");
  });
});

describe("Verify before you meet (nodes H to S)", () => {
  it("keeps date tools and swaps locked until BOTH people are verified", async () => {
    const { a, b, conversationId } = await matched("Mo", "Nia");
    const propose = () => a.post(`/api/conversations/${conversationId}/dates`, { startsAt: Date.now() + 48 * 3_600_000, venueName: "The Corner Bistro", venueArea: "Harrow" });
    let res = await propose();
    expect(res.status).toBe(403);
    expect(res.data.error).toMatchObject({ code: "verification_required", who: "you" });
    await completeCheck(a, "idv");
    res = await propose();
    expect(res.data.error).toMatchObject({ code: "verification_required", who: "them" }); // node N: date tools stay locked
    expect((await a.post(`/api/conversations/${conversationId}/swap`, { kind: "phone", consent: true })).status).toBe(403);
    await completeCheck(b, "idv");
    expect((await propose()).status).toBe(200);
    expect((await a.get(`/api/conversations/${conversationId}`)).data.other.verified).toBe(true);
  });

  it("stores the verification result only", async () => {
    const { client } = await approvedMember("Result");
    await completeCheck(client, "idv");
    const [row] = await db().select().from(schema.idVerifications).where(eq(schema.idVerifications.userId, client.userId));
    expect(row!.status).toBe("passed");
    expect(Object.keys(row!).sort()).toEqual(["createdAt", "decidedAt", "duplicateSignalHash", "faceMatch", "id", "provider", "providerRef", "reviewNote", "status", "userId"]);
    expect(row!.duplicateSignalHash).not.toContain("mock-person");
  });

  it("sends a pass whose face does not match the photos to manual review", async () => {
    const { client } = await approvedMember("Mismatch");
    await completeCheck(client, "idv", "passed", { faceMatch: false });
    expect((await client.get("/api/me")).data.flags.idStatus).toBe("review");
    const [item] = await db().select().from(schema.modQueue).where(and(eq(schema.modQueue.userId, client.userId), eq(schema.modQueue.kind, "idv_review")));
    await decideModeration(env as any, db(), MOD, item!.id, "approve", undefined);
    expect((await client.get("/api/me")).data.flags.idVerified).toBe(true);
  });

  it("lets a failed verification be retried", async () => {
    const { client } = await approvedMember("Retry");
    await completeCheck(client, "idv", "failed");
    expect((await client.get("/api/me")).data.flags.idStatus).toBe("failed");
    await completeCheck(client, "idv");
    expect((await client.get("/api/me")).data.flags.idVerified).toBe(true);
  });

  it("runs a date from proposal to check-in, with the trusted contact told only what was shared", async () => {
    const { a, b, conversationId } = await matched("Oli", "Pam");
    await completeCheck(a, "idv");
    await completeCheck(b, "idv");
    const startsAt = Date.now() + 48 * 3_600_000;
    const proposed = await a.post(`/api/conversations/${conversationId}/dates`, { startsAt, venueName: "The Corner Bistro", venueArea: "Harrow" });
    const dateId = proposed.data.id;
    // Only the invitee can accept.
    expect((await a.post(`/api/dates/${dateId}/respond`, { action: "accept" })).status).toBe(403);
    expect((await b.post(`/api/dates/${dateId}/respond`, { action: "accept" })).status).toBe(200);
    const [stored] = await db().select().from(schema.dates).where(eq(schema.dates.id, dateId));
    expect(stored!.venueEnc).not.toContain("Bistro");

    const tc = await b.post("/api/trusted-contacts", { channel: "email", name: "Sam (sister)", address: "sam@example.test" });
    const checkinAt = startsAt + 3 * 3_600_000;
    const set = await b.put(`/api/dates/${dateId}/safety`, { trustedContactId: tc.data.id, share: true, checkinAt });
    expect(set.data.shared).toBe(true);
    const plan = await lastEmail("sam@example.test", "date_plan_shared");
    expect(plan!.body).toContain("The Corner Bistro");
    expect(plan!.body).toContain("Oli");

    // The other person cannot see whether or how the safety net is set.
    const aView = (await a.get(`/api/conversations/${conversationId}`)).data.dates[0];
    expect(aView.safety).toBeNull();

    expect((await b.post(`/api/dates/${dateId}/checkin`)).status).toBe(200);
    const stub = env.DATE_TIMER.get(env.DATE_TIMER.idFromName(`${dateId}:${b.userId}`));
    expect(await runDurableObjectAlarm(stub)).toBe(false); // checking in cancels the timer
    expect(await lastEmail("sam@example.test", "safety_missed_checkin")).toBeNull();
  });

  it("reminds, then alerts the trusted contact and staff when a check-in is missed", async () => {
    const { a, b, conversationId } = await matched("Quin", "Rae");
    await completeCheck(a, "idv");
    await completeCheck(b, "idv");
    const startsAt = Date.now() + 2 * 3_600_000;
    const dateId = (await a.post(`/api/conversations/${conversationId}/dates`, { startsAt, venueName: "Canal Cafe", venueArea: "Camden" })).data.id;
    await b.post(`/api/dates/${dateId}/respond`, { action: "accept" });
    const tc = await b.post("/api/trusted-contacts", { channel: "sms", name: "Dad", address: "+447700900456" });
    await b.put(`/api/dates/${dateId}/safety`, { trustedContactId: tc.data.id, share: false, checkinAt: startsAt + 3_600_000 });

    const stub = env.DATE_TIMER.get(env.DATE_TIMER.idFromName(`${dateId}:${b.userId}`));
    expect(await runDurableObjectAlarm(stub)).toBe(true); // reminder
    expect((await b.get("/api/notifications")).data.notifications.some((n: any) => n.title === "Time to check in")).toBe(true);
    expect(await lastEmail("+447700900456")).toBeNull(); // not yet: there is a grace period
    expect(CHECKIN_GRACE_MS).toBe(30 * 60_000);

    expect(await runDurableObjectAlarm(stub)).toBe(true); // grace period over
    const sms = await lastEmail("+447700900456", "safety_missed_checkin");
    expect(sms!.channel).toBe("sms");
    expect(sms!.body).toContain("Canal Cafe");
    expect(sms!.body).toContain("999");
    const staff = await db().select().from(schema.reports).where(and(eq(schema.reports.conversationId, conversationId), eq(schema.reports.priority, 0)));
    expect(staff.length).toBe(1);
    expect(await runDurableObjectAlarm(stub)).toBe(false); // and it does not fire again
  });

  it("raises an SOS immediately", async () => {
    const { a, b, conversationId } = await matched("Sky", "Tom");
    await completeCheck(a, "idv");
    await completeCheck(b, "idv");
    const dateId = (await a.post(`/api/conversations/${conversationId}/dates`, { startsAt: Date.now() + 2 * 3_600_000, venueName: "Park Gate", venueArea: "Leeds" })).data.id;
    await b.post(`/api/dates/${dateId}/respond`, { action: "accept" });
    const tc = await a.post("/api/trusted-contacts", { channel: "email", name: "Jo", address: "jo@example.test" });
    await a.put(`/api/dates/${dateId}/safety`, { trustedContactId: tc.data.id, share: false, checkinAt: null });
    const sos = await a.post(`/api/dates/${dateId}/sos`);
    expect(sos.data.contacted).toBe(true);
    expect(sos.data.emergency).toContain("999");
    expect((await lastEmail("jo@example.test", "safety_sos"))!.subject).toMatch(/Urgent/);
  });

  it("reveals phone numbers to each other only after both consent, and unlocks the shield", async () => {
    const { a, b, conversationId } = await matched("Uma", "Vik");
    await completeCheck(a, "idv");
    await completeCheck(b, "idv");
    expect((await a.post(`/api/conversations/${conversationId}/swap`, { kind: "phone", consent: true })).data.error.code).toBe("phone_missing");
    await a.put("/api/me/phone", { phone: "+447700900111" });
    await b.put("/api/me/phone", { phone: "+447700900222" });

    const one = await a.post(`/api/conversations/${conversationId}/swap`, { kind: "phone", consent: true });
    expect(one.data.swap.phone).toEqual({ mine: true, theirs: false, reveal: null }); // one-sided consent reveals nothing
    expect((await b.get(`/api/conversations/${conversationId}`)).data.swap.phone.reveal).toBeNull();

    const two = await b.post(`/api/conversations/${conversationId}/swap`, { kind: "phone", consent: true });
    expect(two.data.swap.phone.reveal).toBe("+447700900111");
    expect((await a.get(`/api/conversations/${conversationId}`)).data.swap.phone.reveal).toBe("+447700900222");
    expect(await hasActiveConsent(db(), a.userId, "phone_swap", conversationId)).toBe(true);

    // Now contact details may be typed in chat.
    const sa = await a.socket(`/api/conversations/${conversationId}/ws`);
    sa.send({ type: "send", clientId: "n1", text: "my other number is 07700 900 333" });
    await sa.until((f) => f.type === "sent" && f.clientId === "n1");

    // Withdrawing consent hides the number again.
    await b.post(`/api/conversations/${conversationId}/swap`, { kind: "phone", consent: false });
    expect((await a.get(`/api/conversations/${conversationId}`)).data.swap.phone.reveal).toBeNull();
  });

  it("blocks a banned person who returns with the same identity document", async () => {
    const first = await approvedMember("Banned");
    await completeCheck(first.client, "idv", "passed", { duplicateToken: "person-123" });
    const { applyEnforcement } = await import("../core");
    await applyEnforcement(env as any, db(), SENIOR, { userId: first.client.userId, kind: "ban", reasonCode: "SCAM" });

    const second = await approvedMember("Returner", { displayName: "Returner" });
    await completeCheck(second.client, "idv", "passed", { duplicateToken: "person-123" });
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, second.client.userId));
    expect(u!.status).toBe("banned");
    const actions = await db().select().from(schema.enforcementActions).where(eq(schema.enforcementActions.userId, second.client.userId));
    expect(actions[0]!.reasonCode).toBe("BAN_EVASION");
  });
});

it("keeps X-only members out until they add and confirm an email", async () => {
  // The OAuth redirect itself needs X credentials; this covers the account state it leaves behind.
  const { client } = await signUp();
  await db().update(schema.users).set({ email: null, emailVerifiedAt: null, passwordHash: null }).where(eq(schema.users.id, client.userId));
  expect((await client.get("/api/me")).data.step).toBe("email_capture");
  const email = freshEmail("xonly");
  expect((await client.post("/api/me/email", { email })).status).toBe(200);
  expect((await client.get("/api/me")).data.step).toBe("email_verify");
  expect((await client.post("/api/age/start")).data.error.code).toBe("email_unverified");
});
