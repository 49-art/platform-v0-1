import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, vi } from "vitest";
import type { Job } from "../worker/env";

declare global {
  namespace Cloudflare {
    interface Env { TEST_MIGRATIONS: import("cloudflare:test").D1Migration[] }
  }
}

/** Every job the app enqueues during a test. Tests drain this with `runJobs()` so async work is deterministic. */
export const jobs: Job[] = [];

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as any).TEST_MIGRATIONS);
  for (const q of ["Q_SCAN", "Q_NOTIFY", "Q_MAINT"] as const) {
    vi.spyOn(env[q]!, "send").mockImplementation(async (job: Job) => { jobs.push(job); return {} as QueueSendResponse; });
  }
});

beforeEach(() => {
  // Outbound HTTP is never real in tests. Turnstile passes only for the token "human".
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("challenges.cloudflare.com/turnstile")) {
      const form = init?.body as FormData;
      return Response.json({ success: form.get("response") === "human" });
    }
    throw new Error(`Unexpected outbound request in test: ${url}`);
  });
});
