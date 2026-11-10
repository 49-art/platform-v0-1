import { type Actor, decideModeration, makeDb, schema } from "../core";
import { env, exports } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { runJob } from "../worker/jobs";
import { jobs } from "./setup";

export const ORIGIN = "https://app.test";
export const db = () => makeDb(env.DB);
export const MOD: Actor = { id: "stf_mod", role: "moderator" };
export const SENIOR: Actor = { id: "stf_senior", role: "senior_moderator" };
export const LEAD: Actor = { id: "stf_lead", role: "ts_lead" };

let ipCounter = 10;
let emailCounter = 0;
export const freshEmail = (tag = "user") => `${tag}${++emailCounter}-${Date.now()}@example.test`;

/** A browser stand-in: keeps cookies, sends Origin and the CSRF header exactly as the real client does. */
export class Client {
  cookies = new Map<string, string>();
  ip = `198.51.100.${ipCounter++ % 250}`;
  userId = "";
  origin: string | null = ORIGIN;
  sendCsrf = true;

  private headers(extra: Record<string, string> = {}) {
    const h: Record<string, string> = { "cf-connecting-ip": this.ip, "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile", ...extra };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (this.origin) h.origin = this.origin;
    const csrf = this.cookies.get("__Host-csrf");
    if (csrf && this.sendCsrf) h["x-csrf-token"] = csrf;
    return h;
  }

