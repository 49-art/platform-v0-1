/**
 * The one Worker (spec 11 "Runtime: Cloudflare Workers").
 * /api/*, /media/* and /internal/* run here; every other path is the installable app, served from static assets.
 */
import { api, isApiPath } from "./api";
import type { Env, Job } from "./env";
import { handleQueue, handleScheduled } from "./jobs";
import { ensureReady } from "./lib/bootstrap";

export { ChatRoom } from "./do/chat-room";
export { DateTimer } from "./do/date-timer";
export { RateLimiter } from "./do/rate-limiter";
export { UserHub } from "./do/user-hub";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (!isApiPath(pathname)) return env.ASSETS.fetch(request);
    await ensureReady(env);
    if (pathname === "/api/health") {
      // Proves the whole stack: the Worker runs, D1 answers and the schema is in place.
      await env.DB.prepare("SELECT COUNT(*) FROM taxonomy").first();
      return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    }
    return api.fetch(request, env, ctx);
  },
  async queue(batch, env) {
    await ensureReady(env);
    return handleQueue(batch as MessageBatch<Job>, env);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(ensureReady(env).then(() => handleScheduled(env)));
  },
} satisfies ExportedHandler<Env>;
