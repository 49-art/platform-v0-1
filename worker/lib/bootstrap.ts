/**
 * First-use setup for a deployment that was made with no dashboard steps (decisions D-020, D-021).
 *
 * 1. Database: applies any migration in worker/generated/migrations.ts that is not yet recorded. It records them in
 *    the same `d1_migrations` table that `wrangler d1 migrations apply` uses, so either route can be used later.
 * 2. Secrets: if APP_SECRET / INTERNAL_SECRET / PROVIDER_WEBHOOK_SECRET are not set as Cloudflare secrets, a random
 *    value is generated once and kept in the `app_config` table. A secret set in Cloudflare always wins.
 *    Keeping the key next to the data weakens field encryption, so this is a SAMPLE convenience only: set real
 *    secrets in Cloudflare before any real member data is stored (README, "Before real launch").
 */
import { randomToken } from "../../core";
import type { Env } from "../env";
import { MIGRATIONS } from "../generated/migrations";

const SECRET_KEYS = ["APP_SECRET", "INTERNAL_SECRET", "PROVIDER_WEBHOOK_SECRET"] as const;
type SecretKey = (typeof SECRET_KEYS)[number];

let ready: Promise<Record<SecretKey, string>> | null = null;

async function migrate(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
  const applied = new Set((await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>()).results.map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    try {
      // One batch per migration: D1 runs a batch as a single transaction, so a migration lands whole or not at all.
      await db.batch([...m.statements.map((s) => db.prepare(s)), db.prepare("INSERT INTO d1_migrations (name) VALUES (?1)").bind(m.name)]);
    } catch (err) {
      // Another isolate may have applied it a moment ago. Only rethrow if it is still missing.
      const again = await db.prepare("SELECT 1 AS x FROM d1_migrations WHERE name = ?1").bind(m.name).first();
      if (!again) throw err;
    }
  }
}

async function loadSecrets(env: Env): Promise<Record<SecretKey, string>> {
  const out = {} as Record<SecretKey, string>;
  for (const key of SECRET_KEYS) {
    const fromEnv = (env as unknown as Record<string, string | undefined>)[key];
    if (fromEnv) { out[key] = fromEnv; continue; }
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key = ?1").bind(key).first<{ value: string }>();
    if (row) { out[key] = row.value; continue; }
    await env.DB.prepare("INSERT OR IGNORE INTO app_config (key, value, created_at) VALUES (?1, ?2, ?3)").bind(key, randomToken(32), Date.now()).run();
    // Read back rather than trust our own value: if two isolates raced, both must use the one that was stored.
    out[key] = (await env.DB.prepare("SELECT value FROM app_config WHERE key = ?1").bind(key).first<{ value: string }>())!.value;
  }
  return out;
}

/** Call at the top of every entry point (fetch, scheduled, queue, and each Durable Object). Cheap after the first call. */
export async function ensureReady(env: Env): Promise<void> {
  ready ??= (async () => {
    await migrate(env.DB);
    return loadSecrets(env);
  })().catch((err) => {
    ready = null; // try again on the next request rather than staying broken
    throw err;
  });
  const secrets = await ready;
  const target = env as unknown as Record<string, string | undefined>;
  for (const key of SECRET_KEYS) if (!target[key]) target[key] = secrets[key];
}

/** Whether this deployment is running on generated secrets (shown to admins as a launch blocker). */
export async function usingGeneratedSecrets(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM app_config WHERE key = 'APP_SECRET'").first<{ value: string }>();
  return !!row && row.value === env.APP_SECRET;
}