  private absorb(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const idx = pair!.indexOf("=");
      const name = pair!.slice(0, idx), value = pair!.slice(idx + 1);
      if (value === "" || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async raw(method: string, path: string, init: { json?: unknown; form?: FormData; headers?: Record<string, string> } = {}) {
    const headers = this.headers(init.headers);
    let body: BodyInit | undefined;
    if (init.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(init.json); }
    if (init.form) body = init.form;
    const res: Response = await (exports as any).default.fetch(new Request(ORIGIN + path, { method, headers, body, redirect: "manual" }));
    this.absorb(res);
    return res;
  }

  async call<T = any>(method: string, path: string, json?: unknown): Promise<{ status: number; data: T }> {
    const res = await this.raw(method, path, { json });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
  get = <T = any>(path: string) => this.call<T>("GET", path);
  post = <T = any>(path: string, json: unknown = {}) => this.call<T>("POST", path, json);
  put = <T = any>(path: string, json: unknown = {}) => this.call<T>("PUT", path, json);
  del = <T = any>(path: string) => this.call<T>("DELETE", path);

  /** Opens a WebSocket through the Worker and collects every frame it receives. */
  async socket(path: string) {
    const res = await this.raw("GET", path, { headers: { upgrade: "websocket" } });
    if (res.status !== 101 || !res.webSocket) throw new Error(`WebSocket upgrade failed: ${res.status} ${await res.text()}`);
    const ws = res.webSocket;
    const frames: any[] = [];
    let closed: { code: number; reason: string } | null = null;
    ws.accept();
    ws.addEventListener("message", (e) => frames.push(JSON.parse(e.data as string)));
    ws.addEventListener("close", (e) => { closed = { code: e.code, reason: e.reason }; });
    const until = async (pred: (f: any) => boolean, ms = 3000) => {
      const start = Date.now();
      for (;;) {
        const hit = frames.find(pred);
        if (hit) return hit;
        if (Date.now() - start > ms) throw new Error(`Timed out waiting for frame. Got: ${JSON.stringify(frames)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    return { ws, frames, until, send: (o: unknown) => ws.send(JSON.stringify(o)), closed: () => closed };
  }
}

export async function lastEmail(to: string, template?: string) {
  const rows = await db().select().from(schema.outbox).where(template ? and(eq(schema.outbox.toAddress, to), eq(schema.outbox.template, template)) : eq(schema.outbox.toAddress, to));
  return rows.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))[0] ?? null;
}
export const tokenFrom = (body: string) => /token=([A-Za-z0-9_-]+)/.exec(body)?.[1] ?? "";

export const PASSWORD = "correct horse battery";

/** Sign up by email, follow the emailed link, and return a signed-in client. */
export async function signUp(email = freshEmail()) {
  const c = new Client();
  const res = await c.post("/api/auth/signup", { email, password: PASSWORD, turnstileToken: "human", over18: true, acceptTerms: true });
  if (res.status !== 200) throw new Error(`signup failed: ${JSON.stringify(res.data)}`);
  const mail = await lastEmail(email, "verify_email");
  const v = await c.post("/api/auth/verify-email", { token: tokenFrom(mail!.body) });
  if (v.status !== 200) throw new Error(`verify failed: ${JSON.stringify(v.data)}`);
  c.userId = (await c.get("/api/me")).data.user.id;
  return { client: c, email };
}

export async function completeCheck(c: Client, kind: "age" | "idv", status: "passed" | "failed" | "review" = "passed", extra: Record<string, unknown> = {}) {
  const start = await c.post(kind === "age" ? "/api/age/start" : "/api/verification/start");
  if (start.status !== 200) throw new Error(`${kind} start failed: ${JSON.stringify(start.data)}`);
  const ref = new URL(start.data.url).searchParams.get("ref")!;
  return c.post("/api/dev/provider/complete", { kind, ref, status, faceMatch: kind === "idv" ? true : undefined, ...extra });
}

const JPEG = [0xff, 0xd8, 0xff, 0xe0];
export function imageFile(marker = "", name = "me.jpg") {
  const bytes = new Uint8Array([...JPEG, ...new TextEncoder().encode(`${marker}-${Math.random()}`)]);
  return new File([bytes], name, { type: "image/jpeg" });
}

export async function upload(c: Client, marker = "", conversationId?: string) {
  const form = new FormData();
  form.set("file", imageFile(marker));
  if (conversationId) form.set("conversationId", conversationId);
  const res = await c.raw("POST", "/api/photos", { form });
  return { status: res.status, data: (await res.json()) as any };
}

/** Runs every queued job, including jobs those jobs enqueue. */
export async function runJobs() {
  const results: unknown[] = [];
  while (jobs.length) results.push(await runJob(env as any, jobs.shift()!));
  return results;
}

export async function approvePending(userId: string) {
  const items = await db().select().from(schema.modQueue).where(and(eq(schema.modQueue.userId, userId), eq(schema.modQueue.status, "pending")));
  for (const kind of ["photo", "profile"] as const) for (const item of items.filter((i) => i.kind === kind)) await decideModeration(env as any, db(), MOD, item.id, "approve", undefined);
}

const LONDON = { lat: 51.5074, lon: -0.1278 };

/** A member who has done everything up to an approved, browsable profile. */
export async function approvedMember(name: string, overrides: Record<string, unknown> = {}) {
  const { client, email } = await signUp(freshEmail(name.toLowerCase()));
  await completeCheck(client, "age");
  const put = await client.put("/api/profile", { displayName: name, birthYear: 1990, bio: `Hi, I am ${name}. I like long walks and good coffee.`, lookingFor: "relationship", countryOfOrigin: "United Kingdom", location: LONDON, ...overrides });
  if (put.status !== 200) throw new Error(`profile failed: ${JSON.stringify(put.data)}`);
  await upload(client);
  await client.post("/api/profile/submit");
  await runJobs();
  await approvePending(client.userId);
  return { client, email };
}

export async function matched(aName = "Alex", bName = "Blake") {
  const a = await approvedMember(aName);
  const b = await approvedMember(bName);
  await a.client.post("/api/likes", { userId: b.client.userId, kind: "like" });
  const like = await b.client.post("/api/likes", { userId: a.client.userId, kind: "like" });
  jobs.length = 0;
  return { a: a.client, b: b.client, aEmail: a.email, bEmail: b.email, conversationId: like.data.conversationId as string };
}
