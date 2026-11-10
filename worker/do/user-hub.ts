import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export type HubEvent =
  | { type: "unread"; conversationId: string; count: number }
  | { type: "notification"; reason: string }
  | { type: "standing"; status: string };

/**
 * One per member (spec 6). Holds a WebSocket for each of the member's tabs and devices and fans events out to all
 * of them: unread counts, new matches, moderation notices. Presence is simply "has at least one live socket".
 * Uses the Hibernation API, so an idle member costs nothing.
 */
export class UserHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS unread (conversation_id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "hello", ...this.snapshot() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private fanOut(event: HubEvent): number {
    const sockets = this.ctx.getWebSockets();
    const text = JSON.stringify(event);
    for (const ws of sockets) {
      try { ws.send(text); } catch { /* socket already gone */ }
    }
    return sockets.length;
  }

  snapshot(): { unread: Record<string, number> } {
    const unread: Record<string, number> = {};
    for (const row of this.ctx.storage.sql.exec<{ conversation_id: string; n: number }>("SELECT conversation_id, n FROM unread")) unread[row.conversation_id] = row.n;
    return { unread };
  }

  isOnline(): boolean {
    return this.ctx.getWebSockets().length > 0;
  }

  /** A message arrived in a conversation the member is not looking at. Returns whether anything was delivered live. */
  bump(conversationId: string): { live: boolean } {
    const [row] = this.ctx.storage.sql.exec<{ n: number }>("INSERT INTO unread (conversation_id, n) VALUES (?, 1) ON CONFLICT(conversation_id) DO UPDATE SET n = n + 1 RETURNING n", conversationId).toArray();
    return { live: this.fanOut({ type: "unread", conversationId, count: row?.n ?? 1 }) > 0 };
  }

  clear(conversationId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM unread WHERE conversation_id = ?", conversationId);
    this.fanOut({ type: "unread", conversationId, count: 0 });
  }

  push(event: HubEvent): { live: boolean } {
    return { live: this.fanOut(event) > 0 };
  }

  /** Moderation or account deletion: drop every connection at once (spec 6: "closes sockets at once"). */
  closeAll(reason: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(4001, reason); } catch { /* already closed */ }
    }
  }

  webSocketMessage(): void { /* the hub is server-to-client only */ }
  webSocketClose(ws: WebSocket): void {
    try { ws.close(); } catch { /* noop */ }
  }
}
