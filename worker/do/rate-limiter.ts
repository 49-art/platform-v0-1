import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/**
 * One object per limited key (for example "login:<ip hash>"). Sliding-window approximation over two fixed
 * windows, held in the object's SQLite storage so limits survive eviction (spec 11: rate limits on Durable Objects).
 */
export class RateLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (bucket INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  }

  hit(limit: number, windowMs: number, now = Date.now()): { allowed: boolean; remaining: number; retryAfterS: number } {
    const sql = this.ctx.storage.sql;
    const bucket = Math.floor(now / windowMs);
    const rows = sql.exec<{ bucket: number; n: number }>("SELECT bucket, n FROM hits WHERE bucket >= ?", bucket - 1).toArray();
    const current = rows.find((r) => r.bucket === bucket)?.n ?? 0;
    const previous = rows.find((r) => r.bucket === bucket - 1)?.n ?? 0;
    const elapsed = (now % windowMs) / windowMs;
    const estimate = previous * (1 - elapsed) + current;
    if (estimate >= limit) return { allowed: false, remaining: 0, retryAfterS: Math.max(1, Math.ceil(((1 - elapsed) * windowMs) / 1000)) };
    sql.exec("INSERT INTO hits (bucket, n) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET n = n + 1", bucket);
    sql.exec("DELETE FROM hits WHERE bucket < ?", bucket - 1);
    return { allowed: true, remaining: Math.max(0, Math.floor(limit - estimate - 1)), retryAfterS: 0 };
  }

  reset(): void {
    this.ctx.storage.sql.exec("DELETE FROM hits");
  }
}
