import { DurableObject } from "cloudflare:workers";
import { addRisk, hasActiveConsent, isBlockedEitherWay, isVerified, makeDb, newId, runMessagePipeline, schema, signMediaPath } from "../../core";
import { eq } from "drizzle-orm";
import type { Env } from "../env";
import { ensureReady } from "../lib/bootstrap";
import { dispatch } from "../lib/dispatch";

interface Meta {
  conversationId: string;
  userA: string;
  userB: string;
}
interface StoredMessage {
  id: string;
  sender: string;
  kind: "text" | "image" | "system";
  body: string;
  photo_id: string | null;
  explicit: number;
  at: number;
  [key: string]: SqlStorageValue;
}
interface Attachment {
  userId: string;
}

const MAX_LEN = 2000;
const RATE = { limit: 20, windowMs: 30_000 }; // per sender
const HOUR = 3_600_000;

/**
 * One per conversation (spec 6). Holds both members' WebSockets through the Hibernation API, keeps the message
 * history in its own SQLite storage, and enforces membership, blocks, standing and per-sender rate limits on
 * every single message. The contact-detail shield and keyword flags run inline before anything is broadcast.
 */
export class ChatRoom extends DurableObject<Env> {
  private gate: { at: number; bothVerified: boolean; bothConsentedToSwap: boolean } | null = null;
  /** Send attempts per sender, counted synchronously so messages arriving together cannot all slip past the limit. */
  private attempts = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => ensureReady(env)); // media URLs are signed with APP_SECRET (D-021)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, sender TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
      photo_id TEXT, explicit INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)`);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS messages_at ON messages (at)");
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private get meta(): Meta | undefined {
    return this.ctx.storage.kv.get<Meta>("meta");
  }

  /** The Worker has already authenticated the member and checked membership against D1 before forwarding here. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const userId = request.headers.get("x-user-id")!;
    const meta: Meta = { conversationId: request.headers.get("x-conversation-id")!, userA: request.headers.get("x-user-a")!, userB: request.headers.get("x-user-b")! };
    if (userId !== meta.userA && userId !== meta.userB) return new Response("Forbidden", { status: 403 });
    if (!this.meta) this.ctx.storage.kv.put("meta", meta);

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [userId]);
    pair[1].serializeAttachment({ userId } satisfies Attachment);
    pair[1].send(JSON.stringify({ type: "ready", messages: await this.history(userId, Date.now() + 1), status: request.headers.get("x-conversation-status") }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async present(m: StoredMessage, viewerId: string) {
    const image = m.kind === "image" && m.photo_id ? await signMediaPath(this.env.APP_SECRET, `u/${m.sender}/${m.photo_id}`, viewerId, Math.ceil(Date.now() / HOUR) * HOUR + HOUR) : null;
    return { id: m.id, senderId: m.sender, kind: m.kind, text: m.body, image, explicit: !!m.explicit, at: m.at };
  }

  private async history(viewerId: string, before: number, limit = 50) {
    const rows = this.ctx.storage.sql.exec<StoredMessage>("SELECT * FROM messages WHERE at < ? ORDER BY at DESC LIMIT ?", before, limit).toArray().reverse();
    return Promise.all(rows.map((m) => this.present(m, viewerId)));
  }

  private other(meta: Meta, userId: string) {
    return meta.userA === userId ? meta.userB : meta.userA;
  }

  private async broadcast(m: StoredMessage) {
    for (const ws of this.ctx.getWebSockets()) {
      const { userId } = ws.deserializeAttachment() as Attachment;
      try { ws.send(JSON.stringify({ type: "message", message: await this.present(m, userId) })); } catch { /* gone */ }
    }
  }

  /** Verification and swap-consent state for the shield. Cached briefly; refreshed at once when a swap is agreed. */
  private async shieldContext(meta: Meta, now: number) {
    if (this.gate && now - this.gate.at < 20_000) return this.gate;
    const db = makeDb(this.env.DB);
    const bothVerified = (await isVerified(db, meta.userA)) && (await isVerified(db, meta.userB));
    const consented = async (kind: "phone_swap" | "x_link") => (await hasActiveConsent(db, meta.userA, kind, meta.conversationId)) && (await hasActiveConsent(db, meta.userB, kind, meta.conversationId));
    this.gate = { at: now, bothVerified, bothConsentedToSwap: bothVerified && ((await consented("phone_swap")) || (await consented("x_link"))) };
    return this.gate;
  }

  refreshGate(): void {
    this.gate = null;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const { userId } = ws.deserializeAttachment() as Attachment;
    const meta = this.meta;
    if (!meta || typeof raw !== "string" || raw.length > 8000) return;
    let msg: { type?: string; clientId?: string; text?: string; before?: number };
    try { msg = JSON.parse(raw); } catch { return; }
    const reply = (payload: unknown) => { try { ws.send(JSON.stringify(payload)); } catch { /* gone */ } };

    if (msg.type === "history") return reply({ type: "history", messages: await this.history(userId, Number(msg.before) || Date.now()) });
    if (msg.type === "typing") {
      for (const peer of this.ctx.getWebSockets(this.other(meta, userId))) { try { peer.send('{"type":"typing"}'); } catch { /* gone */ } }
      return;
    }
    if (msg.type === "read") {
      await this.env.USER_HUB.get(this.env.USER_HUB.idFromName(userId)).clear(meta.conversationId);
      return;
    }
    if (msg.type !== "send") return;

    const text = (msg.text ?? "").trim();
    const reject = (code: string, notice: string) => reply({ type: "rejected", clientId: msg.clientId, code, notice });
    if (!text || text.length > MAX_LEN) return reject("bad_length", `Messages can be up to ${MAX_LEN} characters.`);

    const now = Date.now();
    // Checked and recorded before the first await: other messages can be handled while this one waits on the database.
    // The SQL count covers the case where the object was evicted and the in-memory window was lost.
    const [recent] = this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM messages WHERE sender = ? AND at > ?", userId, now - RATE.windowMs).toArray();
    const window = (this.attempts.get(userId) ?? []).filter((t) => t > now - RATE.windowMs);
    if (Math.max(recent?.n ?? 0, window.length) >= RATE.limit) return reject("rate_limited", "You are sending messages very quickly. Give it a few seconds.");
    window.push(now);
    this.attempts.set(userId, window);

    // Standing is checked against the database on every message, so a ban, block or freeze bites immediately.
    const db = makeDb(this.env.DB);
    const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, meta.conversationId));
    const [sender] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    if (!conv || conv.status !== "open") return reject("conversation_closed", "This conversation is closed.");
    if (!sender || sender.status !== "active") { reject("account", "Your account cannot send messages right now."); return ws.close(4001, "standing"); }
    if (sender.restrictedUntil && sender.restrictedUntil > now) return reject("restricted", "Messaging is paused on your account. See Settings for details and how to appeal.");
    const otherId = this.other(meta, userId);
    if (await isBlockedEitherWay(db, userId, otherId)) return reject("conversation_closed", "This conversation is closed.");

    const result = runMessagePipeline(text, await this.shieldContext(meta, now));
    if (!result.allowed) {
      await addRisk(db, userId, 3, `contact shield: ${result.blockedFor.join(",")}`, now);
      return reject("shield", result.notice!);
    }

    const stored: StoredMessage = { id: newId("msg"), sender: userId, kind: "text", body: text, photo_id: null, explicit: 0, at: now };
    this.ctx.storage.sql.exec("INSERT INTO messages (id, sender, kind, body, photo_id, explicit, at) VALUES (?, ?, 'text', ?, NULL, 0, ?)", stored.id, userId, text, now);
    reply({ type: "sent", clientId: msg.clientId, id: stored.id, at: now });
    await this.broadcast(stored);
    await this.afterDelivery(meta, stored, otherId, result.flags);
  }

  /** Archive copy + scan queue + offline delivery (spec 6: message pipeline, offline delivery). */
  private async afterDelivery(meta: Meta, m: StoredMessage, recipientId: string, flags: string[]) {
    await makeDb(this.env.DB).update(schema.conversations).set({ lastMessageAt: m.at }).where(eq(schema.conversations.id, meta.conversationId));
    await dispatch(this.env, { kind: "archive_message", id: m.id, conversationId: meta.conversationId, senderId: m.sender, recipientId, kind2: m.kind === "image" ? "image" : "text", body: m.body, photoId: m.photo_id ?? undefined, flags, at: m.at });
    if (this.ctx.getWebSockets(recipientId).length === 0) {
      const { live } = await this.env.USER_HUB.get(this.env.USER_HUB.idFromName(recipientId)).bump(meta.conversationId);
      // No live socket anywhere: hand over to the notify queue for a push or email with no message content.
      if (!live) await dispatch(this.env, { kind: "notify", userId: recipientId, reason: "message" });
    }
  }

  /** Called by the scan queue once an uploaded chat image has passed scanning. Images are never delivered before that. */
  async postImage(senderId: string, photoId: string, explicit: boolean): Promise<boolean> {
    const meta = this.meta;
    if (!meta || (senderId !== meta.userA && senderId !== meta.userB)) return false;
    const stored: StoredMessage = { id: newId("msg"), sender: senderId, kind: "image", body: "", photo_id: photoId, explicit: explicit ? 1 : 0, at: Date.now() };
    this.ctx.storage.sql.exec("INSERT INTO messages (id, sender, kind, body, photo_id, explicit, at) VALUES (?, ?, 'image', '', ?, ?, ?)", stored.id, senderId, photoId, stored.explicit, stored.at);
    await this.broadcast(stored);
    await this.afterDelivery(meta, stored, this.other(meta, senderId), []);
    return true;
  }

  /** A neutral line in the thread: a date proposed, accepted, a swap agreed. */
  async systemMessage(text: string): Promise<void> {
    const stored: StoredMessage = { id: newId("msg"), sender: "system", kind: "system", body: text, photo_id: null, explicit: 0, at: Date.now() };
    this.ctx.storage.sql.exec("INSERT INTO messages (id, sender, kind, body, photo_id, explicit, at) VALUES (?, 'system', 'system', ?, NULL, 0, ?)", stored.id, text, stored.at);
    this.gate = null;
    await this.broadcast(stored);
  }

  /** Tell a sender their image was not delivered (failed scan, or the receiver has not opted in to explicit images). */
  notifySender(senderId: string, notice: string): void {
    for (const ws of this.ctx.getWebSockets(senderId)) { try { ws.send(JSON.stringify({ type: "rejected", code: "image", notice })); } catch { /* gone */ } }
  }

  /** Ban, suspension, block or deletion: tell both sides and close the sockets at once (spec 6). */
  freeze(reason: string): void {
    this.gate = null;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify({ type: "closed", reason })); ws.close(4002, reason); } catch { /* gone */ }
    }
  }

  /** Erasure: remove everything this member sent from the conversation's storage. */
  purgeSender(userId: string): number {
    return this.ctx.storage.sql.exec("DELETE FROM messages WHERE sender = ?", userId).rowsWritten;
  }

  /** Read-only view for a moderator working an open report. The caller writes the audit entry. */
  transcript(limit = 200): { id: string; senderId: string; kind: string; text: string; at: number }[] {
    return this.ctx.storage.sql.exec<StoredMessage>("SELECT * FROM messages ORDER BY at DESC LIMIT ?", limit).toArray().reverse().map((m) => ({ id: m.id, senderId: m.sender, kind: m.kind, text: m.body, at: m.at }));
  }

  webSocketClose(ws: WebSocket): void {
    try { ws.close(); } catch { /* noop */ }
  }
}
