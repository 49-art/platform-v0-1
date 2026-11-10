import type { CoreEnv, DB, schema } from "../core";
import type { ChatRoom } from "./do/chat-room";
import type { DateTimer } from "./do/date-timer";
import type { RateLimiter } from "./do/rate-limiter";
import type { UserHub } from "./do/user-hub";

export interface Env extends CoreEnv {
  ASSETS: Fetcher;
  /** Optional on the free plan (D-015): without an R2 bucket, media lives in the D1 media_blobs table via lib/media.ts. */
  MEDIA?: R2Bucket;
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
  USER_HUB: DurableObjectNamespace<UserHub>;
  DATE_TIMER: DurableObjectNamespace<DateTimer>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  /** Optional on the free plan (D-014): when a queue binding is absent, jobs run inline via lib/dispatch.ts. */
  Q_SCAN?: Queue<Job>;
  Q_NOTIFY?: Queue<Job>;
  Q_MAINT?: Queue<Job>;
  APP_NAME: string;
  ADMIN_ORIGIN: string;
  TURNSTILE_SITE_KEY: string;
  INTERNAL_SECRET: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  PREMOD_SLA_HOURS?: string;
  /** "argon2id" (default) or "pbkdf2" for Workers Free (D-016). */
  PASSWORD_ALGO?: string;
  /** Sample mode (D-017): "1" makes the first member to confirm their email the admin and surfaces emailed links in-app. */
  SAMPLE_MODE?: string;
  /** Test-only: cheaper Argon2 parameters so the suite stays fast. Ignored in production. */
  TEST_FAST_HASH?: string;
}

export type Job =
  | { kind: "scan_photo"; photoId: string }
  | { kind: "archive_message"; id: string; conversationId: string; senderId: string; recipientId: string; kind2: "text" | "image"; body: string; photoId?: string; flags: string[]; at: number }
  | { kind: "notify"; userId: string; notificationId?: string; reason: string }
  | { kind: "purge_user_chat"; userId: string; conversationId: string };

export type User = typeof schema.users.$inferSelect;
export type Session = typeof schema.sessions.$inferSelect;

export interface Vars {
  db: DB;
  user: User | null;
  session: Session | null;
  ip: string;
  now: number;
}
export type AppEnv = { Bindings: Env; Variables: Vars };
